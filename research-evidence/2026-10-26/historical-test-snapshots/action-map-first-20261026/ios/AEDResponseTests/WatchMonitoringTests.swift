import Foundation
import Security
import XCTest
@testable import AEDResponseWatchLogic

@MainActor
final class WatchMonitoringTests: XCTestCase {
    private let fallDate = Date(timeIntervalSince1970: 1_788_000_000)

    func testTriggerPreservesOldFixTimeThroughEncodingAndStableRetry() async throws {
        let fixTime = fallDate.addingTimeInterval(-700.125)
        let reporter = MemoryWatchReporter(shouldFail: true)
        let snapshot = WatchPositionSnapshot(
            patientPosition: try PatientPosition(latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12),
            unavailableReason: nil,
            observedAt: fixTime
        )
        let h = makeHarness(reporter: reporter, snapshot: snapshot)
        _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        _ = await h.coordinator.answer(eventID: h.eventID, response: .needsHelp,
                                       answeredAt: fallDate.addingTimeInterval(1))
        let first = try XCTUnwrap(h.outbox.pending(now: fallDate).first)
        XCTAssertEqual(first.patientPositionObservedAt, fixTime)
        XCTAssertEqual(first.fallDetectedAt, fallDate)
        let encoded = try JSONEncoder.contractEncoder().encode(first)
        let decoded = try JSONDecoder.contractDecoder().decode(WatchEmergencyObservation.self, from: encoded)
        XCTAssertEqual(decoded.patientPositionObservedAt, fixTime)
        var legacyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        legacyJSON.removeValue(forKey: "patientPositionObservedAt")
        let legacyData = try JSONSerialization.data(withJSONObject: legacyJSON)
        let legacy = try JSONDecoder.contractDecoder().decode(WatchEmergencyObservation.self, from: legacyData)
        XCTAssertNil(legacy.patientPositionObservedAt)
        let replayJSON = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder.contractEncoder().encode(legacy)
        ) as? [String: Any])
        XCTAssertNil(replayJSON["patientPositionObservedAt"])
        await reporter.setShouldFail(false)
        _ = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(1))
        let reported = await reporter.allObservations()
        XCTAssertEqual(reported.count, 2)
        XCTAssertEqual(reported[0], reported[1])
        XCTAssertTrue(try h.outbox.pending(now: fallDate).isEmpty)
    }

    func testNeedsHelpReportsImmediatelyWithoutWaitingForCall() async throws {
        let harness = makeHarness()
        let question = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        XCTAssertEqual(question, .helpQuestion(eventID: harness.eventID))

        let result = await harness.coordinator.answer(
            eventID: harness.eventID,
            response: .needsHelp,
            answeredAt: fallDate.addingTimeInterval(1)
        )
        XCTAssertEqual(
            result,
            .reported(eventID: harness.eventID, fallDetectedAt: fallDate)
        )
        let firstObservation = await harness.reporter.firstObservation()
        let observation = try XCTUnwrap(firstObservation)
        XCTAssertEqual(observation.observationKind, .fallContext)
        XCTAssertEqual(observation.appHelpResponse, .needsHelp)
        XCTAssertEqual(observation.fallResolution, .confirmed)
        XCTAssertNil(observation.callFirstObservedAt)
        XCTAssertNil(observation.callObservationSemantics)
        let reportCount = await harness.reporter.reportCount()
        XCTAssertEqual(reportCount, 1)
    }

    func testDeclinedClearsContextAndNeverReportsOrReprompts() async {
        let harness = makeHarness()
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .dismissed)
        )
        let result = await harness.coordinator.answer(
            eventID: harness.eventID,
            response: .declined,
            answeredAt: fallDate.addingTimeInterval(1)
        )
        XCTAssertEqual(result, .declined(eventID: harness.eventID))
        let reportCount = await harness.reporter.reportCount()
        XCTAssertEqual(reportCount, 0)
        XCTAssertTrue(harness.outbox.isMarked(eventID: harness.eventID, now: fallDate.addingTimeInterval(2)))
        let duplicate = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        XCTAssertEqual(duplicate, .ignored)
    }

    func testUnansweredNewOutgoingCallAtExactly120SecondsReportsNoResponse() async throws {
        let harness = makeHarness()
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .unresponsive)
        )
        let result = await harness.coordinator.receive(
            call: OutgoingCallSignal(
                callID: "call-at-120",
                firstObservedAt: fallDate.addingTimeInterval(120),
                isOutgoing: true
            )
        )
        XCTAssertEqual(
            result,
            .reported(eventID: harness.eventID, fallDetectedAt: fallDate)
        )
        let firstObservation = await harness.reporter.firstObservation()
        let observation = try XCTUnwrap(firstObservation)
        XCTAssertEqual(observation.appHelpResponse, .noResponse)
        XCTAssertEqual(observation.callFirstObservedAt, fallDate.addingTimeInterval(120))
        XCTAssertEqual(observation.callObservationSemantics, .firstObservedOutgoingState)
        XCTAssertEqual(observation.fallResolution, .unresponsive)
    }

    func testOutgoingCallAfter120SecondsDoesNotReport() async {
        let harness = makeHarness()
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .unknown)
        )
        let result = await harness.coordinator.receive(
            call: OutgoingCallSignal(
                callID: "call-after-120",
                firstObservedAt: fallDate.addingTimeInterval(120.001),
                isOutgoing: true
            )
        )
        XCTAssertEqual(result, .ignored)
        let reportCount = await harness.reporter.reportCount()
        XCTAssertEqual(reportCount, 0)
    }

    func testIncomingAndDuplicateCallsAreIgnoredAndCallOutcomeIsNotUsed() async {
        let harness = makeHarness()
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        let incoming = await harness.coordinator.receive(
            call: OutgoingCallSignal(
                callID: "incoming",
                firstObservedAt: fallDate.addingTimeInterval(1),
                isOutgoing: false
            )
        )
        XCTAssertEqual(incoming, .ignored)

        let outgoing = OutgoingCallSignal(
            callID: "outgoing",
            firstObservedAt: fallDate.addingTimeInterval(2),
            isOutgoing: true
        )
        _ = await harness.coordinator.receive(call: outgoing)
        let duplicate = await harness.coordinator.receive(call: outgoing)
        XCTAssertEqual(duplicate, .ignored)
        let reportCount = await harness.reporter.reportCount()
        XCTAssertEqual(reportCount, 1)
    }

    func testPendingContextIsRestoredAndQuestionIsPresentedOnlyOnce() async {
        let eventState = MemoryFallEventState(eventID: "event-restored")
        let context = PersistedFallContext(
            eventID: "event-restored",
            fallDetectedAt: fallDate,
            fallResolution: .confirmed
        )
        eventState.storePendingContext(context)
        let outbox = MemoryObservationOutbox()
        let reporter = MemoryWatchReporter()
        let coordinator = FallEmergencyCoordinator(
            eventState: eventState,
            outbox: outbox,
            reporter: reporter,
            positionProvider: FixedWatchPositionProvider(),
            now: { Date(timeIntervalSince1970: 1_788_000_001) }
        )

        let duplicate = await coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        XCTAssertEqual(duplicate, .waitingForHelp(eventID: "event-restored"))
        let reportCount = await reporter.reportCount()
        XCTAssertEqual(reportCount, 0)
    }

    func testFailedReportRetriesBefore35MinutesAndLeavesOnlyDedupeMarkerAfterACK() async {
        let reporter = MemoryWatchReporter(shouldFail: true)
        let harness = makeHarness(reporter: reporter)
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        let queued = await harness.coordinator.answer(
            eventID: harness.eventID,
            response: .needsHelp,
            answeredAt: fallDate.addingTimeInterval(1)
        )
        XCTAssertEqual(
            queued,
            .queuedForRetry(eventID: harness.eventID, fallDetectedAt: fallDate)
        )
        XCTAssertEqual(try? harness.outbox.pending(now: fallDate).count, 1)

        await reporter.setShouldFail(false)
        let retryResults = await harness.coordinator.retryPending(
            at: fallDate.addingTimeInterval(34 * 60)
        )
        XCTAssertEqual(
            retryResults,
            [.reported(eventID: harness.eventID, fallDetectedAt: fallDate)]
        )
        XCTAssertTrue((try? harness.outbox.pending(now: fallDate.addingTimeInterval(34 * 60)))?.isEmpty == true)
        XCTAssertTrue(
            harness.outbox.isMarked(
                eventID: harness.eventID,
                now: fallDate.addingTimeInterval(35 * 60)
            )
        )
    }

    func testExpiredPendingPayloadIsNotSentAfter35Minutes() async {
        let reporter = MemoryWatchReporter(shouldFail: true)
        let harness = makeHarness(reporter: reporter)
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        _ = await harness.coordinator.answer(
            eventID: harness.eventID,
            response: .needsHelp,
            answeredAt: fallDate.addingTimeInterval(1)
        )
        let result = await harness.coordinator.retryPending(
            at: fallDate.addingTimeInterval(35 * 60 + 0.001)
        )
        XCTAssertEqual(result, [.queuedForRetry(eventID: harness.eventID, fallDetectedAt: fallDate)])
        let reportCount = await reporter.reportCount()
        XCTAssertEqual(reportCount, 1)
        XCTAssertEqual(try? harness.outbox.pending(now: fallDate.addingTimeInterval(35 * 60 + 1)).count, 1,
            "The creation deadline cannot delete an unconfirmed original observation")
    }

    func testPendingExpirySuppressesRepeatedCoreMotionCallback() async {
        let harness = makeHarness()
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .unknown)
        )
        await harness.coordinator.expirePending(at: fallDate.addingTimeInterval(120.001))
        let duplicate = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .unknown)
        )
        XCTAssertEqual(duplicate, .ignored)
        let reportCount = await harness.reporter.reportCount()
        XCTAssertEqual(reportCount, 0)
        XCTAssertTrue(
            harness.outbox.isMarked(
                eventID: harness.eventID,
                now: fallDate.addingTimeInterval(121)
            )
        )
    }

    func testDedupeMarkerIsInclusiveAt24HoursThenExpires() async {
        let outbox = MemoryObservationOutbox()
        try? outbox.acknowledge(eventID: "event-24h", at: fallDate)
        XCTAssertTrue(
            outbox.isMarked(
                eventID: "event-24h",
                now: fallDate.addingTimeInterval(24 * 60 * 60)
            )
        )
        XCTAssertFalse(
            outbox.isMarked(
                eventID: "event-24h",
                now: fallDate.addingTimeInterval(24 * 60 * 60 + 0.001)
            )
        )
    }

    func testPersistenceFailureNeverReportsOrClaimsQueued() async {
        let outbox = MemoryObservationOutbox(failStores: true)
        let reporter = MemoryWatchReporter()
        let harness = makeHarness(outbox: outbox, reporter: reporter)
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        let result = await harness.coordinator.answer(
            eventID: harness.eventID,
            response: .needsHelp,
            answeredAt: fallDate.addingTimeInterval(1)
        )
        XCTAssertEqual(result, .persistenceFailed(eventID: harness.eventID))
        let reportCount = await reporter.reportCount()
        XCTAssertEqual(reportCount, 0)
        XCTAssertEqual(harness.eventState.pendingContexts(now: fallDate), [
            PersistedFallContext(eventID: harness.eventID, fallDetectedAt: fallDate,
                fallResolution: .confirmed, sourceBinding: String(repeating: "a", count: 64))
        ])
    }

    func testCorruptUserDefaultsFallContextFailsClosedWithoutReplacingOriginalBytes() async {
        let suiteName = "aedresponse-d3-fall-corrupt-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let key = "aedresponse.watch.v2.fall-event-state"
        let original = Data("corrupt-fall-context".utf8)
        defaults.set(original, forKey: key)
        let reporter = MemoryWatchReporter()
        let eventState = UserDefaultsFallEventStateStore(defaults: defaults)
        let outbox = MemoryObservationOutbox()
        let coordinator = FallEmergencyCoordinator(eventState: eventState, outbox: outbox,
            reporter: reporter, positionProvider: FixedWatchPositionProvider(),
            now: { Date(timeIntervalSince1970: 1_788_000_000) })
        let result = await coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        XCTAssertEqual(result, .persistenceFailed(eventID: "event-state"))
        XCTAssertEqual(defaults.data(forKey: key), original)
        XCTAssertTrue(try! outbox.pending(now: fallDate).isEmpty)
    }

    func testWrongUserDefaultsFallContextTypeFailsClosedWithoutTreatingItAsMissing() async throws {
        let suiteName = "aedresponse-d3-fall-wrong-type-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let key = "aedresponse.watch.v2.fall-event-state"
        defaults.set("wrong-type", forKey: key)
        let coordinator = FallEmergencyCoordinator(
            eventState: UserDefaultsFallEventStateStore(defaults: defaults),
            outbox: MemoryObservationOutbox(), reporter: MemoryWatchReporter(),
            positionProvider: FixedWatchPositionProvider(), now: { Date(timeIntervalSince1970: 1_788_000_000) }
        )
        let result = await coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        XCTAssertEqual(result, .persistenceFailed(eventID: "event-state"))
        XCTAssertEqual(defaults.object(forKey: key) as? String, "wrong-type")
    }

    func testExpiredContextRemainsWhenDedupePersistenceFails() async {
        let outbox = MemoryObservationOutbox(failStores: true)
        let harness = makeHarness(outbox: outbox)
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        _ = await harness.coordinator.expirePending(at: fallDate.addingTimeInterval(121))
        XCTAssertEqual(harness.eventState.pendingContexts(now: fallDate), [
            PersistedFallContext(eventID: harness.eventID, fallDetectedAt: fallDate,
                fallResolution: .confirmed, sourceBinding: String(repeating: "a", count: 64))
        ])
    }

    func testDurableQueuedObservationOutlivesHelpContextWithoutBlockingLaterFall() async throws {
        let suiteName = "aedresponse-d3-queued-context-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let service = "aedresponse-d3-queued-context-\(UUID().uuidString)"
        let cleanup: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service]
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            SecItemDelete(cleanup as CFDictionary)
        }
        let clock = D3MutableDate(fallDate)
        let eventState = UserDefaultsFallEventStateStore(defaults: defaults)
        let outbox = KeychainObservationOutbox(service: service)
        let reporter = MemoryWatchReporter(shouldFail: true)
        let coordinator = FallEmergencyCoordinator(eventState: eventState, outbox: outbox,
            reporter: reporter, positionProvider: FixedWatchPositionProvider(), now: { clock.now() })
        let firstID = try eventState.eventID(for: fallDate)
        let firstResult = await coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        XCTAssertEqual(firstResult, .helpQuestion(eventID: firstID))
        let queuedResult = await coordinator.answer(eventID: firstID, response: .needsHelp, answeredAt: fallDate)
        XCTAssertEqual(queuedResult, .queuedForRetry(eventID: firstID, fallDetectedAt: fallDate))
        XCTAssertEqual(try outbox.pending(now: fallDate).count, 1)

        clock.set(fallDate.addingTimeInterval(121))
        let expired = await coordinator.expirePending(at: clock.now())
        XCTAssertTrue(expired.isEmpty, "The help context was handed off when the outbox write succeeded")
        XCTAssertTrue(try eventState.pendingContexts(now: clock.now()).isEmpty)
        XCTAssertEqual(try outbox.pending(now: clock.now()).count, 1)

        let secondDate = fallDate.addingTimeInterval(240)
        let secondID = try eventState.eventID(for: secondDate)
        let second = await coordinator.receive(fall: FallDetectionSignal(detectedAt: secondDate, resolution: .confirmed))
        XCTAssertEqual(second, .helpQuestion(eventID: secondID))
    }

    func testDurableOutboxHandoffPreventsSecondAnswerFromSuppressingInFlightObservation() async throws {
        let reporter = MemoryWatchReporter()
        let harness = makeHarness(reporter: reporter)
        _ = await harness.coordinator.receive(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed)
        )
        await reporter.suspendNextReport()
        let first = Task {
            await harness.coordinator.answer(eventID: harness.eventID, response: .needsHelp, answeredAt: fallDate)
        }
        for _ in 0..<200 {
            if await reporter.isSuspended() { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let suspended = await reporter.isSuspended()
        XCTAssertTrue(suspended)
        let second = await harness.coordinator.answer(eventID: harness.eventID, response: .declined, answeredAt: fallDate)
        XCTAssertEqual(second, .ignored)
        await reporter.release()
        let firstResult = await first.value
        XCTAssertEqual(firstResult, .reported(eventID: harness.eventID, fallDetectedAt: fallDate))
        XCTAssertTrue(try harness.outbox.pending(now: fallDate).isEmpty)
    }

    func testProtectedTriggerRetainsOriginalAfterDeadlineAndRefusesOverwrite() throws {
        let service = "aedresponse-c4c-\(UUID().uuidString)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "watch-trigger-outbox"]
        defer { SecItemDelete(query as CFDictionary) }
        let id = "REDACTED-SUPPLEMENT-ID-3baceddd153b"
        let original = WatchEmergencyObservation(eventId: id, fallDetectedAt: fallDate,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil,
            locationUnavailableReason: "ORIGINAL_UNCONFIRMED_FACT")
        let outbox = KeychainObservationOutbox(service: service)
        try outbox.store(original)
        let later = fallDate.addingTimeInterval(7 * 24 * 60 * 60)
        try outbox.pruneDedupeMarkers(now: later)
        let reopened = KeychainObservationOutbox(service: service)
        XCTAssertEqual(try reopened.pending(now: later), [original])
        try reopened.retainRejected(eventID: id, status: 409)
        XCTAssertEqual(try KeychainObservationOutbox(service: service).rejectedStatus(eventID: id), 409)
        let changed = WatchEmergencyObservation(eventId: id, fallDetectedAt: fallDate,
            fallResolution: .dismissed, appHelpResponse: .needsHelp, patientPosition: nil,
            locationUnavailableReason: "DIFFERENT_CONTENT")
        XCTAssertThrowsError(try reopened.store(changed))
        XCTAssertThrowsError(try reopened.suppress(eventID: id, at: later))
        XCTAssertEqual(try reopened.pending(now: later), [original])
        XCTAssertTrue(try reopened.hasDedupeMarker(eventID: id, now: later))
        try reopened.acknowledge(eventID: id, at: later)
        XCTAssertTrue(try KeychainObservationOutbox(service: service).pending(now: later).isEmpty)
        XCTAssertEqual(try KeychainObservationOutbox(service: service).confirmedEventIDs(), [id],
            "ACK must durably hand off the event reference before deleting the raw retry body")
    }

    func testRestoredUnattributedTriggerCannotCreateUnderFreshDeviceSession() async throws {
        let service = "aedresponse-d2-\(UUID().uuidString)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        defer { SecItemDelete(query as CFDictionary) }
        let suiteName = "aedresponse-d2-config-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let original = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: fallDate,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil,
            locationUnavailableReason: "OLD_UNCONFIRMED_FACT")
        try KeychainObservationOutbox(service: service).store(original)
        let configuration = WatchConfigurationStore(defaults: defaults)
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: UUID().uuidString)
        let current = configuration.load()
        let keys = WatchKeychainStore(service: service)
        try keys.saveAuthSession(WatchAuthSession(accessToken: "NEW_DEVICE_ACCESS", refreshToken: "NEW_DEVICE_REFRESH",
            expiresAt: fallDate.addingTimeInterval(3600), baseURL: "https://watch.example.test/api/v2/",
            deviceInstanceID: current.deviceInstanceID, companionPairID: current.companionPairID,
            userID: "new-user", accountID: "new-account"))
        let transport = D2CreationRecordingTransport()
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: keys, appAttestKeyStore: keys, now: { Date(timeIntervalSince1970: 1_788_000_000) })
        let restored = KeychainObservationOutbox(service: service)
        let coordinator = FallEmergencyCoordinator(eventState: MemoryFallEventState(eventID: original.eventId),
            outbox: restored, reporter: reporter, positionProvider: FixedWatchPositionProvider(),
            now: { Date(timeIntervalSince1970: 1_788_000_000) })
        _ = await coordinator.retryPending(at: fallDate.addingTimeInterval(1))
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.httpMethod), ["GET"])
        XCTAssertFalse(requests.contains { $0.httpMethod == "PUT" }, "Unknown origin cannot authorize creation under a new device session")
        XCTAssertEqual(try restored.pending(now: fallDate), [original], "The original fact must remain recoverable")
    }

    func testProtectedTriggerSourceSurvivesRestartAndOnlyOriginalSourceMayRetry() async throws {
        let service = "aedresponse-d2-bound-\(UUID().uuidString)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        defer { SecItemDelete(query as CFDictionary) }
        let id = UUID().uuidString
        let reporter = MemoryWatchReporter(shouldFail: true)
        let capturedBinding = await reporter.observationSourceBinding()
        let originalBinding = try XCTUnwrap(capturedBinding)
        let outbox = KeychainObservationOutbox(service: service)
        let coordinator = FallEmergencyCoordinator(eventState: MemoryFallEventState(eventID: id), outbox: outbox,
            reporter: reporter, positionProvider: FixedWatchPositionProvider(), now: { Date(timeIntervalSince1970: 1_788_000_000) })
        _ = await coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        _ = await coordinator.answer(eventID: id, response: .needsHelp, answeredAt: fallDate)
        let original = try XCTUnwrap(outbox.pending(now: fallDate).first)
        let reopened = KeychainObservationOutbox(service: service)
        XCTAssertEqual(try reopened.sourceBinding(eventID: id), originalBinding)
        XCTAssertThrowsError(try reopened.store(original, sourceBinding: String(repeating: "b", count: 64)))
        XCTAssertThrowsError(try reopened.store(original), "An immutable known origin cannot become unknown")
        await reporter.setShouldFail(false)
        await reporter.changeSource(String(repeating: "b", count: 64))
        let restored = FallEmergencyCoordinator(eventState: MemoryFallEventState(eventID: id), outbox: reopened,
            reporter: reporter, positionProvider: FixedWatchPositionProvider(), now: { Date(timeIntervalSince1970: 1_788_000_000) })
        let denied = await restored.retryPending(at: fallDate.addingTimeInterval(5))
        XCTAssertEqual(denied, [.authorizationRequired(eventID: id)])
        let deniedCount = await reporter.reportCount()
        XCTAssertEqual(deniedCount, 1)
        XCTAssertEqual(try reopened.pending(now: fallDate), [original])
        await reporter.changeSource(originalBinding)
        let recovered = await restored.retryPending(at: fallDate.addingTimeInterval(6))
        XCTAssertEqual(recovered, [.reported(eventID: id, fallDetectedAt: fallDate)])
        let sent = await reporter.allObservations()
        XCTAssertEqual(sent, [original, original])
        XCTAssertEqual(try reopened.confirmedEventIDs(), [id])
        XCTAssertEqual(try reopened.sourceBinding(eventID: id), originalBinding)
    }

    func testFallContextSourceCannotFollowIdentityChangedBeforeAnswer() async throws {
        let reporter = MemoryWatchReporter()
        let h = makeHarness(reporter: reporter)
        _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        let saved = try XCTUnwrap(h.eventState.pendingContexts(now: fallDate).first)
        let decoded = try JSONDecoder.contractDecoder().decode(PersistedFallContext.self,
            from: JSONEncoder.contractEncoder().encode(saved))
        XCTAssertEqual(decoded.sourceBinding, String(repeating: "a", count: 64))
        await reporter.changeSource(String(repeating: "b", count: 64))
        let result = await h.coordinator.answer(eventID: h.eventID, response: .needsHelp, answeredAt: fallDate)
        XCTAssertEqual(result, .authorizationRequired(eventID: h.eventID))
        let sent = await reporter.reportCount()
        XCTAssertEqual(sent, 0)
        XCTAssertEqual(try h.outbox.pending(now: fallDate).count, 1)
        XCTAssertEqual(try h.outbox.sourceBinding(eventID: h.eventID), decoded.sourceBinding)
    }

    func testExplicitNullSourceCollectionMustNotBeRewrittenAsUnknownLegacyOrigin() throws {
        let service = "aedresponse-d2-review-\(UUID().uuidString)"
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "watch-trigger-outbox"]
        defer { SecItemDelete(base as CFDictionary) }
        let at = Date(timeIntervalSince1970: 1_788_000_000)
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: at,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "KNOWN_SOURCE_FACT")
        let outbox = KeychainObservationOutbox(service: service)
        try outbox.store(observation, sourceBinding: String(repeating: "a", count: 64))
        var read = base; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var raw: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &raw), errSecSuccess)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(raw as? Data)) as? [String: Any])
        object["sourceBindingsByEventID"] = NSNull()
        let corrupted = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        XCTAssertEqual(SecItemUpdate(base as CFDictionary, [kSecValueData as String: corrupted] as CFDictionary), errSecSuccess)
        let reopened = KeychainObservationOutbox(service: service)
        XCTAssertThrowsError(try reopened.pending(now: at), "Explicit null is malformed metadata, not an older absent field")
        XCTAssertThrowsError(try reopened.pruneDedupeMarkers(now: at), "Maintenance must not silently erase malformed origin metadata")
        var after: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &after), errSecSuccess)
        XCTAssertEqual(after as? Data, corrupted, "Retain original protected bytes for diagnosis and recovery")
    }

    func testMalformedSourceMetadataPreservesProtectedQueueBytes() throws {
        let service = "aedresponse-d2-corrupt-\(UUID().uuidString)"
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "watch-trigger-outbox"]
        defer { SecItemDelete(query as CFDictionary) }
        let original = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: fallDate,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "PRESERVE")
        var state = WatchObservationQueueState()
        state.pending[original.eventId] = original
        state.sourceBindingsByEventID[original.eventId] = "invalid-fingerprint"
        let bytes = try JSONEncoder.contractEncoder().encode(state)
        query[kSecValueData as String] = bytes
        XCTAssertEqual(SecItemAdd(query as CFDictionary, nil), errSecSuccess)
        query.removeValue(forKey: kSecValueData as String)
        let outbox = KeychainObservationOutbox(service: service)
        XCTAssertThrowsError(try outbox.pending(now: fallDate))
        XCTAssertThrowsError(try outbox.store(original, sourceBinding: String(repeating: "a", count: 64)))
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, bytes)
    }

    func testLostTriggerACKRecoversExistingTerminalAfterDeadlineUsingIdenticalBody() async throws {
        let reporter = MemoryWatchReporter(shouldFail: true)
        let h = makeHarness(reporter: reporter)
        _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        _ = await h.coordinator.answer(eventID: h.eventID, response: .needsHelp, answeredAt: fallDate)
        let original = try XCTUnwrap(h.outbox.pending(now: fallDate).first)
        await reporter.setState(WatchEventStateSnapshot(eventId: h.eventID, state: .resolved,
            createdAt: fallDate, resolvedAt: fallDate.addingTimeInterval(100)))
        await reporter.setShouldFail(false)
        let results = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(3600))
        XCTAssertEqual(results, [.reported(eventID: h.eventID, fallDetectedAt: fallDate)])
        let sent = await reporter.allObservations()
        XCTAssertEqual(sent, [original, original])
        XCTAssertTrue(try h.outbox.pending(now: fallDate).isEmpty)
    }

    func testExistingStateDoesNotAcknowledgeConflictingObservation() async throws {
        let reporter = MemoryWatchReporter(shouldFail: true)
        let h = makeHarness(reporter: reporter)
        _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        _ = await h.coordinator.answer(eventID: h.eventID, response: .needsHelp, answeredAt: fallDate)
        await reporter.setState(WatchEventStateSnapshot(eventId: h.eventID, state: .resolved,
            createdAt: fallDate, resolvedAt: fallDate.addingTimeInterval(100)))
        await reporter.setShouldFail(false)
        await reporter.setRejection(409)
        let results = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(3600))
        XCTAssertEqual(results, [.requiresReview(eventID: h.eventID, status: 409)])
        _ = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(7200))
        let count = await reporter.reportCount()
        XCTAssertEqual(count, 2, "A known state is not proof of matching observation content")
        XCTAssertEqual(try h.outbox.pending(now: fallDate).count, 1)
    }

    func testTriggerPermissionFailureWaitsForNewAuthorizationAndTransientRetryBacksOff() async throws {
        for status in [403, 503] {
            let reporter = MemoryWatchReporter()
            await reporter.setRejection(status)
            let h = makeHarness(reporter: reporter)
            _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
            _ = await h.coordinator.answer(eventID: h.eventID, response: .needsHelp, answeredAt: fallDate)
            _ = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(0.5))
            let firstCount = await reporter.reportCount()
            XCTAssertEqual(firstCount, 1)
            if status == 403 {
                _ = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(100))
                let deniedCount = await reporter.reportCount()
                XCTAssertEqual(deniedCount, 1)
                await reporter.changeAuthorization()
            }
            await reporter.setRejection(nil)
            let recovered = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(101))
            XCTAssertEqual(recovered, [.reported(eventID: h.eventID, fallDetectedAt: fallDate)])
            let sent = await reporter.allObservations()
            XCTAssertEqual(sent.count, 2)
            XCTAssertEqual(sent.first, sent.last)
        }
    }

    func testConcurrentTriggerRetryAndOldAuthorizationCannotACK() async throws {
        let reporter = MemoryWatchReporter()
        let h = makeHarness(reporter: reporter)
        _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        await reporter.suspendNextReport()
        let request = Task { await h.coordinator.answer(eventID: h.eventID, response: .needsHelp, answeredAt: fallDate) }
        for _ in 0..<200 { if await reporter.isSuspended() { break }; try await Task.sleep(for: .milliseconds(2)) }
        guard await reporter.isSuspended() else { request.cancel(); XCTFail("Report did not suspend"); return }
        _ = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(1))
        let count = await reporter.reportCount()
        XCTAssertEqual(count, 1)
        await reporter.changeAuthorization()
        await reporter.release()
        let result = await request.value
        XCTAssertEqual(result, .authorizationRequired(eventID: h.eventID))
        XCTAssertEqual(try h.outbox.pending(now: fallDate).count, 1)
    }

    func testRecoveryWithAcquisitionDisabledCannotCreateUnknownEventEvenBeforeDeadline() async throws {
        let reporter = MemoryWatchReporter(shouldFail: true)
        let h = makeHarness(reporter: reporter)
        _ = await h.coordinator.receive(fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed))
        _ = await h.coordinator.answer(eventID: h.eventID, response: .needsHelp, answeredAt: fallDate)
        await reporter.setShouldFail(false)
        _ = await h.coordinator.retryPending(at: fallDate.addingTimeInterval(2), allowCreation: false)
        let count = await reporter.reportCount()
        XCTAssertEqual(count, 1)
        XCTAssertEqual(try h.outbox.pending(now: fallDate).count, 1)
    }

    private func makeHarness(
        outbox: MemoryObservationOutbox = MemoryObservationOutbox(),
        reporter: MemoryWatchReporter = MemoryWatchReporter(),
        snapshot: WatchPositionSnapshot? = nil
    ) -> Harness {
        let eventID = "REDACTED-SUPPLEMENT-ID-3ed2dcca9eb2"
        let eventState = MemoryFallEventState(eventID: eventID)
        return Harness(
            eventID: eventID,
            eventState: eventState,
            outbox: outbox,
            reporter: reporter,
            coordinator: FallEmergencyCoordinator(
                eventState: eventState,
                outbox: outbox,
                reporter: reporter,
                positionProvider: FixedWatchPositionProvider(snapshot: snapshot),
                now: { Date(timeIntervalSince1970: 1_788_000_000) }
            )
        )
    }
}

