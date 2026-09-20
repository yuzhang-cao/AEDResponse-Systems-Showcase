import {
  bestAedRoute,
  eligibleAedRoutes,
  makeAedRoute
} from "./domain.js";
import type {
  Aed,
  PatientPosition,
  ResponderPosition
} from "./contracts.js";
import type { AedRoute } from "./models.js";

/**
 * The route provider is the only boundary allowed to choose an AED route.
 * Today the reference implementation is deterministic and in-process.  A
 * network/map provider can replace it later without making the service or an
 * assignment use a second route algorithm.
 */
export type RouteProviderFailureReason =
  | "NO_AVAILABLE_ROUTE"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_INPUT";

export type RouteProviderResult<T> =
  | { kind: "AVAILABLE"; value: T }
  | { kind: "UNAVAILABLE"; reason: RouteProviderFailureReason };

export interface AedRouteProvider {
  isPrepared?(input: Parameters<AedRouteProvider["eligibleRoutes"]>[0]): boolean;
  prepare?(input: Parameters<AedRouteProvider["eligibleRoutes"]>[0]): Promise<void>;
  bestRoute(input: {
    responder: ResponderPosition;
    patient: PatientPosition;
    aeds: readonly Aed[];
    unavailableAedIds: ReadonlySet<string>;
    at: Date;
  }): RouteProviderResult<AedRoute>;
  eligibleRoutes(input: {
    responder: ResponderPosition;
    patient: PatientPosition;
    aeds: readonly Aed[];
    unavailableAedIds: ReadonlySet<string>;
    at: Date;
  }): RouteProviderResult<readonly AedRoute[]>;
  refreshRoute(input: {
    responder: ResponderPosition;
    patient: PatientPosition;
    aed: Aed;
    at: Date;
  }): RouteProviderResult<AedRoute>;
}

function hasFinitePosition(position: ResponderPosition | PatientPosition): boolean {
  return Number.isFinite(position.latitude)
    && Number.isFinite(position.longitude)
    && position.latitude >= -90
    && position.latitude <= 90
    && position.longitude >= -180
    && position.longitude <= 180;
}

function validInput(
  responder: ResponderPosition,
  patient: PatientPosition,
  at: Date
): boolean {
  return hasFinitePosition(responder)
    && hasFinitePosition(patient)
    && Number.isFinite(at.getTime());
}

/** Stable local implementation retained while a real route service is not configured. */
export class ReferenceAedRouteProvider implements AedRouteProvider {
  bestRoute(input: Parameters<AedRouteProvider["bestRoute"]>[0]): RouteProviderResult<AedRoute> {
    if (!validInput(input.responder, input.patient, input.at)) {
      return { kind: "UNAVAILABLE", reason: "INVALID_INPUT" };
    }
    const route = bestAedRoute(
      input.responder,
      input.patient,
      [...input.aeds],
      input.unavailableAedIds,
      input.at
    );
    return route
      ? { kind: "AVAILABLE", value: route }
      : { kind: "UNAVAILABLE", reason: "NO_AVAILABLE_ROUTE" };
  }

  eligibleRoutes(
    input: Parameters<AedRouteProvider["eligibleRoutes"]>[0]
  ): RouteProviderResult<readonly AedRoute[]> {
    if (!validInput(input.responder, input.patient, input.at)) {
      return { kind: "UNAVAILABLE", reason: "INVALID_INPUT" };
    }
    return {
      kind: "AVAILABLE",
      value: eligibleAedRoutes(
        input.responder,
        input.patient,
        [...input.aeds],
        input.unavailableAedIds,
        input.at
      )
    };
  }

  refreshRoute(
    input: Parameters<AedRouteProvider["refreshRoute"]>[0]
  ): RouteProviderResult<AedRoute> {
    if (!validInput(input.responder, input.patient, input.at)) {
      return { kind: "UNAVAILABLE", reason: "INVALID_INPUT" };
    }
    return {
      kind: "AVAILABLE",
      value: makeAedRoute(input.responder, input.patient, input.aed)
    };
  }
}
