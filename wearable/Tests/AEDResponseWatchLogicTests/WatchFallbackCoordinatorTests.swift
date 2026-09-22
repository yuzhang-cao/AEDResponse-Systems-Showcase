import Foundation
import Security
import XCTest
@testable import AEDResponseCore

private struct BlockingFallbackAdmissionPolicy: WatchFallbackAdmissionPolicy {
    func decision(
        connectivity: WatchConnectivityState,
        networkAvailable: Bool
    ) -> WatchFallbackAdmissionDecision {
        .blockedPendingBusinessRule
    }
}

@MainActor
final class WatchFallbackCoordinatorTests: XCTestCase {
    private let eventID = "00000000-0000-4000-8000-000000000701"
    private let start = Date(timeIntervalSince1970: 1_788_000_000)

    func testReachableIPhoneStillRecoversTerminalAndUploadsOriginalHistory() async throws {
        let reporter = MemoryFallbackReporter(shouldFail: true)
        let harness = makeHarness(reporter: reporter)
        let offlinePhone = WatchConnectivityState(activationState: .activated, iphoneReachable: false)
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: offlinePhone, networkAvailable: true, observedAt: start)
        let original = try XCTUnwrap(harness.outbox.pending(now: start).first)
        let starts = harness.position.startCount
        await reporter.setEventState(WatchEventStateSnapshot(eventId: eventID, state: .resolved,
            createdAt: start, resolvedAt: start.addingTimeInterval(20)))
        await reporter.setShouldFail(false)
        let result = await harness.coordinator.periodicReport(
            connectivity: WatchConnectivityState(activationState: .activated, iphoneReachable: true),
            networkAvailable: true, observedAt: start.addingTimeInterval(30))
        XCTAssertEqual(result, .eventEnded(eventID: eventID))
        XCTAssertEqual(harness.position.startCount, starts)
        XCTAssertGreaterThan(harness.position.stopCount, 0)
        let active = await harness.coordinator.currentActiveEventID()
        XCTAssertNil(active)
        XCTAssertEqual(try harness.outbox.pending(now: start), [original])
        let history = await harness.coordinator.recoverEventState(networkAvailable: true, observedAt: start.addingTimeInterval(31))
        XCTAssertEqual(history, .historyReported(positionUpdateID: original.positionUpdateId))
        XCTAssertTrue(try harness.outbox.pending(now: start).isEmpty)
        let sent = await reporter.updates()
        XCTAssertEqual(sent, [original, original])
        _ = await harness.coordinator.significantPositionDidChange(
            WatchFallbackPositionSample(patientPosition: original.patientPosition, observedAt: start.addingTimeInterval(40)),
            connectivity: offlinePhone, networkAvailable: true)
        let count = await reporter.updateCount()
        XCTAssertEqual(count, 2)
        XCTAssertEqual(harness.position.startCount, starts)
    }

    func testTerminalWindowIsolatesOnlyOutOfWindowRecordsAndKeepsOtherEvents() async throws {
        let harness = makeHarness()
        let samples = try [-1.0, 5, 20, 21].enumerated().map {
            try makeUpdate(id: "queued-\($0.offset)", observedAt: start.addingTimeInterval($0.element))
        }
        for sample in samples { try harness.outbox.store(sample) }
        let other = try makeUpdate(id: "other-event-sample", eventID: "another-event")
        try harness.outbox.store(other)
        await harness.reporter.setEventState(WatchEventStateSnapshot(eventId: eventID, state: .closedUnconfirmedNoResponse,
            createdAt: start, resolvedAt: start.addingTimeInterval(20)))
        _ = await harness.coordinator.recoverEventState(networkAvailable: true, observedAt: start.addingTimeInterval(30))
        _ = await harness.coordinator.recoverEventState(networkAvailable: true, observedAt: start.addingTimeInterval(35))
        let sent = await harness.reporter.updates()
        XCTAssertEqual(sent, [samples[1]])
        XCTAssertEqual(harness.outbox.isolatedFacts().map(\.update).sorted { $0.positionUpdateId < $1.positionUpdateId },
            [samples[0], samples[2], samples[3]].sorted { $0.positionUpdateId < $1.positionUpdateId })
        XCTAssertEqual(try harness.outbox.pending(now: start), [other])
        XCTAssertEqual(try harness.outbox.sealedState(eventID: eventID)?.state, .closedUnconfirmedNoResponse)
    }

    func testStateFailuresDoNotInventTerminalOrDiscardPendingRecords() async throws {
        for status in [403, 409, 503] {
            let harness = makeHarness()
            let original = try makeUpdate(id: "state-failure-\(status)")
            try harness.outbox.store(original)
            await harness.reporter.setStateError(.rejected(status))
            let result = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
                connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start)
            XCTAssertEqual(result, status == 403 ? .authorizationRequired : .waitingForServerState)
            XCTAssertEqual(try harness.outbox.pending(now: start), [original])
            XCTAssertEqual(harness.position.startCount, 0)
            let count = await harness.reporter.updateCount()
            XCTAssertEqual(count, 0)
        }
    }

    func testDeniedOrConflictingUploadsStopBlindWritesAndRetainEvidence() async throws {
        for status in [403, 409] {
            let harness = makeHarness()
            await harness.reporter.setReportError(.rejected(status))
            _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
                connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start)
            _ = await harness.coordinator.periodicReport(
                connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start.addingTimeInterval(10))
            let count = await harness.reporter.updateCount()
            XCTAssertEqual(count, 1)
            if status == 403 {
                XCTAssertEqual(try harness.outbox.pending(now: start).count, 1)
                await harness.reporter.setAuthorizationRevision(1)
                await harness.reporter.setReportError(nil)
                _ = await harness.coordinator.periodicReport(
                    connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
                    networkAvailable: true, observedAt: start.addingTimeInterval(20))
                XCTAssertTrue(try harness.outbox.pending(now: start).isEmpty)
            } else {
                XCTAssertTrue(try harness.outbox.pending(now: start).isEmpty)
                XCTAssertEqual(harness.outbox.isolatedFacts().count, 1)
                XCTAssertEqual(harness.outbox.isolatedFacts().first?.statusCode, 409)
            }
        }
    }

    func testHistoricalBacklogDoesNotBlockNewSignificantSamples() async throws {
        let harness = makeHarness(reporter: MemoryFallbackReporter(shouldFail: true))
        let connectivity = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)
        let old = try makeUpdate(id: "old-history", observedAt: start.addingTimeInterval(-100), eventID: "old-event")
        try harness.outbox.store(old)
        await harness.reporter.setEventState(WatchEventStateSnapshot(eventId: old.eventId, state: .resolved,
            createdAt: start.addingTimeInterval(-200), resolvedAt: start.addingTimeInterval(-50)))
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)
        let fresh = WatchFallbackPositionSample(patientPosition: try PatientPosition(latitude: 22.1997,
            longitude: 113.5439, accuracyMeters: 12), observedAt: start.addingTimeInterval(5))
        _ = await harness.coordinator.significantPositionDidChange(fresh, connectivity: connectivity, networkAvailable: true)
        let attempts = await harness.reporter.updates()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertTrue(attempts.allSatisfy { $0.eventId == eventID })
        XCTAssertEqual(attempts.last?.observedAt, fresh.observedAt)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 3)
        let stops = harness.position.stopCount
        await harness.reporter.setShouldFail(false)
        let drained = await harness.coordinator.recoverEventState(networkAvailable: true, observedAt: start.addingTimeInterval(10))
        XCTAssertEqual(drained, .historyReported(positionUpdateID: old.positionUpdateId))
        XCTAssertEqual(harness.position.stopCount, stops)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 2)
    }

    func testStoppedGenerationDoesNotAcknowledgeAnOldResponse() async throws {
        let harness = makeHarness()
        await harness.reporter.suspendNextReport()
        let eventID = self.eventID
        let start = self.start
        let pending = Task {
            await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
                connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start)
        }
        for _ in 0..<200 {
            if await harness.reporter.isSuspended() { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let suspended = await harness.reporter.isSuspended()
        XCTAssertTrue(suspended)
        await harness.coordinator.stop()
        await harness.reporter.releaseReport()
        let result = await pending.value
        XCTAssertEqual(result, .waitingForServerState)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 1)
    }

    func testClearContextKeepsUnconfirmedEvidenceAndProtectedIsolationSurvivesRestart() async throws {
        let harness = makeHarness(reporter: MemoryFallbackReporter(shouldFail: true))
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
            networkAvailable: true, observedAt: start)
        let original = try XCTUnwrap(harness.outbox.pending(now: start).first)
        await harness.coordinator.clearActiveEvent()
        XCTAssertEqual(try harness.outbox.pending(now: start), [original])
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("watch-isolation-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let outbox = ProtectedFileWatchFallbackOutbox(fileURL: url)
        try outbox.store(original)
        let terminal = WatchEventStateSnapshot(eventId: eventID, state: .resolved,
            createdAt: start, resolvedAt: start.addingTimeInterval(20))
        try outbox.seal(terminal)
        try outbox.quarantine(original, reason: .serverRejectedContent, serverWindow: terminal, statusCode: 409)
        let reopened = ProtectedFileWatchFallbackOutbox(fileURL: url)
        XCTAssertEqual(try reopened.sealedState(eventID: eventID), terminal)
        XCTAssertTrue(try reopened.pending(now: start).isEmpty)
        let persisted = try JSONDecoder.contractDecoder().decode(WatchFallbackQueueState.self, from: Data(contentsOf: url))
        XCTAssertEqual(persisted.quarantined[original.positionUpdateId]?.update, original)
        XCTAssertThrowsError(try reopened.store(original))
        try reopened.acknowledge(positionUpdateID: original.positionUpdateId)
        let afterACK = try JSONDecoder.contractDecoder().decode(WatchFallbackQueueState.self, from: Data(contentsOf: url))
        XCTAssertEqual(afterACK.quarantined, persisted.quarantined)
    }

    func testNotActivatedInactiveAndActivatedUnreachableMayFallbackWithWAN() async throws {
        let states: [WatchConnectivityState] = [
            WatchConnectivityState(activationState: .notActivated, iphoneReachable: false),
            WatchConnectivityState(activationState: .inactive, iphoneReachable: true),
            WatchConnectivityState(activationState: .activated, iphoneReachable: false)
        ]
        for state in states {
            let harness = makeHarness()
            let result = await harness.coordinator.activate(
                eventID: eventID,
                fallDetectedAt: start,
                connectivity: state,
                networkAvailable: true,
                observedAt: start
            )
            XCTAssertEqual(result, .positionReported(positionUpdateID: "position-1"))
            let updates = await harness.reporter.updates()
            XCTAssertEqual(updates.count, 1)
            XCTAssertEqual(updates[0].activationState, state.activationState)
            XCTAssertEqual(updates[0].iphoneReachable, state.iphoneReachable)
            XCTAssertTrue(updates[0].networkAvailable)
        }
    }

    func testReachablePhoneAllowsFallbackWithFreshServerAdmission() async throws {
        let harness = makeHarness()
        var snapshot = WatchEventStateSnapshot(eventId: eventID, state: .active, createdAt: start, resolvedAt: nil)
        snapshot.fallbackAllowed = true
        await harness.reporter.setEventState(snapshot)
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: WatchConnectivityState(activationState: .activated, iphoneReachable: true),
            networkAvailable: true, observedAt: start)
        let count = await harness.reporter.updateCount()
        XCTAssertEqual(count, 1)
        XCTAssertGreaterThan(harness.position.startCount, 0)
    }

    func testAdmissionRaceKeepsFactAndResumesWithoutChangingAccount() async throws {
        let harness = makeHarness()
        var snapshot = WatchEventStateSnapshot(eventId: eventID, state: .active, createdAt: start, resolvedAt: nil)
        snapshot.fallbackAllowed = true
        await harness.reporter.setEventState(snapshot)
        await harness.reporter.setReportError(.fallbackAdmissionChanged)
        let connectivity = WatchConnectivityState(activationState: .activated, iphoneReachable: true)
        let first = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)
        XCTAssertEqual(first, .waitingForServerState)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 1)
        await harness.reporter.setReportError(nil)
        _ = await harness.coordinator.resume(connectivity: connectivity, networkAvailable: true,
            observedAt: start.addingTimeInterval(5))
        XCTAssertTrue(try harness.outbox.pending(now: start.addingTimeInterval(5)).isEmpty)
    }

    func testActivatedReachableStopsFallbackWithoutSending() async {
        let harness = makeHarness()
        let result = await harness.coordinator.activate(
            eventID: eventID,
            fallDetectedAt: start,
            connectivity: WatchConnectivityState(
                activationState: .activated,
                iphoneReachable: true
            ),
            networkAvailable: true,
            observedAt: start
        )
        XCTAssertEqual(result, .stoppedForIPhoneRecovery)
        let updateCount = await harness.reporter.updateCount()
        XCTAssertEqual(updateCount, 0)
        XCTAssertEqual(harness.position.startCount, 0)
    }

    func testFallbackAdmissionPolicyCanBlockUnresolvedRuleWithoutWritingOrDeletingFacts() async throws {
        let harness = makeHarness(admissionPolicy: BlockingFallbackAdmissionPolicy())
        let original = try makeUpdate(id: "policy-blocked")
        try harness.outbox.store(original)
        let result = await harness.coordinator.activate(
            eventID: eventID,
            fallDetectedAt: start,
            connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
            networkAvailable: true,
            observedAt: start
        )
        XCTAssertEqual(result, .blockedPendingBusinessRule)
        XCTAssertEqual(try harness.outbox.pending(now: start), [original])
        let updateCount = await harness.reporter.updateCount()
        XCTAssertEqual(updateCount, 0)
        XCTAssertEqual(harness.position.startCount, 0)
    }

    func testFuturePreferredPositionIsNotUploaded() async throws {
        let harness = makeHarness()
        let connectivity = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)
        _ = await harness.coordinator.activate(
            eventID: eventID,
            fallDetectedAt: start,
            connectivity: connectivity,
            networkAvailable: true,
            observedAt: start
        )
        let future = WatchFallbackPositionSample(
            patientPosition: try PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            observedAt: start.addingTimeInterval(1),
            receivedAt: start
        )
        let result = await harness.coordinator.significantPositionDidChange(
            future,
            connectivity: connectivity,
            networkAvailable: true
        )
        XCTAssertEqual(result, .waitingForPosition)
        let updateCount = await harness.reporter.updateCount()
        XCTAssertEqual(updateCount, 1)
        XCTAssertTrue(try harness.outbox.pending(now: start).isEmpty)
    }

    func testFiveSecondCadenceAndTenMeterMovementEarlySend() async throws {
        let harness = makeHarness()
        let unavailable = WatchConnectivityState(
            activationState: .activated,
            iphoneReachable: false
        )
        _ = await harness.coordinator.activate(
            eventID: eventID,
            fallDetectedAt: start,
            connectivity: unavailable,
            networkAvailable: true,
            observedAt: start
        )

        let near = WatchFallbackPositionSample(
            patientPosition: try PatientPosition(
                latitude: 22.19871,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            observedAt: start.addingTimeInterval(4)
        )
        let nearResult = await harness.coordinator.significantPositionDidChange(
            near,
            connectivity: unavailable,
            networkAvailable: true
        )
        XCTAssertEqual(nearResult, .waitingForPosition)

        let moved = WatchFallbackPositionSample(
            patientPosition: try PatientPosition(
                latitude: 22.1989,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            observedAt: start.addingTimeInterval(4)
        )
        // A real provider's snapshot advances with its significant-change
        // callback. Keep the fake provider coherent so the next periodic poll
        // does not incorrectly reintroduce the old coordinate as new movement.
        harness.position.sample = moved
        let movedResult = await harness.coordinator.significantPositionDidChange(
            moved,
            connectivity: unavailable,
            networkAvailable: true
        )
        XCTAssertEqual(movedResult, .positionReported(positionUpdateID: "position-2"))
        let earlyPeriodicResult = await harness.coordinator.periodicReport(
            connectivity: unavailable,
            networkAvailable: true,
            observedAt: start.addingTimeInterval(8)
        )
        XCTAssertEqual(earlyPeriodicResult, .waitingForPosition)
        harness.position.sample = WatchFallbackPositionSample(
            patientPosition: moved.patientPosition,
            observedAt: start.addingTimeInterval(9)
        )
        let periodicResult = await harness.coordinator.periodicReport(
            connectivity: unavailable,
            networkAvailable: true,
            observedAt: start.addingTimeInterval(9)
        )
        XCTAssertEqual(periodicResult, .positionReported(positionUpdateID: "position-3"))
    }

    func testPeriodicPollNeverCreatesNewFactsFromAnUnchangedSnapshot() async throws {
        let harness = makeHarness()
        let connectivity = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)

        for offset: TimeInterval in [5, 10, 60] {
            let result = await harness.coordinator.periodicReport(connectivity: connectivity,
                networkAvailable: true, observedAt: start.addingTimeInterval(offset))
            XCTAssertEqual(result, .waitingForPosition)
        }
        let updates = await harness.reporter.updates()
        XCTAssertEqual(updates.count, 1)
    }

    func testOutOfOrderMovedSampleCannotReplaceANewerCollectedSample() async throws {
        let harness = makeHarness()
        let connectivity = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)
        let older = WatchFallbackPositionSample(
            patientPosition: try PatientPosition(latitude: 22.2, longitude: 113.54, accuracyMeters: 12),
            observedAt: start.addingTimeInterval(-1), receivedAt: start
        )
        let result = await harness.coordinator.significantPositionDidChange(older,
            connectivity: connectivity, networkAvailable: true)
        XCTAssertEqual(result, .waitingForPosition)
        let updates = await harness.reporter.updates()
        XCTAssertEqual(updates.count, 1)
    }

    func testRetryingOlderBacklogDoesNotRewindFreshSampleDeduplication() async throws {
        let harness = makeHarness()
        let connectivity = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)
        let newer = WatchFallbackPositionSample(
            patientPosition: try PatientPosition(latitude: 22.2, longitude: 113.54, accuracyMeters: 12),
            observedAt: start.addingTimeInterval(10)
        )
        _ = await harness.coordinator.significantPositionDidChange(newer,
            connectivity: connectivity, networkAvailable: true)
        let old = try makeUpdate(id: "older-queued", observedAt: start.addingTimeInterval(1))
        try harness.outbox.store(old, sourceBinding: String(repeating: "a", count: 64))
        _ = await harness.coordinator.periodicReport(connectivity: connectivity,
            networkAvailable: true, observedAt: start.addingTimeInterval(11))

        let result = await harness.coordinator.significantPositionDidChange(newer,
            connectivity: connectivity, networkAvailable: true)
        XCTAssertEqual(result, .waitingForPosition)
        let updates = await harness.reporter.updates()
        XCTAssertEqual(updates.map(\.positionUpdateId), ["position-1", "position-2", "older-queued"])
    }

    func testServerAdmissionRevocationStopsAnAlreadyRunningSampler() async throws {
        let harness = makeHarness()
        let connectivity = WatchConnectivityState(activationState: .activated, iphoneReachable: true)
        await harness.reporter.setEventState(WatchEventStateSnapshot(eventId: eventID, state: .active,
            createdAt: start, resolvedAt: nil, fallbackAllowed: true))
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)
        let previousStops = harness.position.stopCount
        XCTAssertGreaterThan(harness.position.startCount, 0)

        await harness.reporter.setEventState(WatchEventStateSnapshot(eventId: eventID, state: .active,
            createdAt: start, resolvedAt: nil, fallbackAllowed: false))
        let result = await harness.coordinator.periodicReport(connectivity: connectivity,
            networkAvailable: true, observedAt: start.addingTimeInterval(5))
        XCTAssertEqual(result, .stoppedForIPhoneRecovery)
        XCTAssertGreaterThan(harness.position.stopCount, previousStops)
        let updates = await harness.reporter.updates()
        XCTAssertEqual(updates.count, 1)
    }

    func testWANDisconnectRetainsQueuedSampleAndRetriesSameIDWhenRestored() async throws {
        let reporter = MemoryFallbackReporter(shouldFail: true)
        let harness = makeHarness(reporter: reporter)
        let unavailable = WatchConnectivityState(
            activationState: .activated,
            iphoneReachable: false
        )
        let first = await harness.coordinator.activate(
            eventID: eventID,
            fallDetectedAt: start,
            connectivity: unavailable,
            networkAvailable: true,
            observedAt: start
        )
        XCTAssertEqual(first, .positionQueued(positionUpdateID: "position-1"))
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 1)

        let disconnectedResult = await harness.coordinator.networkDidChange(
            false,
            connectivity: unavailable,
            observedAt: start.addingTimeInterval(1)
        )
        XCTAssertEqual(disconnectedResult, .waitingForConnectivity)
        XCTAssertEqual(try harness.outbox.pending(now: start.addingTimeInterval(1)).count, 1)

        await reporter.setShouldFail(false)
        let restored = await harness.coordinator.networkDidChange(
            true,
            connectivity: unavailable,
            observedAt: start.addingTimeInterval(5)
        )
        XCTAssertEqual(restored, .positionReported(positionUpdateID: "position-1"))
        XCTAssertTrue(try harness.outbox.pending(now: start.addingTimeInterval(5)).isEmpty)
        let updates = await harness.reporter.updates()
        XCTAssertEqual(updates.map(\.positionUpdateId), ["position-1", "position-1"])
    }

    func testIPhoneRecoveryStopsSendingButDoesNotDeleteEncryptedQueue() async throws {
        let reporter = MemoryFallbackReporter(shouldFail: true)
        let harness = makeHarness(reporter: reporter)
        let unavailable = WatchConnectivityState(
            activationState: .activated,
            iphoneReachable: false
        )
        _ = await harness.coordinator.activate(
            eventID: eventID,
            fallDetectedAt: start,
            connectivity: unavailable,
            networkAvailable: true,
            observedAt: start
        )
        let reachable = WatchConnectivityState(
            activationState: .activated,
            iphoneReachable: true
        )
        let stopped = await harness.coordinator.connectivityDidChange(
            reachable,
            networkAvailable: true,
            observedAt: start.addingTimeInterval(1)
        )
        XCTAssertEqual(stopped, .stoppedForIPhoneRecovery)
        XCTAssertEqual(try harness.outbox.pending(now: start.addingTimeInterval(1)).count, 1)
        let updateCount = await harness.reporter.updateCount()
        XCTAssertEqual(updateCount, 1)
        XCTAssertEqual(harness.position.stopCount, 1)
    }

    func testFallbackQueueDoesNotSilentlyTruncateAndACKIsTheOnlyRemoval() throws {
        let outbox = MemoryFallbackOutbox()
        for index in 0..<40 {
            let update = try makeUpdate(id: "position-\(index)")
            try outbox.store(update)
        }
        XCTAssertEqual(try outbox.pending(now: start).count, 40)
        try outbox.acknowledge(positionUpdateID: "position-0")
        XCTAssertEqual(try outbox.pending(now: start).count, 39)
    }

    func testCorruptProtectedFallbackFileFailsClosedWithoutOverwritingOriginal() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("aedresponse-watch-fallback-corrupt-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let original = Data("corrupt-protected-queue".utf8)
        try original.write(to: url, options: .atomic)
        let outbox = ProtectedFileWatchFallbackOutbox(fileURL: url)

        XCTAssertThrowsError(try outbox.pending(now: start))
        XCTAssertEqual(try Data(contentsOf: url), original)
    }

    func testCorruptKeychainTriggerQueueFailsClosedWithoutOverwritingOriginal() throws {
        let service = "aedresponse-watch-trigger-corrupt-\(UUID().uuidString)"
        let account = "watch-trigger-outbox"
        let original = Data("corrupt-keychain-queue".utf8)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: original,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        _ = SecItemDelete(query as CFDictionary)
        XCTAssertEqual(SecItemAdd(query as CFDictionary, nil), errSecSuccess)
        defer { _ = SecItemDelete(query as CFDictionary) }

        let outbox = KeychainObservationOutbox(service: service)
        XCTAssertThrowsError(try outbox.pending(now: start))
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &item), errSecSuccess)
        XCTAssertEqual(item as? Data, original)
    }

    func testConfirmedTriggerReferenceRestoresAfterACKBeforeRuntimeActivation() async throws {
        let h = makeHarness()
        _ = await h.coordinator.recoverEventState(networkAvailable: true, observedAt: start,
            confirmedEventIDs: [eventID])
        let restored = await h.coordinator.currentActiveEventID()
        XCTAssertEqual(restored, eventID)
        XCTAssertEqual(h.position.startCount, 0, "Restoring an ACK reference must not start capture")
        await h.reporter.setEventState(WatchEventStateSnapshot(eventId: eventID, state: .resolved,
            createdAt: start, resolvedAt: start.addingTimeInterval(20)))
        _ = await h.coordinator.recoverEventState(networkAvailable: true, observedAt: start.addingTimeInterval(30),
            confirmedEventIDs: [eventID])
        let ended = await h.coordinator.currentActiveEventID()
        XCTAssertNil(ended)
        XCTAssertEqual(try h.outbox.sealedState(eventID: eventID)?.state, .resolved)
        XCTAssertEqual(h.position.startCount, 0)
    }

    func testConfirmedTriggerRecoveryDoesNotChooseBetweenMultipleActiveEvents() async {
        let h = makeHarness()
        _ = await h.coordinator.recoverEventState(networkAvailable: true, observedAt: start,
            confirmedEventIDs: [eventID, "another-active-event"])
        let active = await h.coordinator.currentActiveEventID()
        XCTAssertNil(active)
        XCTAssertEqual(h.position.startCount, 0)
    }

    func testFallbackFactKeepsOriginalSourceAcrossSessionChangeAndRetry() async throws {
        let reporter = MemoryFallbackReporter(shouldFail: true)
        let harness = makeHarness(reporter: reporter)
        let connectivity = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)
        _ = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: connectivity, networkAvailable: true, observedAt: start)
        let original = try XCTUnwrap(harness.outbox.pending(now: start).first)
        let originalSource = try XCTUnwrap(harness.outbox.sourceBinding(positionUpdateID: original.positionUpdateId))
        XCTAssertEqual(originalSource, String(repeating: "a", count: 64))

        await reporter.setSource(String(repeating: "b", count: 64))
        await reporter.setShouldFail(false)
        let blocked = await harness.coordinator.periodicReport(
            connectivity: connectivity, networkAvailable: true, observedAt: start.addingTimeInterval(5))
        XCTAssertEqual(blocked, .authorizationRequired)
        XCTAssertEqual(try harness.outbox.pending(now: start), [original])

        await reporter.setSource(originalSource)
        let recovered = await harness.coordinator.periodicReport(
            connectivity: connectivity, networkAvailable: true, observedAt: start.addingTimeInterval(6))
        XCTAssertEqual(recovered, .positionReported(positionUpdateID: original.positionUpdateId))
        XCTAssertTrue(try harness.outbox.pending(now: start).isEmpty)
        let sent = await harness.reporter.updates()
        XCTAssertEqual(sent.map(\.positionUpdateId), [original.positionUpdateId, original.positionUpdateId])
    }

    func testSourceChangeDuringFallbackRequestCannotACKOldFact() async throws {
        let reporter = MemoryFallbackReporter()
        let harness = makeHarness(reporter: reporter)
        await reporter.suspendNextReport()
        let request = Task {
            await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
                connectivity: .init(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start)
        }
        for _ in 0..<200 {
            if await reporter.isSuspended() { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let reportSuspended = await reporter.isSuspended()
        XCTAssertTrue(reportSuspended)
        await reporter.setSource(String(repeating: "b", count: 64))
        await reporter.releaseReport()
        let result = await request.value
        XCTAssertEqual(result, .authorizationRequired)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 1)
    }

    func testStopDuringFinalSourceCheckCannotACKOldFact() async throws {
        let reporter = MemoryFallbackReporter()
        let harness = makeHarness(reporter: reporter)
        // activate: GET proof source checks 1/2, new sample 3, upload source 4,
        // final post-response source check 5.
        await reporter.suspendSourceCheck(atCall: 5)
        let request = Task {
            await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
                connectivity: .init(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start)
        }
        for _ in 0..<200 {
            if await reporter.isSourceSuspended() { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let sourceSuspended = await reporter.isSourceSuspended()
        XCTAssertTrue(sourceSuspended)
        await harness.coordinator.stop()
        await reporter.releaseSourceCheck()
        let result = await request.value
        XCTAssertEqual(result, .waitingForServerState)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 1)
    }

    func testStopDuringSampleSourceCheckDoesNotStoreNewFact() async throws {
        let reporter = MemoryFallbackReporter()
        let harness = makeHarness(reporter: reporter)
        // activate: GET proof source checks 1/2; new sample source check 3.
        await reporter.suspendSourceCheck(atCall: 3)
        let request = Task {
            await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
                connectivity: .init(activationState: .inactive, iphoneReachable: false),
                networkAvailable: true, observedAt: start)
        }
        for _ in 0..<200 {
            if await reporter.isSourceSuspended() { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let suspended = await reporter.isSourceSuspended()
        XCTAssertTrue(suspended)
        await harness.coordinator.stop()
        await reporter.releaseSourceCheck()
        let result = await request.value
        XCTAssertEqual(result, .waitingForServerState)
        XCTAssertEqual(try harness.outbox.pending(now: start).count, 0)
    }

    func testLegacyFallbackFactWithoutSourceNeedsExistingAuthorizedEventBeforeReplay() async throws {
        let harness = makeHarness()
        let original = try makeUpdate(id: "legacy-source-missing")
        try harness.outbox.store(original, sourceBinding: nil)
        await harness.reporter.setEventState(WatchEventStateSnapshot(eventId: eventID, state: .active,
            createdAt: start, resolvedAt: nil))
        let replayed = await harness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: WatchConnectivityState(activationState: .inactive, iphoneReachable: false),
            networkAvailable: true, observedAt: start)
        XCTAssertEqual(replayed, .positionReported(positionUpdateID: original.positionUpdateId))
        XCTAssertTrue(try harness.outbox.pending(now: start).isEmpty)

        let blockedHarness = makeHarness()
        try blockedHarness.outbox.store(original, sourceBinding: nil)
        await blockedHarness.reporter.setStateError(.rejected(404))
        let blocked = await blockedHarness.coordinator.activate(eventID: eventID, fallDetectedAt: start,
            connectivity: .init(activationState: .inactive, iphoneReachable: false),
            networkAvailable: true, observedAt: start)
        XCTAssertEqual(blocked, .waitingForServerState)
        XCTAssertEqual(try blockedHarness.outbox.pending(now: start), [original])
        let reportCount = await blockedHarness.reporter.updateCount()
        XCTAssertEqual(reportCount, 0)
    }

    func testCorruptFallbackSourceMetadataFailsClosedAndPreservesProtectedBytes() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("aedresponse-watch-fallback-source-corrupt-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let original = try makeUpdate(id: "corrupt-source")
        let outbox = ProtectedFileWatchFallbackOutbox(fileURL: url)
        try outbox.store(original, sourceBinding: String(repeating: "a", count: 64))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        object["sourceBindingsByPositionUpdateID"] = NSNull()
        let corrupted = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        try corrupted.write(to: url, options: .atomic)
        let reopened = ProtectedFileWatchFallbackOutbox(fileURL: url)
        XCTAssertThrowsError(try reopened.pending(now: start))
        XCTAssertThrowsError(try reopened.sourceBinding(positionUpdateID: original.positionUpdateId))
        XCTAssertThrowsError(try reopened.store(original, sourceBinding: String(repeating: "a", count: 64)))
        XCTAssertEqual(try Data(contentsOf: url), corrupted)
    }

    private func makeHarness(
        reporter: MemoryFallbackReporter = MemoryFallbackReporter(),
        admissionPolicy: any WatchFallbackAdmissionPolicy = ReachabilityOnlyWatchFallbackAdmissionPolicy()
    ) -> Harness {
        let stateStore = MemoryFallbackStateStore()
        let outbox = MemoryFallbackOutbox()
        let position = FixedFallbackPositionProvider()
        let idGenerator = LockedIDGenerator()
        return Harness(
            coordinator: WatchFallbackCoordinator(
                stateStore: stateStore,
                outbox: outbox,
                reporter: reporter,
                positionProvider: position,
                admissionPolicy: admissionPolicy,
                makeID: { idGenerator.next() },
                now: { Date(timeIntervalSince1970: 1_788_000_000) }
            ),
            reporter: reporter,
            outbox: outbox,
            position: position
        )
    }

    private func makeUpdate(id: String, observedAt: Date? = nil, eventID: String? = nil) throws -> WatchFallbackPositionUpdate {
        WatchFallbackPositionUpdate(
            eventId: eventID ?? self.eventID,
            positionUpdateId: id,
            observedAt: observedAt ?? start,
            patientPosition: try PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            activationState: .activated,
            iphoneReachable: false,
            networkAvailable: true
        )
    }
}

private struct Harness {
    let coordinator: WatchFallbackCoordinator
    let reporter: MemoryFallbackReporter
    let outbox: MemoryFallbackOutbox
    let position: FixedFallbackPositionProvider
}

private final class MemoryFallbackStateStore: @unchecked Sendable, WatchFallbackStatePersisting {
    private let lock = NSLock()
    private var value: PersistedWatchFallbackEvent?

    func activeEvent() -> PersistedWatchFallbackEvent? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func setActiveEvent(_ event: PersistedWatchFallbackEvent?) {
        lock.lock()
        value = event
        lock.unlock()
    }
}

private final class MemoryFallbackOutbox: @unchecked Sendable, WatchFallbackOutbox {
    private let lock = NSLock()
    private var values: [String: WatchFallbackPositionUpdate] = [:]
    private var sealed: [String: WatchEventStateSnapshot] = [:]
    private var isolated: [String: QuarantinedWatchFallbackFact] = [:]
    private var bindings: [String: String] = [:]

    func pending(now: Date) throws -> [WatchFallbackPositionUpdate] {
        _ = now
        lock.lock()
        defer { lock.unlock() }
        return values.values.sorted { $0.observedAt < $1.observedAt }
    }

    func sourceBinding(positionUpdateID: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return bindings[positionUpdateID]
    }

    func store(_ update: WatchFallbackPositionUpdate, sourceBinding: String?) throws {
        lock.lock()
        if let existing = bindings[update.positionUpdateId], existing != sourceBinding {
            lock.unlock()
            throw WatchAPIError.persistenceFailed
        }
        values[update.positionUpdateId] = update
        if let sourceBinding { bindings[update.positionUpdateId] = sourceBinding }
        lock.unlock()
    }

    func acknowledge(positionUpdateID: String) throws {
        lock.lock()
        values.removeValue(forKey: positionUpdateID)
        if isolated[positionUpdateID] == nil { bindings.removeValue(forKey: positionUpdateID) }
        lock.unlock()
    }

    func sealedState(eventID: String) throws -> WatchEventStateSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        return sealed[eventID]
    }

    func seal(_ state: WatchEventStateSnapshot) throws {
        lock.lock()
        defer { lock.unlock() }
        sealed[state.eventId] = state
    }

    func quarantine(_ update: WatchFallbackPositionUpdate, reason: QuarantinedWatchFallbackFact.Reason,
        serverWindow: WatchEventStateSnapshot?, statusCode: Int?) throws {
        lock.lock()
        defer { lock.unlock() }
        isolated[update.positionUpdateId] = QuarantinedWatchFallbackFact(update: update, reason: reason,
            serverWindow: serverWindow, statusCode: statusCode)
        values.removeValue(forKey: update.positionUpdateId)
    }

    func isolatedFacts() -> [QuarantinedWatchFallbackFact] {
        lock.lock()
        defer { lock.unlock() }
        return Array(isolated.values)
    }

    func discardExpired(now: Date) throws -> [String] {
        _ = now
        return []
    }
}

