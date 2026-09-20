import { z } from "zod";

export const simulationMarkerSchema = z.object({
  runId: z.string().uuid(), label: z.literal("SIMULATED_TEST")
}).strict();
export type SimulationMarker = z.infer<typeof simulationMarkerSchema>;

export function simulationMarker(observation: { observationKind: string }) {
  if (observation.observationKind !== "SIMULATED_TEST") return {};
  const input = simulationObservationSchema.parse(observation);
  return { simulation: { runId: input.runId, label: "SIMULATED_TEST" as const } };
}

// Administrative test input only: deliberately incompatible with Fall observations.
export const simulationObservationSchema = z.object({
  observationKind: z.literal("SIMULATED_TEST"),
  runId: z.string().uuid(),
  requestedAt: z.string().datetime(),
  patientUserId: z.string().uuid(),
  patientDeviceId: z.string().uuid(),
  responderUserId: z.string().uuid(),
  responderDeviceId: z.string().uuid()
}).strict().refine(value => value.patientUserId !== value.responderUserId
  && value.patientDeviceId !== value.responderDeviceId, "Two independent test identities are required");

export type SimulationObservation = z.infer<typeof simulationObservationSchema> & {
  fallDetectedAt?: never;
  fallResolution?: never;
  appHelpResponse?: never;
  callFirstObservedAt?: never;
  patientPosition?: never;
  locationUnavailableReason?: never;
};

export function permitsSimulationDevice(
  observation: { observationKind: string },
  deviceId: string, userId?: string
): boolean {
  if (observation.observationKind !== "SIMULATED_TEST") return true;
  const input = simulationObservationSchema.parse(observation);
  return (deviceId === input.patientDeviceId && userId === input.patientUserId)
    || (deviceId === input.responderDeviceId && userId === input.responderUserId);
}