private struct Harness {
    let eventID: String
    let eventState: MemoryFallEventState
    let outbox: MemoryObservationOutbox
    let reporter: MemoryWatchReporter
    let coordinator: FallEmergencyCoordinator
}

private final class MemoryFallEventState: @unchecked Sendable, FallEventStatePersisting {
    let eventIDValue: String
    private let lock = NSLock()
    private var reported = false
    private var contexts: [String: PersistedFallContext] = [:]

    init(eventID: String) {
        eventIDValue = eventID
    }

    func eventID(for fallDetectedAt: Date) -> String {
        _ = fallDetectedAt
        return eventIDValue
    }

    func wasReported(fallDetectedAt: Date) -> Bool {
        _ = fallDetectedAt
        lock.lock()
        defer { lock.unlock() }
        return reported
    }

    func markReported(fallDetectedAt: Date) {
        _ = fallDetectedAt
        lock.lock()
        reported = true
        lock.unlock()
    }

    func pendingContexts(now: Date) -> [PersistedFallContext] {
        lock.lock()
        defer { lock.unlock() }
        return contexts.values.filter {
            now.timeIntervalSince($0.fallDetectedAt) >= 0
                && now.timeIntervalSince($0.fallDetectedAt) <= 120
        }
    }

    func storePendingContext(_ context: PersistedFallContext) {
        lock.lock()
        contexts[context.eventID] = context
        lock.unlock()
    }