private actor MemoryFallbackReporter: WatchFallbackReporting {
    private var shouldFail: Bool
    private var values: [WatchFallbackPositionUpdate] = []
    private var states: [String: WatchEventStateSnapshot] = [:]
    private var stateError: WatchAPIError?
    private var revision = 0
    private var reportError: WatchAPIError?
    private var suspendReport = false
    private var reportContinuation: CheckedContinuation<Void, Never>?
    private var source = String(repeating: "a", count: 64)
    private var sourceCheckCount = 0
    private var suspendSourceAtCall: Int?
    private var sourceContinuation: CheckedContinuation<Void, Never>?

    init(shouldFail: Bool = false) {
        self.shouldFail = shouldFail
    }

    func authorizationRevision() -> Int { revision }
    func observationSourceBinding() async -> String? {
        sourceCheckCount += 1
        if sourceCheckCount == suspendSourceAtCall {
            suspendSourceAtCall = nil
            await withCheckedContinuation { sourceContinuation = $0 }
        }
        return source
    }
    func setSource(_ value: String) { source = value; revision += 1 }
    func suspendSourceCheck(atCall call: Int) { suspendSourceAtCall = call }
    func isSourceSuspended() -> Bool { sourceContinuation != nil }
    func releaseSourceCheck() { sourceContinuation?.resume(); sourceContinuation = nil }
    func setAuthorizationRevision(_ value: Int) { revision = value }
    func setEventState(_ state: WatchEventStateSnapshot) { states[state.eventId] = state }
    func setStateError(_ error: WatchAPIError?) { stateError = error }
    func setReportError(_ error: WatchAPIError?) { reportError = error }
    func suspendNextReport() { suspendReport = true }
    func isSuspended() -> Bool { reportContinuation != nil }
    func releaseReport() { reportContinuation?.resume(); reportContinuation = nil }
    func fetchEventState(eventID: String) async throws -> WatchEventStateSnapshot {
        if let stateError { throw stateError }
        return states[eventID] ?? WatchEventStateSnapshot(eventId: eventID, state: .active,
            createdAt: Date(timeIntervalSince1970: 0), resolvedAt: nil)
    }

    func reportFallbackPosition(_ update: WatchFallbackPositionUpdate, expectedSourceBinding: String?) async throws -> PositionUpdateResult {
        if let expectedSourceBinding, expectedSourceBinding != source { throw WatchAPIError.sessionChanged }
        values.append(update)
        if let reportError { throw reportError }
        if shouldFail { throw TestFallbackError.network }
        if suspendReport {
            suspendReport = false
            await withCheckedContinuation { reportContinuation = $0 }
        }
        if let expectedSourceBinding, expectedSourceBinding != source { throw WatchAPIError.sessionChanged }
        return PositionUpdateResult(
            positionUpdateId: update.positionUpdateId,
            applied: true,
            idempotent: false,
            ignoredAsStale: false,
            positionObservedAt: update.observedAt,
            serverReceivedAt: update.observedAt
        )
    }

    func setShouldFail(_ value: Bool) {
        shouldFail = value
    }

    func updateCount() -> Int { values.count }
    func updates() -> [WatchFallbackPositionUpdate] { values }
}

