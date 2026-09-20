import { stateRows } from "./incremental-state.js";
import type { PersistentState } from "./models.js";

export function stopAccountCollection(state: PersistentState, userId: string, at: string, cause: "LOGOUT" | "CLOSED" = "LOGOUT"): void {
  for (const device of stateRows(state, "devices", "userId", userId)) {
    device.availableForResponse = false;
    device.loginState = "SIGNED_OUT";
    device.presenceObservedAt = at;
    device.lastSeenAt = at;
    if (device.deviceKind === "WATCH") device.companionLinkRevokedAt = at;
    // A signed-out installation must stop receiving this account's alerts: the
    // next user of the same phone would otherwise get someone else's emergency
    // notifications.  `pushRegistrationFor` already refuses a SIGNED_OUT device,
    // and this removes the credential outright.
    delete device.pushRegistration;
  }
  for (const session of stateRows(state, "sessionsByTokenHash", "userId", userId)) {
    session.revokedAt ??= at;
    if (cause === "LOGOUT") session.logoutCompletedAt ??= at;
    if (session.refreshTokenHash) session.refreshRevokedAt ??= at;
  }
  for (const ticket of stateRows(state, "companionLinkTicketsByHash", "userId", userId)) ticket.revokedAt ??= at;
}
