import type { DeletionRequestRecord } from "./models.js";
import { stopAccountCollection } from "./account-lifecycle.js";
import { transactState } from "./incremental-state.js";
import { timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "./config.js";
import { tokenHash } from "./domain.js";
import { forbidden, unauthorized } from "./errors.js";
import { readEntities, createStateReadView, type StateReadView } from "./state-read.js";
import type { StateStore } from "./store.js";

export interface DevicePrincipal {
  kind: "DEVICE";
  tokenHash: string;
  sessionId: string;
  userId?: string;
  accountId?: string;
  deviceInstanceId: string;
  deviceKind: "IPHONE" | "WATCH";
  companionPairId: string;
  scopes: string[];
  expiresAt: string;
}

export interface AccountPrincipal {
  kind: "ACCOUNT";
  tokenHash: string;
  sessionId: string;
  userId: string;
  accountId: string;
  scopes: string[];
  expiresAt: string;
}

export interface OperatorPrincipal {
  kind: "OPERATOR";
}

export type Principal = DevicePrincipal | AccountPrincipal | OperatorPrincipal;

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export type AccountClosureReceipt = Pick<DeletionRequestRecord, "requestId" | "status" | "requestedAt" | "erasureStartedAt">;
function closureReceipt(record: DeletionRequestRecord): AccountClosureReceipt {
  return { requestId: record.requestId, status: record.status, requestedAt: record.requestedAt, erasureStartedAt: record.erasureStartedAt };
}

export class IdentityAccess {
  private readonly revocationListeners = new Set<() => void>();

  constructor(
    private readonly store: StateStore,
    private readonly config: BackendConfig,
    private readonly now: () => Date
  ) {}

  onRevocation(listener: () => void): () => void {
    this.revocationListeners.add(listener);
    return () => { this.revocationListeners.delete(listener); };
  }

  /** One committed snapshot per publication, regardless of connection count. */
  currentDeviceConnectionIds(principals: ReadonlyMap<string, DevicePrincipal>): Set<string> {
    return readEntities(this.store, state => {
      const authorized = new Set<string>();
      for (const [connectionId, expected] of principals) {
        try {
          const current = this.principalForHash(state, expected.tokenHash);
          if (current.kind === "DEVICE" && current.deviceKind === "IPHONE"
            && current.sessionId === expected.sessionId
            && current.deviceInstanceId === expected.deviceInstanceId
            && current.userId === expected.userId && current.accountId === expected.accountId
            && current.companionPairId === expected.companionPairId
            && current.scopes.includes("events:read")) authorized.add(connectionId);
        } catch { /* Revoked, expired or rebound sessions fail closed. */ }
      }
      return authorized;
    });
  }

  authenticateToken(rawToken: string): Principal {
    if (this.config.operatorToken && safeTokenEqual(rawToken, this.config.operatorToken)) {
      return { kind: "OPERATOR" };
    }
    return readEntities(this.store, state => this.principalForHash(state, tokenHash(rawToken)));
  }

  /**
   * Revalidates a principal captured before an asynchronous or internal
   * operation.  HTTP handlers normally authenticate every request, but
   * replay entry points can also be called from a committed-session
   * callback.  Those paths must not continue using a stale principal after
   * logout, expiry, scope change, or device rebinding.
   */
  assertCurrent(principal: Principal): void {
    if (principal.kind === "OPERATOR") return;
    const current = readEntities(this.store, state => this.principalForHash(state, principal.tokenHash));
    if (current.kind === "OPERATOR") throw unauthorized("Session is no longer current");
    const sameScopes = current.scopes.length === principal.scopes.length
      && current.scopes.every(scope => principal.scopes.includes(scope));
    const sameBinding = current.kind === principal.kind
      && current.sessionId === principal.sessionId
      && current.expiresAt === principal.expiresAt
      && sameScopes
      && (current.kind !== "DEVICE" || (
        principal.kind === "DEVICE"
        && current.deviceInstanceId === principal.deviceInstanceId
        && current.deviceKind === principal.deviceKind
        && current.companionPairId === principal.companionPairId
        && current.userId === principal.userId
        && current.accountId === principal.accountId
      ))
      && (current.kind !== "ACCOUNT" || (
        principal.kind === "ACCOUNT"
        && current.userId === principal.userId
        && current.accountId === principal.accountId
      ));
    if (!sameBinding) throw unauthorized("Session is no longer current");
  }

  private principalForHash(state: StateReadView, hash: string): Principal {
    const result = (() => {
      const session = state.get("sessionsByTokenHash", hash);
      if (!session || session.revokedAt || Date.parse(session.expiresAt) <= this.now().getTime()) {
        return undefined;
      }
      const user = session.userId ? state.get("users", session.userId) : undefined;
      if (user?.lifecycleState === "CLOSED") return undefined;
      const account = session.accountId ? state.get("accounts", session.accountId) : undefined;
      if (account?.provider === "CONTROLLED_TEST" && !this.config.enableControlledTestAccounts) {
        return undefined;
      }
      const sessionKind = session.sessionKind
        ?? (session.deviceInstanceId !== undefined ? "DEVICE" : "ACCOUNT");
      if (sessionKind === "ACCOUNT") {
        if (!session.userId || !session.accountId) return undefined;
        const user = state.get("users", session.userId);
        const account = state.get("accounts", session.accountId);
        if (!user || !account || account.userId !== user.userId) return undefined;
        return { kind: "ACCOUNT" as const, session, user, account };
      }
      if (!session.deviceInstanceId || !session.deviceKind) return undefined;
      // Device sessions created before account binding are retained only as
      // migration data; they must never authenticate at the business boundary.
      if (!session.userId || !session.accountId) return undefined;
      const device = state.get("devices", session.deviceInstanceId);
      if (!device || device.deviceKind !== session.deviceKind || device.loginState === "SIGNED_OUT") return undefined;
      if (device.deviceKind === "WATCH" && device.companionLinkRevokedAt) return undefined;
      if (!device.userId || !device.accountId
        || device.userId !== session.userId || device.accountId !== session.accountId) {
        return undefined;
      }
      return { kind: "DEVICE" as const, session, device };
    })();
    if (!result) throw unauthorized();
    if (result.kind === "ACCOUNT") {
      return {
        kind: "ACCOUNT",
        tokenHash: hash,
        sessionId: result.session.sessionId,
        userId: result.user.userId,
        accountId: result.account.accountId,
        scopes: [...result.session.scopes],
        expiresAt: result.session.expiresAt
      };
    }
    return {
      kind: "DEVICE",
      tokenHash: hash,
      sessionId: result.session.sessionId,
      userId: result.session.userId!,
      accountId: result.session.accountId!,
      deviceInstanceId: result.device.deviceInstanceId,
      deviceKind: result.device.deviceKind,
      companionPairId: result.device.companionPairId,
      scopes: [...result.session.scopes],
      expiresAt: result.session.expiresAt
    };
  }

  async recoverLogout(principal: Principal, input: {
    priorToken: string; isAccount: boolean; requestedAt: string; deviceInstanceId?: string | undefined;
  }): Promise<void> {
    if (principal.kind !== "ACCOUNT") throw forbidden("Account reauthentication is required");
    const cutoff = Date.parse(input.requestedAt);
    if (!Number.isFinite(cutoff) || cutoff > this.now().getTime()) throw forbidden("Invalid logout boundary");
    const now = this.now().toISOString();
    await this.store.transact(state => {
      const current = this.principalForHash(createStateReadView(state), principal.tokenHash);
      if (current.kind !== "ACCOUNT" || current.userId !== principal.userId || current.accountId !== principal.accountId
        || !current.scopes.includes("session:bootstrap")) {
        throw unauthorized();
      }
      const prior = state.sessionsByTokenHash[tokenHash(input.priorToken)];
      if (prior && (prior.userId !== current.userId || prior.accountId !== current.accountId
        || ((prior.sessionKind ?? (prior.deviceInstanceId ? "DEVICE" : "ACCOUNT")) === "ACCOUNT") !== input.isAccount
        || Date.parse(prior.issuedAt) > cutoff)) throw forbidden("Logout recovery identity mismatch");
      const revoke = (session: typeof prior) => {
        if (!session) return;
        session.revokedAt ??= now;
        if (session.refreshTokenHash) session.refreshRevokedAt ??= now;
      };
      if (input.isAccount) {
        // Family records share refresh expiry. If the original record was
        // cleaned, that expired family cannot be revived by this endpoint.
        if (!prior) return;
        const currentSession = state.sessionsByTokenHash[current.tokenHash]!;
        if (prior.tokenHash === current.tokenHash || (prior.refreshFamilyId
          && prior.refreshFamilyId === currentSession.refreshFamilyId)) {
          throw forbidden("A fresh login family is required for recovery");
        }
        for (const session of Object.values(state.sessionsByTokenHash)) {
          if (session.tokenHash === prior.tokenHash || (prior.refreshFamilyId
            && session.refreshFamilyId === prior.refreshFamilyId)) revoke(session);
        }
        prior.logoutCompletedAt ??= now;
        return;
      }
      const device = input.deviceInstanceId ? state.devices[input.deviceInstanceId] : undefined;
      if (!device || device.deviceKind !== "IPHONE" || device.userId !== current.userId
        || device.accountId !== current.accountId || (prior && prior.deviceInstanceId !== device.deviceInstanceId)) {
        throw forbidden("Original iPhone binding is required for recovery");
      }
      const oldWatchIds = new Set(Object.values(state.devices).filter(watch =>
        watch.deviceKind === "WATCH" && watch.userId === current.userId
        && watch.accountId === current.accountId && watch.companionPairId === device.companionPairId
        && Date.parse(watch.lastBootstrapAt) <= cutoff).map(watch => watch.deviceInstanceId));
      const priorWatchFamilies = new Set(Object.values(state.sessionsByTokenHash).filter(session => {
        const watch = session.deviceInstanceId ? state.devices[session.deviceInstanceId] : undefined;
        return session.deviceKind === "WATCH" && session.userId === current.userId
          && session.accountId === current.accountId && watch?.companionPairId === device.companionPairId
          && Date.parse(session.issuedAt) <= cutoff && session.refreshFamilyId;
      }).map(session => session.refreshFamilyId!));
      for (const ticket of Object.values(state.companionLinkTicketsByHash)) {
        if (ticket.iPhoneDeviceId === device.deviceInstanceId && Date.parse(ticket.issuedAt) <= cutoff) {
          ticket.revokedAt ??= now;
        }
      }
      for (const id of oldWatchIds) state.devices[id]!.companionLinkRevokedAt ??= now;
      for (const session of Object.values(state.sessionsByTokenHash)) {
        if (session.userId !== current.userId || session.accountId !== current.accountId) continue;
        if ((session.deviceInstanceId === device.deviceInstanceId && Date.parse(session.issuedAt) <= cutoff)
          || (session.deviceInstanceId && oldWatchIds.has(session.deviceInstanceId))
          || (session.refreshFamilyId && priorWatchFamilies.has(session.refreshFamilyId))) revoke(session);
      }
      if (prior) prior.logoutCompletedAt ??= now;
    });
    for (const listener of this.revocationListeners) {
      try { listener(); } catch { console.error("Recovery revocation committed; observer failed"); }
    }
  }

  async logoutToken(rawToken: string): Promise<void> {
    const completed = readEntities(this.store, state => {
      const session = state.get("sessionsByTokenHash", tokenHash(rawToken));
      return session?.logoutCompletedAt !== undefined && session.revokedAt !== undefined;
    });
    // This narrow replay path grants no principal or business access.
    if (completed) return;
    await this.logout(this.authenticateToken(rawToken));
  }

  /** Revokes the presented account/device session and outstanding iPhone tickets. */
  async logout(principal: Principal, entireAccount = true): Promise<void> {
    if (principal.kind === "OPERATOR") {
      throw forbidden("Operator credentials do not support product logout");
    }
    const now = this.now().toISOString();
    await this.store.transact((state) => {
      const session = state.sessionsByTokenHash[principal.tokenHash];
      if (entireAccount && principal.userId && (principal.kind === "ACCOUNT" || principal.deviceKind === "IPHONE")) {
        stopAccountCollection(state, principal.userId, now);
      }
      if (session) session.logoutCompletedAt = now;
      if (principal.kind === "ACCOUNT") {
        if (session?.refreshFamilyId) {
          for (const familySession of Object.values(state.sessionsByTokenHash)) {
            if (familySession.refreshFamilyId === session.refreshFamilyId) {
              familySession.revokedAt ??= now;
              if (familySession.refreshTokenHash) familySession.refreshRevokedAt ??= now;
            }
          }
        } else if (session) {
          session.revokedAt ??= now;
          if (session.refreshTokenHash) session.refreshRevokedAt ??= now;
        }
        return;
      }

      if (session) {
        session.revokedAt ??= now;
        if (session.refreshTokenHash) session.refreshRevokedAt ??= now;
      }
      if (principal.deviceKind === "IPHONE") {
        const userId = principal.userId;
        const accountId = principal.accountId;
        const device = state.devices[principal.deviceInstanceId];
        const pairId = device?.companionPairId ?? principal.companionPairId;
        for (const ticket of Object.values(state.companionLinkTicketsByHash)) {
          if (ticket.iPhoneDeviceId === principal.deviceInstanceId
            && !ticket.consumedAt
            && !ticket.revokedAt) {
            ticket.revokedAt = now;
          }
        }
        for (const watch of Object.values(state.devices)) {
          if (watch.deviceKind !== "WATCH"
            || watch.companionPairId !== pairId
            || (userId !== undefined && watch.userId !== userId)
            || (accountId !== undefined && watch.accountId !== accountId)) continue;
          watch.companionLinkRevokedAt = now;
        }
        for (const watchSession of Object.values(state.sessionsByTokenHash)) {
          if (watchSession.deviceKind !== "WATCH"
            || watchSession.deviceInstanceId === undefined
            || watchSession.userId !== userId
            || watchSession.accountId !== accountId) continue;
          const watch = state.devices[watchSession.deviceInstanceId];
          if (watch?.companionPairId !== pairId) continue;
          watchSession.revokedAt ??= now;
          if (watchSession.refreshTokenHash) watchSession.refreshRevokedAt ??= now;
        }
      }
      if (principal.deviceKind === "WATCH" && session?.refreshFamilyId) {
        for (const familySession of Object.values(state.sessionsByTokenHash)) {
          if (familySession.refreshFamilyId === session.refreshFamilyId) {
            familySession.revokedAt ??= now;
            if (familySession.refreshTokenHash) familySession.refreshRevokedAt ??= now;
          }
        }
      }
    });
    for (const listener of this.revocationListeners) {
      try { listener(); }
      catch { console.error("Session revocation committed; an observer failed"); }
    }
  }

  async requestAccountDeletionToken(rawToken: string): Promise<AccountClosureReceipt> {
    const completed = readEntities(this.store, view => {
      const session = view.get("sessionsByTokenHash", tokenHash(rawToken));
      if (session?.sessionKind !== "ACCOUNT" || !session.revokedAt || !session.accountClosureRequestId) return undefined;
      const record = view.get("deletionRequestsById", session.accountClosureRequestId);
      if (record?.status !== "CLOSED" || record.userId !== session.userId
        || view.get("users", record.userId)?.lifecycleState !== "CLOSED") return undefined;
      return closureReceipt(record);
    });
    // A lost closure ACK may be replayed, but this path restores no principal.
    return completed ?? this.requestAccountDeletion(this.authenticateToken(rawToken));
  }

  /** Logical account closure, per the product decision of 2026-09-13. Keep
   * existing information under its retention policy, mark the user CLOSED and
   * revoke every credential. The legacy route/name remains wire compatible. */
  async requestAccountDeletion(principal: Principal): Promise<AccountClosureReceipt> {
    if (principal.kind !== "ACCOUNT") {
      throw forbidden("Account deletion requires an authenticated account session");
    }
    const userId = principal.userId;
    const requestId = `deletion:${userId}`;
    const existing = readEntities(this.store, state => {
      const row = state.get("deletionRequestsById", requestId);
      return row ? { ...row } : undefined;
    });
    // Idempotent: a retried or replayed request returns the original decision
    // instead of writing a second one.
    if (existing) return closureReceipt(existing);

    this.assertCurrent(principal);
    const requestedAt = this.now().toISOString();
    const receipt = await transactState(this.store, state => {
      const prior = state.deletionRequestsById[requestId];
      if (prior) return closureReceipt(prior);
      const user = state.users[userId];
      if (!user) throw unauthorized("Account no longer exists");
      user.lifecycleState = "CLOSED";
      user.closedAt = requestedAt;
      user.updatedAt = requestedAt;
      stopAccountCollection(state, userId, requestedAt, "CLOSED");
      // Apple requires the app to revoke the tokens it was granted.  Queue every
      // Apple account of this user; the sweeper retries until Apple confirms.
      for (const account of Object.values(state.accounts)) {
        if (account.userId !== userId) continue;
        if (account.provider !== "APPLE" || !account.appleRefreshToken) continue;
        state.appleRevocationsById[account.accountId] = {
          accountId: account.accountId,
          userId,
          refreshToken: account.appleRefreshToken,
          requestedAt,
          attempts: 0
        };
      }
      state.sessionsByTokenHash[principal.tokenHash]!.accountClosureRequestId = requestId;
      state.deletionRequestsById[requestId] = {
        requestId, userId, requestedAt, status: "CLOSED", accountClosed: true,
        accountClosedAt: requestedAt, erasureStartedAt: requestedAt, purged: []
      };
      return closureReceipt(state.deletionRequestsById[requestId]!);
    });
    for (const listener of this.revocationListeners) {
      try { listener(); }
      catch { console.error("Account deletion committed; an observer failed"); }
    }
    return receipt;
  }

}
