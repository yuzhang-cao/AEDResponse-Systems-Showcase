import Foundation
import XCTest
@testable import AEDResponse

/// G10 — the event-position queue must be bounded without ever losing a fact.
///
/// Two properties are pinned here, and the second is the one that matters:
///
///   1. already-sealed quarantine (rows whose fact the server is confirmed to
///      hold) is compacted oldest-first once it exceeds its retention count, and
///      the number dropped is COUNTED rather than forgotten;
///   2. unconfirmed evidence — batches without a REST ACK, and quarantine rows the
///      server has not been confirmed to hold — is never evicted, never trimmed
///      to make room, and never rewritten.  When the device is full the write is
///      REFUSED with a reason, and the refusal is what pauses capture.
final class EventPositionQueueGrowthTests: XCTestCase {
    private let policy = EventPositionQueueGrowthPolicy(
        sealedEvidenceRetentionCount: 3,
        unconfirmedEvidenceRefusalCount: 4,
        pendingBatchRefusalCount: 2
    )

    // MARK: - Fixtures

    private func quarantineRow(
        slot: Int,
        eventID: String = "event-1",
        reason: EventPositionQuarantineReason = .participationEnded,
        serviceNamespace: String = "https://example.test/api/v2/"
    ) -> QuarantinedEventPositionEvidence {
        QuarantinedEventPositionEvidence(
            serviceNamespace: serviceNamespace,
            userId: "user-1",
            deviceInstanceId: "device-1",
            eventId: eventID,
            role: .responder,
            generation: 1,
            originalBatchId: nil,
            slotAt: Date(timeIntervalSince1970: 1_788_000_000 + Double(slot)),
            record: nil,
            coordinate: nil,
            wasClocked: true,
            reason: reason,
            quarantinedAt: Date(timeIntervalSince1970: 1_788_000_000 + Double(slot))
        )
    }

    private func pendingBatch(
        eventID: String = "event-1",
        batchID: String = UUID().uuidString,
        blockedReason: String? = nil
    ) throws -> PersistedEventPositionBatch {
        let slot = Date(timeIntervalSince1970: 1_788_000_000)
        let batch = try EventPositionBatch(
            eventId: eventID,
            batchId: batchID,
            records: [
                EventPositionRecord(
                    recordId: UUID().uuidString,
                    slotAt: slot,
                    status: .noNewFix,
                    gapReason: .noFix
                )
            ]
        )
        return try PersistedEventPositionBatch(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-1",
            deviceInstanceId: "device-1",
            eventId: eventID,
            role: .responder,
            generation: 1,
            windowStartedAt: slot,
            batch: batch,
            anchorPosition: nil,
            blockedReason: blockedReason
        )
    }

    // MARK: - Sealed evidence is bounded

    func testSealedEvidenceIsCompactedOldestFirstAndCounted() {
        var state = EventPositionQueueState()
        // Six rows, all confirmed by the server.
        state.quarantinedEvidence = (1...6).map { quarantineRow(slot: $0) }
        let sealed = EventPositionQueueGrowth.sealConfirmedEvidence(
            state,
            policy: policy,
            isSealed: { _ in true }
        )

        XCTAssertEqual(sealed.quarantinedEvidence.count, 0,
                       "confirmed rows leave the unconfirmed list")
        XCTAssertEqual(sealed.sealedQuarantineEvidence.count, policy.sealedEvidenceRetentionCount,
                       "sealed evidence is bounded by the policy, not by history")
        XCTAssertEqual(sealed.compactedSealedEvidenceCount, 3,
                       "the rows dropped by compaction are counted, not forgotten")
        // The three kept rows are the NEWEST ones: compaction drops oldest first.
        XCTAssertEqual(
            sealed.sealedQuarantineEvidence.map(\.slotAt),
            (4...6).map { quarantineRow(slot: $0).slotAt },
            "compaction must drop the oldest audit rows and keep the recent ones"
        )
    }