    func clearPending(eventID: String) {
        lock.lock()
        contexts.removeValue(forKey: eventID)
        lock.unlock()
    }
}

private final class MemoryObservationOutbox: @unchecked Sendable, WatchObservationOutbox {
    private let lock = NSLock()
    private var values: [String: WatchEmergencyObservation] = [:]
    private var markers: [String: Date] = [:]
    private var rejected: [String: Int] = [:]
    private var confirmed: Set<String> = []
    private var bindings: [String: String] = [:]
    private let failStores: Bool

    init(failStores: Bool = false) {
        self.failStores = failStores
    }

    func pending(now: Date) throws -> [WatchEmergencyObservation] {
        _ = now
        lock.lock()
        defer { lock.unlock() }
        return values.values.sorted { $0.fallDetectedAt < $1.fallDetectedAt }
    }

    func sourceBinding(eventID: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }; return bindings[eventID]
    }

    func store(_ observation: WatchEmergencyObservation, sourceBinding: String?) throws {
        if failStores { throw TestError.persistence }
        lock.lock()
        values[observation.eventId] = observation
        bindings[observation.eventId] = sourceBinding
        lock.unlock()
    }

    func acknowledge(eventID: String, at date: Date) throws {
        if failStores { throw TestError.persistence }
        lock.lock()
        if values.removeValue(forKey: eventID) != nil { confirmed.insert(eventID) }
        markers[eventID] = date
        lock.unlock()
    }

    func suppress(eventID: String, at date: Date) throws {
        try acknowledge(eventID: eventID, at: date)
    }

    func confirmedEventIDs() throws -> [String] {
        lock.lock(); defer { lock.unlock() }; return confirmed.sorted()
    }
    func rejectedStatus(eventID: String) throws -> Int? {
        lock.lock(); defer { lock.unlock() }; return rejected[eventID]
    }
    func retainRejected(eventID: String, status: Int) throws {
        lock.lock(); defer { lock.unlock() }; rejected[eventID] = status
    }
    func pruneDedupeMarkers(now date: Date) throws {
        lock.lock(); defer { lock.unlock() }
        markers = markers.filter { date.timeIntervalSince($0.value) <= 24 * 60 * 60 }
    }

    func hasDedupeMarker(eventID: String, now date: Date) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if values[eventID] != nil { return true }
        guard let marker = markers[eventID] else { return false }
        return date.timeIntervalSince(marker) <= 24 * 60 * 60
    }

    func isMarked(eventID: String, now date: Date) -> Bool {
        (try? hasDedupeMarker(eventID: eventID, now: date)) == true
    }
}