@MainActor
private final class FixedFallbackPositionProvider: WatchFallbackPositionProviding {
    var onSignificantPositionChange: ((WatchFallbackPositionSample) -> Void)?
    var startCount = 0
    var stopCount = 0
    var sample: WatchFallbackPositionSample? = WatchFallbackPositionSample(
        patientPosition: try! PatientPosition(
            latitude: 22.1987,
            longitude: 113.5439,
            accuracyMeters: 12
        ),
        observedAt: Date(timeIntervalSince1970: 1_788_000_000)
    )

    func startFallbackUpdates() {
        startCount += 1
    }

    func stopFallbackUpdates() {
        stopCount += 1
    }

    func fallbackSnapshot() -> WatchFallbackPositionSample? {
        sample
    }
}

private final class LockedIDGenerator: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 1

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        defer { value += 1 }
        return "position-\(value)"
    }
}

private enum TestFallbackError: Error {
    case network
}


@MainActor
final class C4bReviewRaceTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_788_000_000)
    private let eid = "00000000-0000-4000-8000-000000000999"
    private let link = WatchConnectivityState(activationState: .inactive, iphoneReachable: false)

    func testStopDuringPostUploadAuthorizationCheckMustNotAcknowledgeOldGeneration() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: url) }
        let outbox = ProtectedFileWatchFallbackOutbox(fileURL: url)
        let reporter = ReviewReporter(pauseRevisionCall: nil)
        await reporter.pauseAfterReportAuthorizationCheck()
        let provider = ReviewPosition(start: start)
        let c = WatchFallbackCoordinator(stateStore: ReviewState(), outbox: outbox, reporter: reporter, positionProvider: provider, makeID: { "review-position" })
        let pending = Task { await c.activate(eventID: eid, fallDetectedAt: start, connectivity: link, networkAvailable: true, observedAt: start) }
        for _ in 0..<200 { if await reporter.isSuspended { break }; try await Task.sleep(for: .milliseconds(2)) }
        guard await reporter.isSuspended else { pending.cancel(); XCTFail("Reporter did not reach post-upload authorization suspension"); return }
        await c.stop()
        await reporter.release()
        let result = await pending.value
        XCTAssertEqual(result, .waitingForServerState)
        XCTAssertEqual(try outbox.pending(now: start).count, 1, "Old generation must retain the unconfirmed local record")
    }

    func testConcurrentRecoveryShouldNotStopValidCurrentSampling() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: url) }
        let outbox = ProtectedFileWatchFallbackOutbox(fileURL: url)
        let reporter = ReviewReporter(pauseRevisionCall: nil)
        let provider = ReviewPosition(start: start)
        let c = WatchFallbackCoordinator(stateStore: ReviewState(), outbox: outbox, reporter: reporter, positionProvider: provider, makeID: { "review-position" })
        _ = await c.activate(eventID: eid, fallDetectedAt: start, connectivity: link, networkAvailable: true, observedAt: start)
        XCTAssertTrue(provider.collecting)
        await reporter.pauseNextFetch()
        let recovery = Task { await c.recoverEventState(networkAvailable: true, observedAt: start.addingTimeInterval(10)) }
        for _ in 0..<200 { if await reporter.isSuspended { break }; try await Task.sleep(for: .milliseconds(2)) }
        guard await reporter.isSuspended else { recovery.cancel(); XCTFail("Reporter did not reach GET suspension"); return }
        _ = await c.periodicReport(connectivity: link, networkAvailable: true, observedAt: start.addingTimeInterval(10))
        XCTAssertTrue(provider.collecting, "In-progress duplicate recovery must not suspend the already-authorized active event's sampler")
        await reporter.release()
        _ = await recovery.value
    }
    func testChangedEligibilityWhileGETWaitsCannotRestartCapturedSampling() async throws {
        for becomesReachable in [true, false] {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
            defer { try? FileManager.default.removeItem(at: url) }
            let outbox = ProtectedFileWatchFallbackOutbox(fileURL: url)
            let reporter = ReviewReporter(pauseRevisionCall: nil)
            let provider = ReviewPosition(start: start)
            let c = WatchFallbackCoordinator(stateStore: ReviewState(), outbox: outbox, reporter: reporter, positionProvider: provider, makeID: { "review-position" })
            await reporter.pauseNextFetch()
            let initial = Task { await c.activate(eventID: eid, fallDetectedAt: start, connectivity: link, networkAvailable: true, observedAt: start) }
            for _ in 0..<200 { if await reporter.isSuspended { break }; try await Task.sleep(for: .milliseconds(2)) }
            guard await reporter.isSuspended else { initial.cancel(); XCTFail("Reporter did not suspend GET"); return }
            if becomesReachable {
                _ = await c.connectivityDidChange(WatchConnectivityState(activationState: .activated, iphoneReachable: true), networkAvailable: true, observedAt: start.addingTimeInterval(1))
            } else {
                _ = await c.networkDidChange(false, connectivity: link, observedAt: start.addingTimeInterval(1))
            }
            await reporter.release()
            _ = await initial.value
            XCTAssertFalse(provider.collecting, "Old GET must not revive collection after a current eligibility change")
            let count = await reporter.reportCount
            XCTAssertEqual(count, 0, "No request may use the old captured eligibility")
        }
    }

}