    func testUnconfirmedRowsAreNeverSealedOrDropped() {
        var state = EventPositionQueueState()
        state.quarantinedEvidence = (1...5).map { quarantineRow(slot: $0) }
        let untouched = EventPositionQueueGrowth.sealConfirmedEvidence(
            state,
            policy: policy,
            isSealed: { _ in false }
        )
        XCTAssertEqual(untouched.quarantinedEvidence, state.quarantinedEvidence,
                       "a row the server has not confirmed is left exactly as it was")
        XCTAssertEqual(untouched.sealedQuarantineEvidence.count, 0)
        XCTAssertEqual(untouched.compactedSealedEvidenceCount, 0)
    }

    func testSealingIsSelectivePerContext() {
        var state = EventPositionQueueState()
        state.quarantinedEvidence = [
            quarantineRow(slot: 1, eventID: "closed-event"),
            quarantineRow(slot: 2, eventID: "live-event"),
            quarantineRow(slot: 3, eventID: "closed-event")
        ]
        let sealed = EventPositionQueueGrowth.sealConfirmedEvidence(
            state,
            policy: policy,
            isSealed: { $0.eventId == "closed-event" }
        )
        XCTAssertEqual(sealed.quarantinedEvidence.map(\.eventId), ["live-event"],
                       "only the closed event's rows are confirmed")
        XCTAssertEqual(sealed.sealedQuarantineEvidence.count, 2)
    }

    // MARK: - Capacity refusal instead of eviction

    func testCapacityRefusalNamesTheUnconfirmedCountAndLimit() {
        var state = EventPositionQueueState()
        state.quarantinedEvidence = (1...(policy.unconfirmedEvidenceRefusalCount + 1))
            .map { quarantineRow(slot: $0) }
        let refusal = EventPositionQueueGrowth.capacityRefusal(state, policy: policy)
        XCTAssertEqual(refusal, .unconfirmedEvidenceAtCapacity(
            count: policy.unconfirmedEvidenceRefusalCount + 1,
            limit: policy.unconfirmedEvidenceRefusalCount
        ))
        XCTAssertEqual(refusal?.localizedDescription.contains("不会"), false,
                       "the refusal explains what happens, not just that it failed")
        XCTAssertTrue(refusal?.localizedDescription.contains("暂停") == true,
                      "the message tells the user capture is paused rather than data lost")
    }

    func testCapacityRefusalCoversPendingBatches() throws {
        var state = EventPositionQueueState()
        state.pendingBatches = try (1...(policy.pendingBatchRefusalCount + 1)).map {
            try pendingBatch(batchID: "batch-\($0)")
        }
        XCTAssertEqual(
            EventPositionQueueGrowth.capacityRefusal(state, policy: policy),
            .pendingBatchesAtCapacity(
                count: policy.pendingBatchRefusalCount + 1,
                limit: policy.pendingBatchRefusalCount
            )
        )
    }

    func testSealedEvidenceAloneNeverTriggersARefusal() {
        var state = EventPositionQueueState()
        // Far above every limit, but all of it is already confirmed.
        state.sealedQuarantineEvidence = (1...10_000).map { quarantineRow(slot: $0) }
        state.compactedSealedEvidenceCount = 500
        XCTAssertNil(EventPositionQueueGrowth.capacityRefusal(state, policy: policy),
                     "bounded sealed evidence can never be the reason to refuse a write")
        let snapshot = EventPositionQueueGrowth.snapshot(state, policy: policy)
        XCTAssertFalse(snapshot.isAtCapacity)
        XCTAssertEqual(snapshot.sealedQuarantineCount, 10_000)
        XCTAssertEqual(snapshot.compactedSealedCount, 500)
    }

    // MARK: - The refusal actually reaches the persistence boundary

    @MainActor
    func testPersistenceCoordinatorRefusesRatherThanTrimming() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("growth-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let coordinator = EventPositionQueuePersistenceCoordinator(
            store: ProtectedEventPositionQueueStore(fileURL: url),
            policy: policy
        )
        XCTAssertNotNil(coordinator.load())

        // Under the limit: saved.
        var small = EventPositionQueueState()
        small.quarantinedEvidence = [quarantineRow(slot: 1)]
        XCTAssertEqual(coordinator.save(small), .persisted)
        XCTAssertNil(coordinator.lastGrowthRefusal)