private actor MemoryWatchReporter: WatchObservationReporting {
    private var observations: [WatchEmergencyObservation] = []
    private var shouldFail: Bool
    private var revision = 0
    private var state: WatchEventStateSnapshot?
    private var rejection: Int?
    private var suspended = false
    private var continuation: CheckedContinuation<Void, Never>?

    func authorizationRevision() -> Int { revision }
    private var binding = String(repeating: "a", count: 64)
    func observationSourceBinding() -> String? { binding }
    func changeSource(_ source: String) { binding = source; revision += 1 }
    func changeAuthorization() { revision += 1 }
    func setState(_ value: WatchEventStateSnapshot) { state = value }
    func setRejection(_ value: Int?) { rejection = value }
    func suspendNextReport() { suspended = true }
    func isSuspended() -> Bool { continuation != nil }
    func release() { continuation?.resume(); continuation = nil }
    func fetchEventState(eventID: String) throws -> WatchEventStateSnapshot {
        guard let state else { throw WatchAPIError.rejected(404) }
        return state
    }

    init(shouldFail: Bool = false) {
        self.shouldFail = shouldFail
    }

    func report(_ observation: WatchEmergencyObservation, sourceBinding: String) async throws {
        guard sourceBinding == binding else { throw WatchAPIError.sessionChanged }
        observations.append(observation)
        if suspended { suspended = false; await withCheckedContinuation { continuation = $0 } }
        if let rejection { throw WatchAPIError.rejected(rejection) }
        if shouldFail { throw TestError.expectedFailure }
    }

    func setShouldFail(_ value: Bool) {
        shouldFail = value
    }

    func reportCount() -> Int { observations.count }
    func firstObservation() -> WatchEmergencyObservation? { observations.first }
    func allObservations() -> [WatchEmergencyObservation] { observations }
}