private final class ReviewState: @unchecked Sendable, WatchFallbackStatePersisting {
    private let lock = NSLock()
    private var current: PersistedWatchFallbackEvent?
    func activeEvent() -> PersistedWatchFallbackEvent? { lock.lock(); defer { lock.unlock() }; return current }
    func setActiveEvent(_ event: PersistedWatchFallbackEvent?) { lock.lock(); defer { lock.unlock() }; current = event }
}

@MainActor
private final class ReviewPosition: WatchFallbackPositionProviding {
    var onSignificantPositionChange: ((WatchFallbackPositionSample) -> Void)?
    private let start: Date
    var collecting = false
    init(start: Date) { self.start = start }
    func startFallbackUpdates() { collecting = true }
    func stopFallbackUpdates() { collecting = false }
    func fallbackSnapshot() -> WatchFallbackPositionSample? { WatchFallbackPositionSample(patientPosition: try! PatientPosition(latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12), observedAt: start) }
}

private actor ReviewReporter: WatchFallbackReporting {
    let pauseRevisionCall: Int?
    private var revisionCalls = 0
    private(set) var reportCount = 0
    private var suspendFetch = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var pauseNextRevision = false
    private var armPostReportRevisionPause = false
    func observationSourceBinding() -> String? { String(repeating: "a", count: 64) }
    init(pauseRevisionCall: Int?) { self.pauseRevisionCall = pauseRevisionCall }
    var isSuspended: Bool { continuation != nil }
    func pauseNextFetch() { suspendFetch = true }
    func pauseAfterReportAuthorizationCheck() { armPostReportRevisionPause = true }
    func release() { continuation?.resume(); continuation = nil }
    func authorizationRevision() async -> Int {
        revisionCalls += 1
        if revisionCalls == pauseRevisionCall || pauseNextRevision {
            pauseNextRevision = false
            await withCheckedContinuation { continuation = $0 }
        }
        return 0
    }
    func fetchEventState(eventID: String) async throws -> WatchEventStateSnapshot {
        if suspendFetch { suspendFetch = false; await withCheckedContinuation { continuation = $0 } }
        return WatchEventStateSnapshot(eventId: eventID, state: .active, createdAt: Date(timeIntervalSince1970: 0), resolvedAt: nil)
    }
    func reportFallbackPosition(_ update: WatchFallbackPositionUpdate, expectedSourceBinding: String?) async throws -> PositionUpdateResult {
        if let expectedSourceBinding, expectedSourceBinding != String(repeating: "a", count: 64) {
            throw WatchAPIError.sessionChanged
        }
        if armPostReportRevisionPause {
            armPostReportRevisionPause = false
            pauseNextRevision = true
        }
        reportCount += 1
        return PositionUpdateResult(positionUpdateId: update.positionUpdateId, applied: true, idempotent: false, ignoredAsStale: false, positionObservedAt: update.observedAt, serverReceivedAt: update.observedAt)
    }
}
