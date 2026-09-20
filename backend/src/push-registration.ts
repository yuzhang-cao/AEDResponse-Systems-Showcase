/**
 * Push token lifecycle for one installation.
 *
 * A token is issued by APNs to an app+bundle on a device, and it changes without
 * warning: reinstalling, restoring a backup to another phone, or Apple rotating
 * it all produce a new one.  So the rules here are deliberately unforgiving:
 *
 *   - registration is a REPLACEMENT for the calling device, never a new row, so
 *     a stale token cannot keep receiving another installation's wake-ups;
 *   - one token addresses one installation, so registering a token that is
 *     already bound to a different device unbinds it there (the old device stops
 *     receiving push, which is the safe direction);
 *   - sign-out and account close clear the registration, because the next user of
 *     the same phone must not receive the previous user's alerts;
 *   - a token APNs reports as invalid is forgotten immediately instead of being
 *     retried forever.
 */
import type { DeviceRecord, PersistentState, PushRegistrationRecord } from "./models.js";
import { badRequest, forbidden, unprocessableEntity } from "./errors.js";

export interface PushRegistrationInput {
  /** Opaque APNs token, hex.  Lower-cased on the way in so binding is stable. */
  token: string;
  environment: PushRegistrationRecord["environment"];
  bundleId: string;
  registeredAt: string;
}

/** APNs tokens are hex and long; anything else would fail on every send. */
export function normalizePushToken(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("pushToken must be a string");
  const token = raw.trim().toLowerCase();
  if (token.length < 32 || token.length > 512 || !/^[0-9a-f]+$/.test(token)) {
    throw badRequest("pushToken must be an APNs hex token");
  }
  return token;
}

export function normalizePushEnvironment(raw: unknown): PushRegistrationRecord["environment"] {
  if (raw !== "SANDBOX" && raw !== "PRODUCTION") {
    throw badRequest("pushEnvironment must be SANDBOX or PRODUCTION");
  }
  return raw;
}

/** Registers or replaces the push token of one iPhone. */
export function registerPushToken(
  state: PersistentState,
  deviceInstanceId: string,
  input: PushRegistrationInput
): PushRegistrationRecord {
  const device = state.devices[deviceInstanceId];
  if (!device) throw forbidden("Device session is no longer registered");
  if (device.deviceKind !== "IPHONE") {
    throw unprocessableEntity("System push registration is only available to an iPhone");
  }
  if (!device.userId || !device.accountId) {
    throw forbidden("Push registration requires an account-bound device session");
  }

  // One token, one installation: drop any other device that still claims it.
  for (const other of Object.values(state.devices)) {
    if (other.deviceInstanceId === deviceInstanceId) continue;
    if (other.pushRegistration?.token !== input.token) continue;
    delete other.pushRegistration;
  }

  const previous = device.pushRegistration;
  const registration: PushRegistrationRecord = {
    token: input.token,
    environment: input.environment,
    bundleId: input.bundleId,
    registeredAt: previous?.token === input.token ? previous.registeredAt : input.registeredAt,
    updatedAt: input.registeredAt
  };
  device.pushRegistration = registration;
  return registration;
}

/** Removes the registration of this device.  Idempotent. */
export function unregisterPushToken(state: PersistentState, deviceInstanceId: string): boolean {
  const device = state.devices[deviceInstanceId];
  if (!device?.pushRegistration) return false;
  delete device.pushRegistration;
  return true;
}

/**
 * Forgets a token APNs rejected.
 *
 * Only the device that currently holds exactly this token is cleared, so a late
 * rejection cannot unbind a token that has already been rotated to a newer one.
 */
export function forgetInvalidPushToken(state: PersistentState, token: string): string | undefined {
  for (const device of Object.values(state.devices)) {
    if (device.pushRegistration?.token !== token) continue;
    delete device.pushRegistration;
    return device.deviceInstanceId;
  }
  return undefined;
}

/** Clears registrations for every device of one account.  Used on account close. */
export function clearAccountPushRegistrations(
  state: PersistentState,
  accountId: string
): string[] {
  const cleared: string[] = [];
  for (const device of Object.values(state.devices)) {
    if (device.accountId !== accountId || !device.pushRegistration) continue;
    delete device.pushRegistration;
    cleared.push(device.deviceInstanceId);
  }
  return cleared;
}

/** The registration that will be used to push to this device, if any. */
export function pushRegistrationFor(
  device: DeviceRecord | undefined
): PushRegistrationRecord | undefined {
  if (!device || device.deviceKind !== "IPHONE") return undefined;
  if (device.loginState === "SIGNED_OUT") return undefined;
  return device.pushRegistration;
}