@MainActor
private final class FixedWatchPositionProvider: WatchPositionSnapshotProviding {
    var hasRequiredAuthorization = true
    var onAuthorizationChange: ((Bool) -> Void)?
    private let value: WatchPositionSnapshot

    init(snapshot: WatchPositionSnapshot? = nil) {
        value = snapshot ?? WatchPositionSnapshot(
            patientPosition: try? PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            unavailableReason: nil
        )
    }

    func requestAuthorizationAndLocation() {}
    func snapshot() -> WatchPositionSnapshot { value }
}

private enum TestError: Error {
    case expectedFailure
    case persistence
}

private final class D3MutableDate: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) { self.value = value }
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ value: Date) { lock.lock(); self.value = value; lock.unlock() }
}


@MainActor
final class C4cReviewRecoveryTests: XCTestCase {
    func testAbsentReadAfterDeadlineMustNotPermanentlyFreezeLaterCommittedObservation() async throws {
        let name = "aedresponse-c4c-review-\(UUID().uuidString)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: name, kSecAttrAccount as String: "watch-trigger-outbox"]
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { SecItemDelete(query as CFDictionary); defaults.removePersistentDomain(forName: name) }
        let start = Date(timeIntervalSince1970: 1_788_000_000)
        let id = "REDACTED-SUPPLEMENT-ID-04b473ba9046"
        let original = WatchEmergencyObservation(eventId: id, fallDetectedAt: start, fallResolution: .confirmed,
            appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "UNCONFIRMED")
        let outbox = KeychainObservationOutbox(service: name)
        try outbox.store(original)
        let reporter = C4cDelayedCommitReporter()
        let coordinator = FallEmergencyCoordinator(eventState: UserDefaultsFallEventStateStore(defaults: defaults), outbox: outbox,
            reporter: reporter, positionProvider: C4cReviewPosition(), now: { start.addingTimeInterval(3600) })
        _ = await coordinator.retryPending(at: start.addingTimeInterval(3600))
        XCTAssertEqual(try outbox.pending(now: start), [original])
        let beforeCommit = await reporter.sent()
        XCTAssertTrue(beforeCommit.isEmpty, "A 404 must never authorize a late new creation")
        await reporter.commit(id: id, at: start)
        let result = await coordinator.retryPending(at: start.addingTimeInterval(7200))
        XCTAssertEqual(result, [.reported(eventID: id, fallDetectedAt: start)], "Later authority must remain recoverable after an earlier absent read")
        let sent = await reporter.sent()
        XCTAssertEqual(sent, [original], "Only exact existing observation replay may release the original")
        XCTAssertEqual(try outbox.confirmedEventIDs(), [id])
        XCTAssertTrue(try outbox.pending(now: start).isEmpty)
    }
}

