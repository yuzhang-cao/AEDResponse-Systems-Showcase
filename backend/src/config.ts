import { resolve, isAbsolute } from "node:path";

export interface BackendConfig {
  amapWebKey?: string;
  /**
   * How a responder gets walking directions (product decision 2026-09-14).
   *
   *   - `CLIENT_APPLE_MAPS`: the phone navigates with Apple Maps, and the server's
   *     route is a PLANNING ESTIMATE (which AED is closest, what the ETA range is).
   *     No routing vendor key is needed, which is why this is the default mode.
   *   - `SERVER_AMAP`: the server computes walking routes with 高德 and the app
   *     follows them; this is the only mode that requires `AED_AMAP_WEB_KEY`.
   *
   * In production the mode must be stated explicitly, so a deployment always says
   * which of the two it is instead of inheriting one by accident.
   */
  navigationMode?: "CLIENT_APPLE_MAPS" | "SERVER_AMAP";
  host: string;
  port: number;
  dataFile: string;
  /**
   * Append-only identity ledger (G11 restore replay).  Defaults beside the
   * database, but the deployment MUST keep it outside the database backup set —
   * a ledger restored together with the copy it is meant to correct proves
   * nothing.  See docs/backup-recovery-2026-09-13.md.
   */
  identityLedgerFile?: string;
  /** Explicit operator acknowledgement of a rolled-back ledger. */
  allowStaleIdentityLedger?: boolean;
  legacyDataFile?: string;
  /**
   * Seed AED catalogue for an EMPTY database.  Absent means "no seed": the
   * service then starts with no AED inventory, which is the fail-closed
   * behaviour.  A demonstration catalogue must never be the production default.
   */
  fixtureFile?: string;
  /**
   * Peer addresses whose `X-Forwarded-For` header may be believed.
   *
   * Empty means no header is ever trusted, so the socket peer is the client.
   * Only list an address that cannot be reached by a client directly — the
   * reverse proxy on loopback is the normal case.
   */
  trustedProxies?: readonly string[];
  sessionTtlSeconds: number;
  nearbyRadiusMeters: number;
  positionMaxAgeSeconds: number;
  maxClientClockSkewSeconds: number;
  maxPositionAccuracyMeters: number;
  /**
   * How long after a participation window closes a late-but-legal upload may
   * still replace a provisional gap before the recorded gap list is treated as
   * the final audit conclusion.
   *
   * Explicit and configurable on purpose: the value decides when a missing
   * second stops being a work item, so it must be a stated policy rather than a
   * number buried in the reconciliation code.
   *
   * Optional so the many in-process test configs that predate this policy keep
   * compiling; the reconciliation uses POSITION_WINDOW_GRACE_SECONDS when it is
   * absent rather than treating "unset" as "no grace".
   */
  positionWindowGraceSeconds?: number;
  bootstrapLimitPerMinute: number;
  /** Secret used to HMAC provider subjects before durable lookup. */
  authSubjectPepper?: string;
  /** Explicit test-period switch; never disables session or business validation. */
  enableControlledTestAccounts?: boolean;
  /** Enabled only for an explicitly configured private simulation IPC endpoint. */
  enableSimulatedEvents?: boolean;
  simulationAdminSocket?: string;
  /** Private test entry only: exactly two explicitly enrolled Apple device IDs. */
  simulationAppleDeviceIds?: string[];
  /** Explicit native app / Services ID audience allowlist, never inferred from a token. */
  appleClientIds?: string[];
  /** Apple App Attest app identifier used by the injected Watch verifier. */
  watchAppAttestAppId?: string;
  /** Exact CFBundleVersion allowlist accepted by the Watch App Attest verifier. */
  watchBundleVersions?: string[];
  /** App Attest environment used by the installed Watch build. */
  watchAttestEnvironment?: "development" | "production";
  operatorToken?: string;
  production: boolean;
}

function positiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  developmentDefault: number,
  production: boolean
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    if (production && name.startsWith("AED_") && [
      "AED_NEARBY_RADIUS_METERS",
      "AED_POSITION_MAX_AGE_SECONDS",
      "AED_MAX_POSITION_ACCURACY_METERS"
    ].includes(name)) {
      throw new Error(`${name} must be explicitly set in production`);
    }
    return developmentDefault;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function nonnegativeNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  developmentDefault: number,
  production: boolean
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    if (production) throw new Error(`${name} must be explicitly set in production`);
    return developmentDefault;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): BackendConfig {
  const production = env.NODE_ENV === "production";
  const navigationModeRaw = env.AED_NAVIGATION_MODE?.trim();
  if (navigationModeRaw && navigationModeRaw !== "CLIENT_APPLE_MAPS"
    && navigationModeRaw !== "SERVER_AMAP") {
    throw new Error("AED_NAVIGATION_MODE must be CLIENT_APPLE_MAPS or SERVER_AMAP");
  }
  const navigationMode = navigationModeRaw as BackendConfig["navigationMode"];
  const port = positiveNumber(env, "AED_PORT", 8787, production);
  if (!Number.isInteger(port) || port > 65_535) {
    throw new Error("AED_PORT must be an integer between 1 and 65535");
  }

  const operatorToken = env.AED_OPERATOR_TOKEN?.trim();
  const appleClientIds = env.AED_APPLE_CLIENT_IDS?.split(",").map(id => id.trim());
  if (appleClientIds && (appleClientIds.length > 10
    || appleClientIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/.test(id)))) {
    throw new Error("AED_APPLE_CLIENT_IDS must contain valid comma-separated client IDs");
  }
  const controlledTestFlag = env.AED_ENABLE_CONTROLLED_TEST_ACCOUNTS?.trim();
  if (controlledTestFlag && !["true", "false"].includes(controlledTestFlag)) {
    throw new Error("AED_ENABLE_CONTROLLED_TEST_ACCOUNTS must be true or false");
  }
  const authSubjectPepper = env.AED_AUTH_SUBJECT_PEPPER?.trim();
  const simulationAdminSocket = env.AED_SIMULATION_ADMIN_SOCKET?.trim();
  const simulationAppleIdsRaw = env.AED_SIMULATION_APPLE_DEVICE_IDS?.trim();
  const simulationAppleDeviceIds = simulationAppleIdsRaw?.split(",").map(value => value.trim());
  if (simulationAppleDeviceIds && (!simulationAdminSocket || simulationAppleDeviceIds.length !== 2
    || new Set(simulationAppleDeviceIds.map(id => id.toLowerCase())).size !== 2
    || simulationAppleDeviceIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))) {
    throw new Error("Apple simulation requires private IPC and exactly two distinct UUID device IDs");
  }
  if (simulationAdminSocket && ((controlledTestFlag !== "true" && !simulationAppleDeviceIds)
    || !isAbsolute(simulationAdminSocket) || Buffer.byteLength(simulationAdminSocket) > 100)) {
    throw new Error("Simulation IPC requires controlled accounts and an absolute local socket path");
  }
  const watchAppAttestAppId = env.AED_WATCH_APP_ATTEST_APP_ID?.trim();
  const watchBundleVersions = env.AED_WATCH_BUNDLE_VERSIONS
    ?.split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (watchBundleVersions && (watchBundleVersions.length > 32
    || watchBundleVersions.some(version => !/^[A-Za-z0-9.-]{1,64}$/.test(version)))) {
    throw new Error("AED_WATCH_BUNDLE_VERSIONS must contain valid comma-separated CFBundleVersion values");
  }
  const watchAttestEnvironmentRaw = env.AED_WATCH_ATTEST_ENVIRONMENT?.trim();
  if (watchAttestEnvironmentRaw
    && watchAttestEnvironmentRaw !== "development"
    && watchAttestEnvironmentRaw !== "production") {
    throw new Error("AED_WATCH_ATTEST_ENVIRONMENT must be development or production");
  }
  const watchAttestEnvironment = watchAttestEnvironmentRaw as BackendConfig["watchAttestEnvironment"];
  const positionMaxAgeSeconds = positiveNumber(
    env,
    "AED_POSITION_MAX_AGE_SECONDS",
    600,
    production
  );
  if (!Number.isInteger(positionMaxAgeSeconds)) {
    throw new Error("AED_POSITION_MAX_AGE_SECONDS must be an integer");
  }
  const maxClientClockSkewSeconds = nonnegativeNumber(
    env,
    "AED_MAX_CLIENT_CLOCK_SKEW_SECONDS",
    120,
    production
  );
  if (!Number.isInteger(maxClientClockSkewSeconds)) {
    throw new Error("AED_MAX_CLIENT_CLOCK_SKEW_SECONDS must be an integer");
  }
  if (production && !authSubjectPepper) {
    throw new Error("AED_AUTH_SUBJECT_PEPPER must be explicitly set in production");
  }
  if (production && authSubjectPepper && Buffer.byteLength(authSubjectPepper, "utf8") < 32) {
    throw new Error("AED_AUTH_SUBJECT_PEPPER must contain at least 32 bytes in production");
  }
  if (production && !watchAppAttestAppId) {
    throw new Error("AED_WATCH_APP_ATTEST_APP_ID must be explicitly set in production");
  }
  if (production && !watchBundleVersions?.length) {
    throw new Error("AED_WATCH_BUNDLE_VERSIONS must be explicitly set in production");
  }
  if (production && !watchAttestEnvironment) {
    throw new Error("AED_WATCH_ATTEST_ENVIRONMENT must be explicitly set in production");
  }
  const explicitFixture = env.AED_FIXTURE_FILE?.trim();
  const trustedProxies = env.AED_TRUSTED_PROXIES?.split(",")
    .map(value => value.trim())
    .filter(value => value.length > 0);
  if (trustedProxies && trustedProxies.length > 16) {
    throw new Error("AED_TRUSTED_PROXIES accepts at most 16 entries");
  }
  if (production) {
    // Fail closed on the two reference-implementation shortcuts that would
    // otherwise run silently in production: a demonstration AED catalogue
    // published as real inventory, and the geometric reference route that has
    // none of the walking, access or opening data a real dispatch needs.
    if (navigationMode === undefined) {
      throw new Error(
        "AED_NAVIGATION_MODE must be explicitly set in production: "
        + "CLIENT_APPLE_MAPS (the phone navigates with Apple Maps; the server plans "
        + "with local estimates) or SERVER_AMAP (the server routes with 高德 and "
        + "AED_AMAP_WEB_KEY is then required)"
      );
    }
    if (navigationMode === "SERVER_AMAP" && !env.AED_AMAP_WEB_KEY?.trim()) {
      throw new Error(
        "AED_NAVIGATION_MODE=SERVER_AMAP requires AED_AMAP_WEB_KEY: the server is "
        + "the router in this mode. Use CLIENT_APPLE_MAPS if the phone navigates."
      );
    }
    if (!explicitFixture && !env.AED_FIXTURE_FILE?.trim()) {
      throw new Error(
        "AED_FIXTURE_FILE must be explicitly set in production: an unset fixture "
        + "starts the service with no AED inventory, and the repository demo "
        + "catalogue is never a production default"
      );
    }
  }
  return {
    ...(env.AED_AMAP_WEB_KEY?.trim() ? { amapWebKey: env.AED_AMAP_WEB_KEY.trim() } : {}),
    navigationMode: navigationMode ?? "CLIENT_APPLE_MAPS",
    host: env.AED_HOST?.trim() || "127.0.0.1",
    port,
    dataFile: resolve(cwd, env.AED_DATA_FILE?.trim() || ".data/state.sqlite"),
    // Derived from `dataFile` at the point of use unless the deployment names a
    // path explicitly: a config object that overrides `dataFile` must not silently
    // keep writing its ledger next to the default one.
    ...(env.AED_IDENTITY_LEDGER?.trim()
      ? { identityLedgerFile: resolve(cwd, env.AED_IDENTITY_LEDGER.trim()) }
      : {}),
    allowStaleIdentityLedger: env.AED_ALLOW_STALE_IDENTITY_LEDGER === "1",
    legacyDataFile: resolve(
      cwd,
      env.AED_LEGACY_DATA_FILE?.trim() || ".data/state.json"
    ),
    ...(explicitFixture
      ? { fixtureFile: resolve(cwd, explicitFixture) }
      : production
        ? {}
        : { fixtureFile: resolve(cwd, "../contracts/fixtures/demo-scenario.json") }),
    ...(trustedProxies && trustedProxies.length > 0 ? { trustedProxies } : {}),
    sessionTtlSeconds: positiveNumber(env, "AED_SESSION_TTL_SECONDS", 900, production),
    nearbyRadiusMeters: positiveNumber(env, "AED_NEARBY_RADIUS_METERS", 3_000, production),
    positionMaxAgeSeconds,
    positionWindowGraceSeconds: nonnegativeNumber(
      env,
      "AED_POSITION_WINDOW_GRACE_SECONDS",
      120,
      false
    ),
    maxClientClockSkewSeconds,
    maxPositionAccuracyMeters: positiveNumber(
      env,
      "AED_MAX_POSITION_ACCURACY_METERS",
      200,
      production
    ),
    bootstrapLimitPerMinute: positiveNumber(
      env,
      "AED_BOOTSTRAP_LIMIT_PER_MINUTE",
      30,
      production
    ),
    ...(authSubjectPepper ? { authSubjectPepper } : {}),
    enableControlledTestAccounts: controlledTestFlag === "true",
    ...(simulationAdminSocket ? { simulationAdminSocket, enableSimulatedEvents: true } : {}),
    ...(simulationAppleDeviceIds ? { simulationAppleDeviceIds } : {}),
    ...(appleClientIds ? { appleClientIds } : {}),
    ...(watchAppAttestAppId ? { watchAppAttestAppId } : {}),
    ...(watchBundleVersions?.length ? { watchBundleVersions } : {}),
    ...(watchAttestEnvironment ? { watchAttestEnvironment } : {}),
    ...(operatorToken ? { operatorToken } : {}),
    production
  };
}
