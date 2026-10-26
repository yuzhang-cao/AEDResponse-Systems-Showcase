/**
 * Backend smoke suite: one throwaway loopback backend, the single critical path.
 *
 *   npm run smoke:backend
 *
 * This asserts the integration seams only: the authentication gate, the Watch
 * fall trigger, position-source arbitration, Socket.IO notification privacy,
 * recruitment, responder acceptance, AED receipt idempotency and event end.
 * Boundary, retention and concurrency behaviour stays in the full suites.
 */
import type { Socket } from "socket.io-client";
import {
  check,
  deepEqual,
  delay,
  equal,
  readFixtureAeds,
  startSmokeHarness,
  uuid,
  type EventProjection,
  type SessionBody
} from "./support.js";

const PATIENT_DEVICE = uuid(9_001);
const PATIENT_PAIR = uuid(9_002);
const WATCH_DEVICE = uuid(9_003);
const RESPONDER_A = uuid(9_011);
const RESPONDER_B = uuid(9_012);
const RESPONDER_C = uuid(9_013);
const FAR_DEVICE = uuid(9_014);
const CLOSER_DEVICE = uuid(9_015);
const EVENT_ID = uuid(9_100);

const PATIENT_LATITUDE = 22.1987;
const PATIENT_LONGITUDE = 113.5439;
/** ~90 m from the patient, so every responder lands in the first 1 km ring. */
const NEARBY_LATITUDE = 22.198;
const NEARBY_LONGITUDE = 113.543;
/** ~12 km away: must never be recruited into this event. */
const FAR_LATITUDE = 22.3;
const FAR_LONGITUDE = 113.543;

interface StepResult {
  id: string;
  title: string;
  durationMs: number;
}

function fallObservation(iso: (offsetSeconds: number) => string): Record<string, unknown> {
  return {
    schemaVersion: "2.0",
    eventId: EVENT_ID,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: iso(1),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPositionObservedAt: iso(0),
    patientPosition: {
      kind: "P",
      latitude: PATIENT_LATITUDE,
      longitude: PATIENT_LONGITUDE,
      accuracyMeters: 12
    }
  };
}