private actor C4cDelayedCommitReporter: WatchObservationReporting {
    private var state: WatchEventStateSnapshot?
    private var observations: [WatchEmergencyObservation] = []
    func authorizationRevision() -> Int { 0 }
    func observationSourceBinding() -> String? { String(repeating: "a", count: 64) }
    func fetchEventState(eventID: String) throws -> WatchEventStateSnapshot {
        guard let state else { throw WatchAPIError.rejected(404) }
        return state
    }
    func report(_ observation: WatchEmergencyObservation, sourceBinding: String) throws { observations.append(observation) }
    func sent() -> [WatchEmergencyObservation] { observations }
    func commit(id: String, at: Date) { state = WatchEventStateSnapshot(eventId: id, state: .resolved, createdAt: at, resolvedAt: at.addingTimeInterval(1800)) }
}

private actor D2CreationRecordingTransport: WatchAPIHTTPTransport {
    private var sent: [URLRequest] = []
    func requests() -> [URLRequest] { sent }
    func data(for request: URLRequest) throws -> (Data, URLResponse) {
        sent.append(request)
        let isCreation = request.httpMethod == "PUT"
        let body = isCreation ? "{\"id\":\"\(request.url!.lastPathComponent)\",\"state\":\"ACTIVE\"}" : "{}"
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: isCreation ? 201 : 404,
            httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
private final class C4cReviewPosition: WatchPositionSnapshotProviding {
    var hasRequiredAuthorization = true
    var onAuthorizationChange: ((Bool) -> Void)?
    func requestAuthorizationAndLocation() {}
    func snapshot() -> WatchPositionSnapshot { WatchPositionSnapshot(patientPosition: nil, unavailableReason: "UNUSED") }
}

@MainActor
final class D2ReviewContextTests: XCTestCase {
    func testBadPendingContextOriginMustNotDisappearWhenProtectedTransferFails() async throws {
        for mode in ["answer", "outgoing", "cachedCall"] {
        let name = "aedresponse-d2-context-review-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name); SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: name] as CFDictionary) }
        let state = UserDefaultsFallEventStateStore(defaults: defaults)
        let at = Date(timeIntervalSince1970: 1_788_000_000)
        let id = try state.eventID(for: at)
        let context = PersistedFallContext(eventID: id, fallDetectedAt: at, fallResolution: .confirmed, sourceBinding: "corrupt-source")
        if mode != "cachedCall" { try state.storePendingContext(context) }
        let outbox = KeychainObservationOutbox(service: name)
        let coordinator = FallEmergencyCoordinator(eventState: state, outbox: outbox, reporter: D2ContextReporter(binding: mode == "cachedCall" ? "corrupt-source" : String(repeating: "a", count: 64)),
            positionProvider: D2ContextPosition(), now: { at })
        let result: WatchCoordinatorResult
        if mode == "answer" {
            result = await coordinator.answer(eventID: id, response: .needsHelp, answeredAt: at)
        } else if mode == "outgoing" {
            result = await coordinator.receive(call: OutgoingCallSignal(callID: "outgoing", firstObservedAt: at, isOutgoing: true))
        } else {
            _ = await coordinator.receive(call: OutgoingCallSignal(callID: "cached", firstObservedAt: at, isOutgoing: true))
            result = await coordinator.receive(fall: FallDetectionSignal(detectedAt: at, resolution: .confirmed))
        }
        XCTAssertEqual(result, .persistenceFailed(eventID: id))
        XCTAssertEqual(try state.pendingContexts(now: at), [context], "Failed transfer must not destroy the only retained Fall/source evidence")
        XCTAssertTrue(try outbox.pending(now: at).isEmpty)
        }
    }
}
private actor D2ContextReporter: WatchObservationReporting {
    let binding: String
    init(binding: String) { self.binding = binding }
    func authorizationRevision() -> Int { 0 }
    func observationSourceBinding() -> String? { binding }
    func fetchEventState(eventID: String) throws -> WatchEventStateSnapshot { throw WatchAPIError.rejected(404) }
    func report(_ observation: WatchEmergencyObservation, sourceBinding: String) throws { throw WatchAPIError.rejected(403) }
}
@MainActor
private final class D2ContextPosition: WatchPositionSnapshotProviding {
    var hasRequiredAuthorization = true
    var onAuthorizationChange: ((Bool) -> Void)?
    func requestAuthorizationAndLocation() {}
    func snapshot() -> WatchPositionSnapshot { WatchPositionSnapshot(patientPosition: nil, unavailableReason: "NO_FIX") }
}
