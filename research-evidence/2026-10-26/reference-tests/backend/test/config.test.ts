import assert from "node:assert/strict";
import test from "node:test";
import { createBackend } from "../src/server.js";
import type { BackendConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";

test("Watch signing category is explicit and independent from attestation environment", () => {
  const config = loadConfig({ AED_WATCH_ATTEST_ENVIRONMENT: "production", AED_WATCH_VALIDATION_CATEGORIES: "3" });
  assert.equal(config.watchAttestEnvironment, "production");
  assert.deepEqual(config.watchValidationCategories, [3]);
  for (const value of ["", "0", "1", "3,3", "*", "3,"]) {
    assert.throws(() => loadConfig({ AED_WATCH_VALIDATION_CATEGORIES: value }), /signing categories/);
  }
});
import { emptyState } from "../src/models.js";
import { MemoryStateStore } from "../src/store.js";

test("network and positioning policy are configurable without embedding a personal address", () => {
  const config = loadConfig({
    AED_HOST: "192.0.2.10",
    AED_PORT: "9876",
    AED_DATA_FILE: "state.sqlite",
    AED_LEGACY_DATA_FILE: "legacy.json",
    AED_NEARBY_RADIUS_METERS: "1234.5",
    AED_POSITION_MAX_AGE_SECONDS: "321",
    AED_MAX_POSITION_ACCURACY_METERS: "45.5",
    AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "0"
  }, "/tmp/aedresponse-config-test");
  assert.equal(config.host, "192.0.2.10");
  assert.equal(config.port, 9876);
  assert.equal(config.nearbyRadiusMeters, 1234.5);
  assert.equal(config.positionMaxAgeSeconds, 321);
  assert.equal(config.maxPositionAccuracyMeters, 45.5);
  assert.equal(config.maxClientClockSkewSeconds, 0);
  assert.match(config.dataFile, /state\.sqlite$/);
  assert.match(config.legacyDataFile ?? "", /legacy\.json$/);
});

test("production requires explicit positioning boundaries", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }, "/tmp/aedresponse-config-production"),
    /must be explicitly set in production/
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      AED_NEARBY_RADIUS_METERS: "1000",
      AED_POSITION_MAX_AGE_SECONDS: "300",
      AED_MAX_POSITION_ACCURACY_METERS: "50"
    }, "/tmp/aedresponse-config-production"),
    /AED_MAX_CLIENT_CLOCK_SKEW_SECONDS must be explicitly set/
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      AED_NEARBY_RADIUS_METERS: "1000",
      AED_POSITION_MAX_AGE_SECONDS: "300",
      AED_MAX_POSITION_ACCURACY_METERS: "50",
      AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "120",
      AED_AUTH_SUBJECT_PEPPER: "too-short"
    }, "/tmp/aedresponse-config-production"),
    /AED_AUTH_SUBJECT_PEPPER must contain at least 32 bytes/
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      AED_NEARBY_RADIUS_METERS: "1000",
      AED_POSITION_MAX_AGE_SECONDS: "300",
      AED_MAX_POSITION_ACCURACY_METERS: "50",
      AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "120",
      AED_AUTH_SUBJECT_PEPPER: "abcdefghijklmnopqrstuvwxyz012345"
    }, "/tmp/aedresponse-config-production"),
    /AED_WATCH_APP_ATTEST_APP_ID must be explicitly set/
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      AED_NEARBY_RADIUS_METERS: "1000",
      AED_POSITION_MAX_AGE_SECONDS: "300",
      AED_MAX_POSITION_ACCURACY_METERS: "50",
      AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "120",
      AED_AUTH_SUBJECT_PEPPER: "abcdefghijklmnopqrstuvwxyz012345",
      AED_WATCH_APP_ATTEST_APP_ID: "TEAMID.com.aedresponse"
    }, "/tmp/aedresponse-config-production"),
    /AED_WATCH_BUNDLE_VERSIONS must be explicitly set/
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      AED_NEARBY_RADIUS_METERS: "1000",
      AED_POSITION_MAX_AGE_SECONDS: "300",
      AED_MAX_POSITION_ACCURACY_METERS: "50",
      AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "120",
      AED_AUTH_SUBJECT_PEPPER: "abcdefghijklmnopqrstuvwxyz012345",
      AED_WATCH_APP_ATTEST_APP_ID: "TEAMID.com.aedresponse",
      AED_WATCH_BUNDLE_VERSIONS: "2"
    }, "/tmp/aedresponse-config-production"),
    /AED_WATCH_ATTEST_ENVIRONMENT must be explicitly set/
  );
  assert.throws(
    () => loadConfig({ AED_WATCH_ATTEST_ENVIRONMENT: "guess" }),
    /must be development or production/
  );
});