        // Over the limit: refused, and the reason is kept for the user.
        var large = EventPositionQueueState()
        large.quarantinedEvidence = (1...(policy.unconfirmedEvidenceRefusalCount + 2))
            .map { quarantineRow(slot: $0) }
        let outcome = coordinator.save(large)
        XCTAssertEqual(
            outcome,
            .refused(.unconfirmedEvidenceAtCapacity(
                count: policy.unconfirmedEvidenceRefusalCount + 2,
                limit: policy.unconfirmedEvidenceRefusalCount
            ))
        )
        XCTAssertFalse(outcome.persistedSuccessfully,
                       "a refused write must not be mistaken for success")
        XCTAssertNotNil(coordinator.lastGrowthRefusal)
        XCTAssertTrue(coordinator.isBlocked,
                      "capture stays blocked while the device is out of budget")

        // The good state on disk is untouched: refusing does not damage evidence.
        let reloaded = try ProtectedEventPositionQueueStore(fileURL: url).load()
        XCTAssertEqual(reloaded.quarantinedEvidence.count, 1,
                       "the refusal must leave the previously saved evidence intact")
    }

    @MainActor
    func testTheProtectedStoreRejectsAnyDeletionOfUnconfirmedOrSealedEvidence() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("deletion-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = ProtectedEventPositionQueueStore(fileURL: url)

        var state = EventPositionQueueState()
        state.quarantinedEvidence = [quarantineRow(slot: 1), quarantineRow(slot: 2)]
        state.sealedQuarantineEvidence = [quarantineRow(slot: 3)]
        try store.save(state)

        var droppedUnconfirmed = state
        droppedUnconfirmed.quarantinedEvidence.removeLast()
        XCTAssertThrowsError(try store.save(droppedUnconfirmed)) { error in
            XCTAssertEqual(error as? EventPositionQueuePersistenceError, .appendOnlyViolation)
        }

        // Sealed evidence may only shrink through COUNTED compaction.
        var uncounted = state
        uncounted.sealedQuarantineEvidence = []
        XCTAssertThrowsError(try store.save(uncounted)) { error in
            XCTAssertEqual(error as? EventPositionQueuePersistenceError, .appendOnlyViolation)
        }

        var counted = state
        counted.sealedQuarantineEvidence = []
        counted.compactedSealedEvidenceCount = state.compactedSealedEvidenceCount + 1
        XCTAssertNoThrow(try store.save(counted),
                         "compaction is allowed precisely because it is counted")
    }

    // MARK: - Snapshot

    func testSnapshotReportsDepthAndBlocksWithoutHidingAnything() throws {
        var state = EventPositionQueueState()
        state.pendingBatches = [
            try pendingBatch(batchID: "a"),
            try pendingBatch(batchID: "b", blockedReason: "permanent 4xx")
        ]
        state.quarantinedEvidence = [quarantineRow(slot: 1), quarantineRow(slot: 2)]
        state.sealedQuarantineEvidence = [quarantineRow(slot: 3)]
        state.compactedSealedEvidenceCount = 7

        let snapshot = EventPositionQueueGrowth.snapshot(state, policy: policy)
        XCTAssertEqual(snapshot.pendingBatchCount, 2)
        XCTAssertEqual(snapshot.pendingRecordCount, 2)
        XCTAssertEqual(snapshot.blockedBatchCount, 1)
        XCTAssertEqual(snapshot.unconfirmedQuarantineCount, 2)
        XCTAssertEqual(snapshot.sealedQuarantineCount, 1)
        XCTAssertEqual(snapshot.compactedSealedCount, 7)
        XCTAssertFalse(snapshot.isAtCapacity)
    }

    func testDeletionViolationDistinguishesCompactionFromLoss() throws {
        var state = EventPositionQueueState()
        state.quarantinedEvidence = [quarantineRow(slot: 1)]
        state.sealedQuarantineEvidence = [quarantineRow(slot: 2)]

        var compacted = state
        compacted.sealedQuarantineEvidence = []
        compacted.compactedSealedEvidenceCount = 1
        XCTAssertNil(EventPositionQueueGrowth.deletionViolation(previous: state, next: compacted))

        var lost = state
        lost.quarantinedEvidence = []
        XCTAssertEqual(
            EventPositionQueueGrowth.deletionViolation(previous: state, next: lost),
            .sealedEvidenceCannotBeDeleted
        )
    }
}
