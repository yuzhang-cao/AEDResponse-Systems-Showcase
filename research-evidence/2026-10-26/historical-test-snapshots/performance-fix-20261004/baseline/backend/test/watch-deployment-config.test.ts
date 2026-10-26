import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("Watch signing category is independent from the production attestation environment", () => {
  const config = loadConfig({ AED_WATCH_ATTEST_ENVIRONMENT: "production", AED_WATCH_VALIDATION_CATEGORIES: "3" });
  assert.equal(config.watchAttestEnvironment, "production");
  assert.deepEqual(config.watchValidationCategories, [3]);
  for (const value of ["", "0", "1", "3,3", "*", "3,"]) {
    assert.throws(() => loadConfig({ AED_WATCH_VALIDATION_CATEGORIES: value }), /signing categories/);
  }
});

const production = {
  NODE_ENV: "production", AED_NEARBY_RADIUS_METERS: "1000",
  AED_POSITION_MAX_AGE_SECONDS: "300", AED_MAX_POSITION_ACCURACY_METERS: "50",
  AED_MAX_CLIENT_CLOCK_SKEW_SECONDS: "120",
  AED_AUTH_SUBJECT_PEPPER: "abcdefghijklmnopqrstuvwxyz012345",
  AED_WATCH_APP_ATTEST_APP_ID: "TEAMID.dev.example.watch"
};

test("production Watch deployment fails closed until both trust settings are explicit", () => {
  assert.throws(() => loadConfig(production), /AED_WATCH_BUNDLE_VERSIONS/);
  assert.throws(() => loadConfig({ ...production, AED_WATCH_BUNDLE_VERSIONS: "2" }), /AED_WATCH_ATTEST_ENVIRONMENT/);
  const complete = { ...production, AED_WATCH_BUNDLE_VERSIONS: "2", AED_WATCH_ATTEST_ENVIRONMENT: "development" };
  const config = loadConfig(complete);
  assert.deepEqual(config.watchBundleVersions, ["2"]);
  assert.equal(config.watchAttestEnvironment, "development");
  assert.throws(() => loadConfig({ ...complete, AED_WATCH_BUNDLE_VERSIONS: "*" }), /CFBundleVersion/);
  assert.throws(() => loadConfig({ ...complete, AED_WATCH_ATTEST_ENVIRONMENT: "any" }), /development or production/);
});
