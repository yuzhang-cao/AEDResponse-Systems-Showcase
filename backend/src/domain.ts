import { createHash } from "node:crypto";
import type {
  Aed,
  AssignmentRole,
  AssignmentStatus,
  PatientPosition,
  ResponderPosition
} from "./contracts.js";
import type { AedRoute } from "./models.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function distanceMeters(
  left: Pick<PatientPosition | ResponderPosition, "latitude" | "longitude">,
  right: Pick<PatientPosition | ResponderPosition, "latitude" | "longitude">
): number {
  const earthRadius = 6_371_008.8;
  const latitudeDelta = (right.latitude - left.latitude) * Math.PI / 180;
  const longitudeDelta = (right.longitude - left.longitude) * Math.PI / 180;
  const firstLatitude = left.latitude * Math.PI / 180;
  const secondLatitude = right.latitude * Math.PI / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function planAssignments(acceptedCount: number): {
  acceptedCount: number;
  patientCount: number;
  aedCount: number;
} {
  if (!Number.isInteger(acceptedCount) || acceptedCount < 0) {
    throw new RangeError("acceptedCount must be a non-negative integer");
  }
  const aedCount = Math.floor(acceptedCount / 3 + 0.5);
  return {
    acceptedCount,
    patientCount: acceptedCount - aedCount,
    aedCount
  };
}

function minuteOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

export function isAedOpen(aed: Aed, at: Date): boolean {
  const start = minuteOfDay(aed.openFrom);
  const end = minuteOfDay(aed.openUntil);
  if (start === undefined || end === undefined) return false;
  if (start === end) return true;
  const current = at.getHours() * 60 + at.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function makeAedRoute(
  responder: ResponderPosition,
  patient: PatientPosition,
  aed: Aed
): AedRoute {
  const meters = distanceMeters(responder, aed.aedPosition)
    + distanceMeters(aed.aedPosition, patient);
  const walkingSeconds = Math.ceil(1.25 * meters / 1.3);
  const overheadSeconds = Math.max(0, aed.floorTransferSeconds)
    + Math.max(0, aed.accessDelaySeconds)
    + Math.max(0, aed.verificationSeconds);
  return {
    aedId: aed.id,
    path: [responder, aed.aedPosition, patient],
    etaSeconds: walkingSeconds + overheadSeconds,
    walkingSeconds,
    overheadSeconds
  };
}

export function bestAedRoute(
  responder: ResponderPosition,
  patient: PatientPosition,
  aeds: Aed[],
  unavailableAedIds: ReadonlySet<string>,
  at: Date
): AedRoute | undefined {
  return eligibleAedRoutes(responder, patient, aeds, unavailableAedIds, at)[0];
}

export function eligibleAedRoutes(
  responder: ResponderPosition,
  patient: PatientPosition,
  aeds: Aed[],
  unavailableAedIds: ReadonlySet<string>,
  at: Date
): AedRoute[] {
  return aeds
    .filter((aed) => aed.available && !unavailableAedIds.has(aed.id) && isAedOpen(aed, at))
    .map((aed) => makeAedRoute(responder, patient, aed))
    .sort((left, right) => left.etaSeconds - right.etaSeconds
      || left.aedId.localeCompare(right.aedId));
}

export function assignmentTransitionAllowed(
  role: AssignmentRole,
  current: AssignmentStatus,
  next: AssignmentStatus
): boolean {
  if (current === next) return true;
  if (role === "GO_TO_PATIENT") {
    return (current === "ASSIGNED" && next === "EN_ROUTE")
      || (current === "EN_ROUTE" && next === "ARRIVED_AT_PATIENT")
      || (current === "ARRIVED_AT_PATIENT" && next === "COMPLETED");
  }
  return (current === "ASSIGNED" && next === "EN_ROUTE")
    || (current === "EN_ROUTE" && next === "ARRIVED_AT_AED")
    || (current === "AED_ACQUIRED" && next === "EN_ROUTE_TO_PATIENT")
    || (current === "EN_ROUTE_TO_PATIENT" && next === "ARRIVED_AT_PATIENT")
    || (current === "ARRIVED_AT_PATIENT" && next === "COMPLETED");
}

export function isTerminalAssignmentStatus(status: AssignmentStatus): boolean {
  return ["COMPLETED", "AED_UNAVAILABLE", "TIMED_OUT", "CANCELLED"].includes(status);
}

/** Stable identity of a device: its user once bound, otherwise the device itself. */
export function deviceIdentityKey(
  device: Pick<{ deviceInstanceId: string; userId?: string }, "deviceInstanceId" | "userId">
): string {
  return device.userId ? `user:${device.userId}` : `device:${device.deviceInstanceId}`;
}

/** Whether an assignment status removes the device from participation. */
export function assignmentExitsParticipation(status: AssignmentStatus): boolean {
  return status === "TIMED_OUT" || status === "CANCELLED";
}
