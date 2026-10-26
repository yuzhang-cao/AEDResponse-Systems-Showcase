import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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
});


test("Apple simulation needs exactly two distinct explicit devices and private IPC", () => {
  const ids = "REDACTED-SUPPLEMENT-ID-bd7662a5eeb4,REDACTED-SUPPLEMENT-ID-b454f82c5857";
  const valid = { AED_SIMULATION_APPLE_DEVICE_IDS: ids, AED_SIMULATION_ADMIN_SOCKET: "/tmp/private/admin.sock" };
  assert.deepEqual(loadConfig(valid).simulationAppleDeviceIds, ids.split(","));
  assert.equal(loadConfig(valid).enableControlledTestAccounts, false);
  const upper = "REDACTED-SUPPLEMENT-ID-ff53c1b8c410";
  assert.equal(loadConfig({ ...valid, AED_SIMULATION_APPLE_DEVICE_IDS: upper + "," + ids.split(",")[0] }).simulationAppleDeviceIds?.[0], upper);
  assert.throws(() => loadConfig({ ...valid, AED_SIMULATION_APPLE_DEVICE_IDS: upper + "," + upper.toLowerCase() }));
  assert.throws(() => loadConfig({ AED_SIMULATION_APPLE_DEVICE_IDS: ids }));
  for (const value of ["bad", ids.split(",")[0]!, ids + "," + ids.split(",")[0], ids.split(",")[0] + "," + ids.split(",")[0]]) {
    assert.throws(() => loadConfig({ ...valid, AED_SIMULATION_APPLE_DEVICE_IDS: value }));
  }
});