test("Apple simulation needs exactly two distinct explicit devices and private IPC", () => {
  const ids = "REDACTED-ID-0109,REDACTED-ID-0110";
  const valid = { AED_SIMULATION_APPLE_DEVICE_IDS: ids, AED_SIMULATION_ADMIN_SOCKET: "/tmp/private/admin.sock" };
  assert.deepEqual(loadConfig(valid).simulationAppleDeviceIds, ids.split(","));
  assert.equal(loadConfig(valid).enableControlledTestAccounts, false);
  const upper = "REDACTED-ID-0111";
  assert.equal(loadConfig({ ...valid, AED_SIMULATION_APPLE_DEVICE_IDS: upper + "," + ids.split(",")[0] }).simulationAppleDeviceIds?.[0], upper);
  assert.throws(() => loadConfig({ ...valid, AED_SIMULATION_APPLE_DEVICE_IDS: upper + "," + upper.toLowerCase() }));
  assert.throws(() => loadConfig({ AED_SIMULATION_APPLE_DEVICE_IDS: ids }));
  for (const value of ["bad", ids.split(",")[0]!, ids + "," + ids.split(",")[0], ids.split(",")[0] + "," + ids.split(",")[0]]) {
    assert.throws(() => loadConfig({ ...valid, AED_SIMULATION_APPLE_DEVICE_IDS: value }));
  }
});

/**
 * R11 — the production defaults used to keep the reference implementation alive:
 * a demonstration AED catalogue and the in-process geometric route.  Both look
 * like a working deployment, which is exactly why they must fail loudly instead.
 */
test("production refuses to start on a demo catalogue or the reference route", () => {
  const base = {
    NODE_ENV: "production",
    AED_NEARBY_RADIUS_METERS: "1000",
    AED_POSITION_MAX_AGE_SECONDS: "300",
    AED_MAX_POSITION_ACCURACY_METERS: "50",
    AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "120",
    AED_AUTH_SUBJECT_PEPPER: "abcdefghijklmnopqrstuvwxyz012345",
    AED_WATCH_APP_ATTEST_APP_ID: "TEAMID.com.aedresponse",
    AED_WATCH_BUNDLE_VERSIONS: "2",
    AED_WATCH_ATTEST_ENVIRONMENT: "development"
  };
  // The navigation mode has to be stated: a deployment must say whether the phone
  // navigates (Apple Maps) or the server does (高德), instead of inheriting one.
  assert.throws(
    () => loadConfig(base, "/tmp/aedresponse-config-production"),
    /AED_NAVIGATION_MODE must be explicitly set in production/
  );
  assert.throws(
    () => loadConfig({ ...base, AED_NAVIGATION_MODE: "SOMETHING_ELSE" },
      "/tmp/aedresponse-config-production"),
    /AED_NAVIGATION_MODE must be CLIENT_APPLE_MAPS or SERVER_AMAP/
  );
  // SERVER_AMAP is the only mode that needs a routing key; CLIENT_APPLE_MAPS needs
  // none, which is the point of the product decision.
  assert.throws(
    () => loadConfig({ ...base, AED_NAVIGATION_MODE: "SERVER_AMAP" },
      "/tmp/aedresponse-config-production"),
    /SERVER_AMAP requires AED_AMAP_WEB_KEY/
  );
  assert.throws(
    () => loadConfig({ ...base, AED_NAVIGATION_MODE: "CLIENT_APPLE_MAPS" },
      "/tmp/aedresponse-config-production"),
    /AED_FIXTURE_FILE must be explicitly set in production/
  );
  const configured = loadConfig({
    ...base,
    AED_NAVIGATION_MODE: "SERVER_AMAP",
    AED_AMAP_WEB_KEY: "amap-key",
    AED_FIXTURE_FILE: "inventory/production-aeds.json"
  }, "/tmp/aedresponse-config-production");
  assert.match(configured.fixtureFile ?? "", /inventory\/production-aeds\.json$/);
  assert.equal(configured.amapWebKey, "amap-key");
  assert.equal(configured.navigationMode, "SERVER_AMAP");
  assert.deepEqual(configured.watchBundleVersions, ["2"]);
  assert.equal(configured.watchAttestEnvironment, "development");
  const clientNavigated = loadConfig({
    ...base,
    AED_NAVIGATION_MODE: "CLIENT_APPLE_MAPS",
    AED_FIXTURE_FILE: "inventory/production-aeds.json"
  }, "/tmp/aedresponse-config-production");
  assert.equal(clientNavigated.navigationMode, "CLIENT_APPLE_MAPS");
  assert.equal(clientNavigated.amapWebKey, undefined,
    "Apple Maps navigation must not require a routing vendor key");

  // Development keeps the convenience defaults, including the demo catalogue.
  const development = loadConfig({}, "/tmp/aedresponse-config-development");
  assert.match(development.fixtureFile ?? "", /demo-scenario\.json$/);
  assert.equal(development.amapWebKey, undefined);
});