async function run(): Promise<void> {
  const aeds = await readFixtureAeds();
  const harness = await startSmokeHarness({ aeds });
  const results: StepResult[] = [];
  const sockets: Socket[] = [];
  let current: { id: string; title: string } = { id: "startup", title: "startup" };

  const step = async (id: string, title: string, body: () => Promise<void> | void): Promise<void> => {
    current = { id, title };
    const started = performance.now();
    await body();
    const durationMs = Math.round(performance.now() - started);
    results.push({ id, title, durationMs });
    console.log(`  PASS  ${id}  ${title} (${durationMs} ms)`);
  };

  console.log(`AEDResponse v2 backend smoke -> ${harness.baseURL}`);
  console.log(`seeded AEDs: ${aeds.map(aed => aed.id).join(", ")}`);
  console.log("");

  try {
    let patient!: SessionBody;
    let watch!: SessionBody;
    let responderA!: SessionBody;
    let responderB!: SessionBody;
    let responderC!: SessionBody;
    let responderSocket!: Socket;
    let deliveryA = "";
    let deliveryB = "";
    let assignmentId = "";
    let aedAssignmentId = "";
    let aedId = "";
    // Runs on the wall clock while server time is advanced: the smoke suite must
    // not actually wait for recruitment stages.
    const settling = delay(250);

    await step("S01", "health endpoint answers the documented envelope", async () => {
      const health = await harness.request<{ status: string; schemaVersion: string; now: string }>(
        "GET",
        "/healthz"
      );
      equal(health.status, 200, "GET /healthz must return 200");
      equal(health.body.status, "ok", "GET /healthz must report status ok");
      equal(health.body.schemaVersion, "2.0", "GET /healthz must report schemaVersion 2.0");
      check(Number.isFinite(Date.parse(health.body.now)), "GET /healthz must report a parseable now");
      check(health.contentType.includes("application/json"),
        "GET /healthz must be application/json", health.contentType);
    });

    await step("S02", "unauthenticated reads and unknown routes return RFC7807 problems", async () => {
      // The `/api/v2` surface authenticates before routing, so an anonymous
      // caller must not be able to probe which routes exist.
      const anonymous = await harness.request("GET", "/api/v2/does-not-exist");
      equal(anonymous.status, 401,
        "an anonymous request to an unknown API route must return 401, not a route oracle");
      check(anonymous.contentType.includes("application/problem+json"),
        "problems must use application/problem+json", anonymous.contentType);
      const problem = anonymous.body as { type?: string; status?: number; detail?: string };
      equal(problem.status, 401, "the problem document must echo the HTTP status");
      check(typeof problem.type === "string"
        && problem.type.startsWith("https://aedresponse.invalid/problems/"),
        "the problem document must carry the documented type URI", String(problem.type));
      check(typeof problem.detail === "string" && problem.detail.length > 0,
        "the problem document must carry a detail message");

      const accountToken = await harness.login("smoke-responder-a");
      const unknown = await harness.request("GET", "/api/v2/does-not-exist", undefined, accountToken);
      equal(unknown.status, 404, "an authenticated unknown route must return 404");
      check(unknown.contentType.includes("application/problem+json"),
        "unknown routes must use application/problem+json", unknown.contentType);
    });

    await step("S03", "authentication gate rejects unverified credentials", async () => {
      equal((await harness.request("GET", "/api/v2/events")).status, 401,
        "an unauthenticated business read must return 401");
      equal((await harness.request("GET", "/api/v2/events", undefined, "not-a-session")).status, 401,
        "a forged bearer token must return 401");
      // Apple sign-in is the only login method.  A valid challenge is issued, and
      // an unverifiable identity token is refused rather than trusted.
      const challenge = await harness.request<{ challengeId: string }>(
        "POST",
        "/api/v2/auth/apple/challenges",
        {}
      );
      equal(challenge.status, 201, "an Apple login must receive a nonce challenge");
      equal((await harness.request(
        "POST",
        "/api/v2/auth/apple",
        {
          challengeId: challenge.body.challengeId,
          identityToken: "not-a-verified-token",
          nonce: "nonce"
        }
      )).status, 401, "an unverifiable Apple identity token must return 401");
      equal((await harness.request(
        "POST",
        "/api/v2/auth/apple",
        { challengeId: "not-a-uuid", identityToken: "apple:x", nonce: "n" }
      )).status, 400, "a malformed challenge id must return 400");
      // The removed PHONE entry points must not come back silently.
      equal((await harness.request(
        "POST",
        "/api/v2/auth/phone/challenges",
        { phoneNumber: "[REDACTED_PHONE]" }
      )).status, 401, "the removed phone challenge route is no longer reachable");
    });

    await step("S04", "four agreements gate bootstrap; denied permissions only disarm response", async () => {
      const accountToken = await harness.login("smoke-patient");
      const base = {
        deviceInstanceId: PATIENT_DEVICE,
        deviceKind: "IPHONE" as const,
        companionPairId: PATIENT_PAIR,
        capabilities: { notificationAuthorized: true, locationAuthorized: true },
        availableForResponse: true
      };
      equal((await harness.request(
        "POST",
        "/api/v2/session/bootstrap",
        { ...base, agreementAcceptances: [] },
        accountToken
      )).status, 400, "bootstrap without the four agreements must return 400");
      equal((await harness.request(
        "POST",
        "/api/v2/session/bootstrap",
        {
          ...base,
          agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY"]
            .map(kind => ({ kind, version: "2.0", acceptedAt: harness.iso(0) }))
        },
        accountToken
      )).status, 400, "bootstrap with three of four agreements must return 400");

      // A denied system permission is client-side information the server must
      // record, not a request error: the device is simply disarmed for response.
      const deniedDevice = uuid(9_007);
      const denied = await harness.request<SessionBody>(
        "POST",
        "/api/v2/session/bootstrap",
        {
          deviceInstanceId: deniedDevice,
          deviceKind: "IPHONE",
          companionPairId: uuid(9_008),
          agreementAcceptances: [
            "PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"
          ].map(kind => ({ kind, version: "2.0", acceptedAt: harness.iso(0) })),
          capabilities: { notificationAuthorized: false, locationAuthorized: true },
          availableForResponse: true
        },
        accountToken
      );
      equal(denied.status, 201,
        "bootstrap with a denied system permission is accepted and recorded");
      const deniedPresence = await harness.request<{
        availableForResponse: boolean;
        capabilities: { notificationAuthorized: boolean; locationAuthorized: boolean };
      }>("GET", "/api/v2/me/presence", undefined, denied.body.sessionToken);
      equal(deniedPresence.status, 200, "a disarmed device must still read its own presence");
      equal(deniedPresence.body.capabilities.notificationAuthorized, false,
        "the denied notification permission must be persisted");

      patient = await harness.bootstrapIPhone(PATIENT_DEVICE, PATIENT_PAIR);
      check(patient.sessionToken.length >= 32, "the device session token must be opaque and long");
      check(patient.scopes.length > 0, "the device session must carry explicit scopes");
      check(Date.parse(patient.expiresAt) > harness.now().getTime(),
        "the device session must expire in the future");
    });

    await step("S05", "Watch session requires an iPhone-issued one-time ticket", async () => {
      equal((await harness.request(
        "POST",
        "/api/v2/watch/session/redeem",
        {
          deviceInstanceId: WATCH_DEVICE,
          companionPairId: PATIENT_PAIR,
          companionLinkTicket: uuid(9_009),
          appAttestKeyId: "smoke-watch-key",
          attestationObject: "d2F0Y2gtYXR0ZXN0YXRpb24="
        }
      )).status, 401, "a forged companion-link ticket must be rejected");
      watch = await harness.bootstrapWatch(WATCH_DEVICE, PATIENT_PAIR, patient.sessionToken);
      equal((await harness.request(
        "POST",
        "/api/v2/me/companion-link-tickets",
        { companionPairId: PATIENT_PAIR },
        watch.sessionToken
      )).status, 403, "the Watch session must not issue iPhone companion tickets");
    });

    await step("S06", "a Watch fall observation creates the ACTIVE/RECRUITING event", async () => {
      const created = await harness.request<EventProjection>(
        "PUT",
        `/api/v2/watch/emergency-observations/${EVENT_ID}`,
        fallObservation(harness.iso),
        watch.sessionToken
      );
      equal(created.status, 201, "the first fall observation must create the event");
      equal(created.body.state, "ACTIVE", "a NEEDS_HELP fall must create an ACTIVE event");
      equal(created.body.recruitmentState, "RECRUITING", "a new event must enter recruitment");
      equal((await harness.request(
        "PUT",
        `/api/v2/watch/emergency-observations/${EVENT_ID}`,
        fallObservation(harness.iso),
        watch.sessionToken
      )).status, 200, "replaying the same trigger must be idempotent");
      equal((await harness.request(
        "PUT",
        `/api/v2/watch/emergency-observations/${EVENT_ID}`,
        { ...fallObservation(harness.iso), fallResolution: "CONFIRMED" },
        watch.sessionToken
      )).status, 409, "a different fall resolution for the same event must return 409");
    });

    await step("S07", "P writes enforce scope, range, clock skew and no regression", async () => {
      const patientUpdate = {
        positionUpdateId: uuid(9_200),
        observedAt: harness.iso(0),
        patientPosition: {
          kind: "P",
          latitude: PATIENT_LATITUDE,
          longitude: PATIENT_LONGITUDE,
          accuracyMeters: 8
        }
      };
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/patient-position`,
        patientUpdate,
        watch.sessionToken
      )).status, 403, "a Watch session must not write the iPhone patient position");
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/patient-position`,
        { ...patientUpdate, patientPosition: { ...patientUpdate.patientPosition, latitude: 999 } },
        patient.sessionToken
      )).status, 400, "an out-of-range latitude must return 400");
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/patient-position`,
        { ...patientUpdate, observedAt: harness.iso(3_600) },
        patient.sessionToken
      )).status, 409, "a sample beyond the client clock skew allowance must return 409");

      const applied = await harness.request<{ applied: boolean }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/patient-position`,
        patientUpdate,
        patient.sessionToken
      );
      equal(applied.status, 200, "the triggering iPhone must be able to publish P");
      equal(applied.body.applied, true, "the first patient position must be applied");
      const replay = await harness.request<{ idempotent: boolean }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/patient-position`,
        patientUpdate,
        patient.sessionToken
      );
      equal(replay.status, 200, "replaying an identical position write must succeed");
      equal(replay.body.idempotent, true, "an identical position replay must be reported idempotent");

      const stale = await harness.request<{ applied?: boolean }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/patient-position`,
        {
          positionUpdateId: uuid(9_201),
          observedAt: harness.iso(0),
          patientPosition: {
            kind: "P",
            latitude: 22.1999,
            longitude: 113.5499,
            accuracyMeters: 900
          }
        },
        patient.sessionToken
      );
      equal(stale.status, 200, "a stale patient position must still be stored as evidence");
      equal(stale.body.applied, false, "a stale patient position must not replace the projection");
      equal((await harness.event(EVENT_ID, patient.sessionToken)).patientPosition?.latitude,
        PATIENT_LATITUDE, "the patient projection must keep the newest fix");
    });

    await step("S08", "standby responders publish R and stay out of the event", async () => {
      responderA = await harness.bootstrapIPhone(RESPONDER_A, uuid(9_021));
      responderB = await harness.bootstrapIPhone(RESPONDER_B, uuid(9_022));
      responderC = await harness.bootstrapIPhone(RESPONDER_C, uuid(9_023));
      const far = await harness.bootstrapIPhone(FAR_DEVICE, uuid(9_024));
      await harness.publishResponderPosition(responderA.sessionToken, NEARBY_LATITUDE, NEARBY_LONGITUDE);
      await harness.publishResponderPosition(
        responderB.sessionToken,
        NEARBY_LATITUDE - 0.0002,
        NEARBY_LONGITUDE - 0.0001
      );
      await harness.publishResponderPosition(
        responderC.sessionToken,
        NEARBY_LATITUDE + 0.0002,
        NEARBY_LONGITUDE + 0.0002
      );
      await harness.publishResponderPosition(far.sessionToken, FAR_LATITUDE, FAR_LONGITUDE);

      deepEqual(await harness.events(far.sessionToken), [],
        "a 12 km-away standby device must see no event");
      equal((await harness.request(
        "GET",
        `/api/v2/events/${EVENT_ID}`,
        undefined,
        far.sessionToken
      )).status, 404, "a device outside the search ring must not read the event");
      equal((await harness.request(
        "GET",
        "/api/v2/me/nearby-volunteers",
        undefined,
        responderA.sessionToken
      )).status, 200, "a neutral, available iPhone must read the nearby summary");
      equal((await harness.request(
        "GET",
        "/api/v2/me/presence",
        undefined,
        responderA.sessionToken
      )).status, 200, "a neutral iPhone must read its own presence");
    });

    await step("S09", "recruitment offers reach nearby responders with no patient data", async () => {
      let offers = 0;
      for (const session of [responderA, responderB, responderC]) {
        if ((await harness.event(EVENT_ID, session.sessionToken)).pendingResponseRequest) offers += 1;
      }
      equal(offers, 3, "all three in-ring responders must receive a response request");
      const offered = await harness.event(EVENT_ID, responderA.sessionToken);
      equal(offered.viewerRelationship, "NEUTRAL",
        "a pending candidate must stay NEUTRAL until it accepts");
      equal(offered.canPublishEventPosition, false,
        "a pending candidate must not be allowed to write event positions");
      for (const sensitive of [
        "patientPosition",
        "patientLocationCard",
        "coordination",
        "fallDetectedAt",
        "fallResolution",
        "appHelpResponse",
        "callFirstObservedAt"
      ]) {
        check(!(sensitive in offered),
          `the pending candidate projection must not contain ${sensitive}`,
          JSON.stringify(offered).slice(0, 300));
      }
      check(typeof offered.pendingResponseRequest?.expiresAt === "string",
        "the offer must carry an explicit expiry");
    });

    await step("S10", "the patient iPhone sees its own event and stays subscribed", async () => {
      const patientView = await harness.event(EVENT_ID, patient.sessionToken);
      equal(patientView.viewerRelationship, "PATIENT", "the triggering iPhone must be the patient");
      equal(patientView.canPublishEventPosition, true,
        "the triggering iPhone must be allowed to write event positions");
      const patientSocket = await harness.connectIPhone(patient.sessionToken);
      sockets.push(patientSocket);
      await harness.events(patient.sessionToken);
      check(patientSocket.connected,
        "the patient Socket.IO session must stay connected while requests are served");
    });

    await step("S11", "accepting as responder A flips the projection and clears the offer", async () => {
      deliveryA = await harness.pendingDeliveryId(EVENT_ID, responderA.sessionToken);
      // DELIVERED must precede VIEWED, and a receipt may not be backdated behind
      // the response request, so the offer is acknowledged on a fresh slot.
      harness.setServerOffset(2);
      for (const status of ["DELIVERED", "VIEWED"] as const) {
        equal((await harness.request(
          "PUT",
          `/api/v2/events/${EVENT_ID}/deliveries/${deliveryA}/receipt`,
          { status, occurredAt: harness.iso(2) },
          responderA.sessionToken
        )).status, 200, `a ${status} delivery receipt must be accepted`);
      }
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/responses/${deliveryA}`,
        { decision: "ACCEPT", decidedAt: harness.iso(-1) },
        responderA.sessionToken
      )).status, 400, "a decision older than the event must return 400");
      const accepted = await harness.request<{
        decision: string;
        assignment: { id: string; role: string; status: string } | null;
      }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/responses/${deliveryA}`,
        { decision: "ACCEPT", decidedAt: harness.iso(2) },
        responderA.sessionToken
      );
      equal(accepted.status, 200, "ACCEPT must succeed inside the offer window");
      equal(accepted.body.decision, "ACCEPT", "the recorded decision must be ACCEPT");
      check(Boolean(accepted.body.assignment), "an accepted responder must receive an assignment");
      assignmentId = accepted.body.assignment!.id;
      check(["GO_TO_PATIENT", "FETCH_AED"].includes(accepted.body.assignment!.role),
        "the assignment role must be one of the two documented tasks",
        accepted.body.assignment!.role);

      const responderView = await harness.event(EVENT_ID, responderA.sessionToken);
      equal(responderView.viewerRelationship, "RESPONDER",
        "an accepted responder must be projected as RESPONDER");
      equal(responderView.pendingResponseRequest, null, "the accepted offer must be cleared");
      equal(responderView.canPublishEventPosition, true,
        "an accepted responder must be allowed to write event positions");
      check(responderView.patientPosition !== undefined,
        "an accepted responder may see the patient position");
      equal((await harness.request(
        "POST",
        `/api/v2/events/${EVENT_ID}/confirm-false-alarm`,
        {},
        responderA.sessionToken
      )).status, 403, "only the patient may end the event as a false alarm");
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/responses/${deliveryA}`,
        { decision: "ACCEPT", decidedAt: harness.iso(2) },
        responderA.sessionToken
      )).status, 200, "replaying the same ACCEPT must be idempotent");
    });

    await step("S12", "refusing as responder B keeps it out of the response", async () => {
      deliveryB = await harness.pendingDeliveryId(EVENT_ID, responderB.sessionToken);
      const refused = await harness.request<{ decision: string }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/responses/${deliveryB}`,
        { decision: "REFUSE", decidedAt: harness.iso(6) },
        responderB.sessionToken
      );
      equal(refused.status, 200, "REFUSE must succeed inside the offer window");
      equal(refused.body.decision, "REFUSE", "the recorded decision must be REFUSE");
      equal((await harness.request(
        "GET",
        `/api/v2/events/${EVENT_ID}`,
        undefined,
        responderB.sessionToken
      )).status, 404, "a refused responder must lose access to the event");
    });

    await step("S13", "event position batches write strict UTC second slots", async () => {
      // Server time moves past the slots the batch reports; a batch is only
      // accepted for slots that have already closed, and it may not be backdated
      // beyond the clock-skew allowance.
      harness.setServerOffset(6);
      const batchId = uuid(9_300);
      const batch = {
        schemaVersion: "2.0",
        eventId: EVENT_ID,
        batchId,
        records: [
          {
            recordId: uuid(9_301),
            slotAt: harness.iso(2),
            status: "FIX",
            fixObservedAt: new Date(Date.parse(harness.iso(2)) + 400).toISOString(),
            position: {
              kind: "P",
              latitude: PATIENT_LATITUDE,
              longitude: PATIENT_LONGITUDE,
              accuracyMeters: 7
            }
          },
          { recordId: uuid(9_302), slotAt: harness.iso(3), status: "NO_NEW_FIX", gapReason: "NO_FIX" },
          { recordId: uuid(9_303), slotAt: harness.iso(4), status: "NO_NEW_FIX", gapReason: "NO_FIX" }
        ]
      };
      const written = await harness.request<{ idempotent: boolean }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/position-batches/${batchId}`,
        batch,
        patient.sessionToken
      );
      equal(written.status, 200, "a batch of closed slots must be accepted");
      equal(written.body.idempotent, false, "the first batch write must not be idempotent");
      const replayed = await harness.request<{ idempotent: boolean }>(
        "PUT",
        `/api/v2/events/${EVENT_ID}/position-batches/${batchId}`,
        batch,
        patient.sessionToken
      );
      equal(replayed.status, 200, "replaying the same batch must succeed");
      equal(replayed.body.idempotent, true, "the batch replay must be reported idempotent");
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/position-batches/${uuid(9_310)}`,
        {
          schemaVersion: "2.0",
          eventId: EVENT_ID,
          batchId: uuid(9_310),
          records: Array.from({ length: 6 }, (_unused, index) => ({
            recordId: uuid(9_320 + index),
            slotAt: harness.iso(20 + index),
            status: "NO_NEW_FIX",
            gapReason: "NO_FIX"
          }))
        },
        patient.sessionToken
      )).status, 422, "a batch of six records must return 422");
      const openSlotBatchId = uuid(9_330);
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/position-batches/${openSlotBatchId}`,
        {
          schemaVersion: "2.0",
          eventId: EVENT_ID,
          batchId: openSlotBatchId,
          records: [
            { recordId: uuid(9_331), slotAt: harness.iso(20), status: "NO_NEW_FIX", gapReason: "NO_FIX" }
          ]
        },
        patient.sessionToken
      )).status, 425, "a batch for a slot that has not closed must return 425 and store nothing");
    });

    await step("S14", "Watch sessions stay scoped to their own triggering event", async () => {
      equal((await harness.request(
        "GET",
        `/api/v2/events/${EVENT_ID}`,
        undefined,
        watch.sessionToken
      )).status, 403, "the Watch session must not read the iPhone event projection");
      const state = await harness.request<{ state: string }>(
        "GET",
        `/api/v2/watch/events/${EVENT_ID}/state`,
        undefined,
        watch.sessionToken
      );
      equal(state.status, 200, "the Watch session must read its own event state");
      equal(state.body.state, "ACTIVE", "the Watch must observe the current event state");
      equal((await harness.request(
        "GET",
        `/api/v2/watch/events/${uuid(9_999)}/state`,
        undefined,
        watch.sessionToken
      )).status, 404, "a Watch must not be able to read an event it did not trigger");
    });

    await step("S15", "a stale offer stops being acceptable once its window closes", async () => {
      harness.setServerOffset(40);
      await settling;
      const expired = await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/responses/${deliveryB}`,
        { decision: "ACCEPT", decidedAt: harness.iso(40) },
        responderB.sessionToken
      );
      equal(expired.status, 409,
        "a refused delivery must never be acceptable again, even after the window closes");
    });

    await step("S16", "a second accept creates the FETCH_AED task and a route R -> A -> P", async () => {
      // `planAssignments(2)` yields one patient task and one AED task, so the
      // AED chain is only reachable with a second accepted responder.
      const closer = await harness.bootstrapIPhone(CLOSER_DEVICE, uuid(9_026));
      await harness.publishResponderPosition(
        closer.sessionToken,
        NEARBY_LATITUDE - 0.0001,
        NEARBY_LONGITUDE + 0.0001
      );
      const closerDelivery = await harness.pendingDeliveryId(EVENT_ID, closer.sessionToken);
      const accepted = await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/responses/${closerDelivery}`,
        { decision: "ACCEPT", decidedAt: harness.iso(40) },
        closer.sessionToken
      );
      equal(accepted.status, 200, "a second responder must be able to accept inside the window");

      // Who receives FETCH_AED is the route planner's choice, not a fixed
      // ordering, so resolve both accepted responders and require exactly one
      // AED task carrying a strictly ordered responder -> AED -> patient path.
      const closerView = await harness.request<EventProjection>(
        "GET",
        `/api/v2/events/${EVENT_ID}`,
        undefined,
        closer.sessionToken
      );
      equal(closerView.status, 200, "the second accepted responder must read the event");
      const firstView = await harness.event(EVENT_ID, responderA.sessionToken);
      const holders: Array<{ token: string; view: EventProjection }> = [
        { token: closer.sessionToken, view: closerView.body },
        { token: responderA.sessionToken, view: firstView }
      ];
      const roles = holders.map(holder => holder.view.currentAssignment?.role ?? "NONE").sort();
      deepEqual(roles, ["FETCH_AED", "GO_TO_PATIENT"],
        "two accepted responders must split into one AED task and one patient task");
      const aedHolder = holders.find(holder => holder.view.currentAssignment?.role === "FETCH_AED")!;
      const assignment = aedHolder.view.currentAssignment!;
      aedAssignmentId = assignment.id;
      check(Boolean(assignment.route), "a FETCH_AED task must carry an AED route");
      const routeKinds = assignment.route!.path.map(position => position.kind);
      aedId = assignment.route!.aedId;
      equal(routeKinds[0], "R", "the AED route must start at the responder");
      equal(routeKinds[1], "A", `the AED route must pass through the AED (${aedId})`);
      equal(routeKinds[2], "P", "the AED route must end at the patient");

      const aedSocket = await harness.connectIPhone(aedHolder.token);
      sockets.push(aedSocket);
      const acquiredEvent = harness.nextSocketEvent(aedSocket, "aed:acquired", "S16");
      harness.setServerOffset(41);
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/assignments/${aedAssignmentId}/status`,
        { status: "EN_ROUTE", occurredAt: harness.iso(41) },
        aedHolder.token
      )).status, 200, "FETCH_AED must advance to EN_ROUTE");
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/assignments/${aedAssignmentId}/status`,
        { status: "ARRIVED_AT_AED", occurredAt: harness.iso(41) },
        aedHolder.token
      )).status, 200, "FETCH_AED must advance to ARRIVED_AT_AED");
      harness.setServerOffset(42);
      const receipt = {
        receiptId: uuid(9_410),
        eventId: EVENT_ID,
        assignmentId: aedAssignmentId,
        aedId,
        acquiredAt: harness.iso(42)
      };
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/assignments/${aedAssignmentId}/aed-acquired`,
        receipt,
        aedHolder.token
      )).status, 201, "the first AED_ACQUIRED receipt must be created");
      equal((await harness.request(
        "PUT",
        `/api/v2/events/${EVENT_ID}/assignments/${aedAssignmentId}/aed-acquired`,
        receipt,
        aedHolder.token
      )).status, 200, "replaying the same AED_ACQUIRED receipt must be idempotent");
      const push = await acquiredEvent;
      equal(push.eventId, EVENT_ID, "the AED receipt must notify the participants");
      equal(push.receiptId, receipt.receiptId, "the notification must carry the receipt id");
      const view = await harness.event(EVENT_ID, aedHolder.token);
      equal(view.currentAssignment?.status, "AED_ACQUIRED",
        "the assignment must record the AED as acquired");
      equal(view.currentAssignment?.aedAcquiredReceipt?.receiptId, receipt.receiptId,
        "the projection must expose the stored receipt");
    });

    await step("S17", "patient ends the event and every participant converges", async () => {
      responderSocket = await harness.connectIPhone(responderA.sessionToken);
      sockets.push(responderSocket);
      const resolved = await harness.request<EventProjection>(
        "POST",
        `/api/v2/events/${EVENT_ID}/resolve`,
        {
          resolutionId: uuid(9_400),
          actor: "PATIENT",
          resolvedAt: harness.iso(40),
          note: "smoke resolve"
        },
        patient.sessionToken
      );
      equal(resolved.status, 200, "the patient must be able to resolve the event");
      equal(resolved.body.state, "RESOLVED", "resolution must move the event to RESOLVED");
      equal(resolved.body.eventPositionParticipationStartedAt, harness.iso(0),
        "the participation window must open at event creation");
      check(typeof resolved.body.eventPositionParticipationEndedAt === "string",
        "the participation window must close at resolution");
      equal((await harness.request(
        "POST",
        `/api/v2/events/${EVENT_ID}/resolve`,
        {
          resolutionId: uuid(9_400),
          actor: "PATIENT",
          resolvedAt: harness.iso(40),
          note: "smoke resolve"
        },
        patient.sessionToken
      )).status, 200, "replaying the same resolution must be idempotent");
      equal((await harness.request(
        "POST",
        `/api/v2/events/${EVENT_ID}/resolve`,
        { resolutionId: uuid(9_401), actor: "PATIENT", resolvedAt: harness.iso(41) },
        patient.sessionToken
      )).status, 409, "a second, different resolution must return 409");

      const resolvedView = await harness.event(EVENT_ID, responderA.sessionToken);
      equal(resolvedView.state, "RESOLVED", "active participants must see the terminal state");
      equal(resolvedView.canPublishEventPosition, false,
        "a terminal event must stop accepting new event positions");
      const timeline = await harness.request<Array<{ kind: string }>>(
        "GET",
        `/api/v2/events/${EVENT_ID}/timeline`,
        undefined,
        patient.sessionToken
      );
      equal(timeline.status, 200, "participants must read the recovery timeline");
      const kinds = timeline.body.map(entry => entry.kind);
      check(kinds.includes("EVENT_RESOLVED"), "the timeline must record EVENT_RESOLVED", kinds.join(","));
      check(!kinds.includes("WATCH_FALL_HELP_CONFIRMED"),
        "internal audit kinds must not leak into the recovery timeline", kinds.join(","));
    });

    await step("S18", "oversized request bodies are rejected at the 16 KiB boundary", async () => {
      const oversized = await harness.request(
        "PUT",
        `/api/v2/me/responder-position`,
        {
          positionUpdateId: uuid(9_500),
          observedAt: harness.iso(40),
          responderPosition: {
            kind: "R",
            latitude: NEARBY_LATITUDE,
            longitude: NEARBY_LONGITUDE,
            accuracyMeters: 10
          },
          padding: "x".repeat(20_000)
        },
        responderA.sessionToken
      );
      equal(oversized.status, 413, "a body beyond 16 KiB must return 413");
    });

    console.log("");
    const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
    console.log(`backend smoke passed: ${results.length} steps in ${totalMs} ms`);
    console.log(
      `event ${EVENT_ID} -> RESOLVED (accepted assignment ${assignmentId}, `
      + `AED task ${aedAssignmentId || "none"} -> ${aedId || "none"}, `
      + `offers ${deliveryA} / ${deliveryB})`
    );
  } catch (error) {
    console.log("");
    console.log(`FAIL  ${current.id}  ${current.title}`);
    if (error instanceof Error && error.name === "SmokeFailure") {
      console.log(`      ${error.message}`);
      const detail = (error as { detail?: string }).detail;
      if (detail) console.log(`      ${detail}`);
    } else {
      console.log(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      if (error instanceof Error && error.stack) {
        console.log(error.stack.split("\n").slice(1, 6).join("\n"));
      }
    }
    console.log(`      steps passed before the failure: ${results.length}`);
    throw error;
  } finally {
    for (const socket of sockets) socket.disconnect();
    await harness.stop();
  }
}

await run();