/** R12 — only an explicitly trusted proxy may speak for the client. */
test("only declared proxy peers may supply the forwarded client address", () => {
  const withoutProxies = loadConfig({}, "/tmp/aedresponse-config-development");
  assert.equal(withoutProxies.trustedProxies, undefined,
    "no proxy is trusted by default, so the header is ignored");

  const withProxies = loadConfig({
    AED_TRUSTED_PROXIES: "127.0.0.1, ::1 ,[REDACTED-HOST]"
  }, "/tmp/aedresponse-config-development");
  assert.deepEqual(withProxies.trustedProxies, ["127.0.0.1", "::1", "[REDACTED-HOST]"]);

  const tooMany = Array.from({ length: 17 }, (_, index) => `10.0.0.${index}`).join(",");
  assert.throws(
    () => loadConfig({ AED_TRUSTED_PROXIES: tooMany }, "/tmp/aedresponse-config-development"),
    /at most 16 entries/
  );
});

test("production refuses to start in a navigation mode it cannot honour", async () => {
  // The gate lives in createBackend, because that is where the provider is chosen.
  // Both directions matter: SERVER_AMAP must not run on planning estimates, and
  // CLIENT_APPLE_MAPS must not be blocked by a missing vendor key.
  const base = {
    host: "127.0.0.1", port: 0, dataFile: "unused.json",
    fixtureFile: "inventory/aeds.json", sessionTtlSeconds: 900,
    nearbyRadiusMeters: 1_000, positionMaxAgeSeconds: 300,
    maxClientClockSkewSeconds: 120, maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 30, production: true
  };
  const store = new MemoryStateStore(emptyState());
  // CLIENT_APPLE_MAPS: the in-process planner is the configured implementation.
  const clientMode = await createBackend({
    config: { ...base, navigationMode: "CLIENT_APPLE_MAPS" } as BackendConfig,
    store
  });
  // The store is owned by the caller here, so the test closes it directly rather
  // than through `stop()`, which expects a server that was started.
  assert.ok(clientMode.service);
  assert.equal(store.read(state => Object.keys(state.events).length), 0);

  // SERVER_AMAP without a real provider is refused rather than served estimates.
  await assert.rejects(
    createBackend({
      config: { ...base, navigationMode: "SERVER_AMAP", amapWebKey: "configured" } as BackendConfig,
      store: new MemoryStateStore(emptyState())
    }),
    /requires a real route provider/,
    "the server may not promise 高德 routes and deliver planning estimates"
  );
});


test("explicit AMap mode also refuses geometric routing in development", async () => {
  await assert.rejects(createBackend({ config: { ...loadConfig({}), navigationMode: "SERVER_AMAP" },
    store: new MemoryStateStore(emptyState()) }), /requires a real route provider/);
});
