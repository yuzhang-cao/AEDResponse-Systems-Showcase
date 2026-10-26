import Foundation
import XCTest
@testable import AEDResponse

final class EventPositionWindowReconciliationCoordinatorTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_780_000_000)

    private var context: EventPositionFactContext {
        EventPositionFactContext(
            serviceNamespace: "https://example.invalid/api/v2/",
            userID: "user-1",
            deviceInstanceID: "device-1",
            eventID: "event-1",
            role: .responder,
            generation: 1
        )
    }

    func testPendingBatchKeepsLegalRecordsAndQuarantinesOutsideWindow() throws {
        let records = try [0, 1, 2].map { offset in
            try EventPositionRecord.noNewFix(
                recordID: "record-\(offset)",
                slotAt: base.addingTimeInterval(TimeInterval(offset))
            )
        }
        let batch = try EventPositionBatch(
            eventId: context.eventID,
            batchId: "batch-original",
            records: records
        )
        let pending = try PersistedEventPositionBatch(
            serviceNamespace: context.serviceNamespace,
            userId: context.userID,
            deviceInstanceId: context.deviceInstanceID,
            eventId: context.eventID,
            role: context.role,
            generation: context.generation,
            windowStartedAt: base,
            batch: batch
        )
        let coordinator = EventPositionWindowReconciliationCoordinator {
            "replacement-batch"
        }

        let result = try XCTUnwrap(coordinator.reconcile(
            context: context,
            startedAt: base.addingTimeInterval(1),
            endedAt: base.addingTimeInterval(3),
            currentStartedAt: nil,
            currentEndedAt: nil,
            openFacts: EventPositionOpenFacts(
                openSlots: [],
                clockedSlots: [],
                appNotRunningSlots: [],
                candidatesBySlot: [:]
            ),
            queueState: EventPositionQueueState(pendingBatches: [pending]),
            now: base.addingTimeInterval(10)
        ))

        XCTAssertEqual(result.queueState.pendingBatches.count, 1)
        XCTAssertEqual(
            result.queueState.pendingBatches[0].batch.records.map(\.recordId),
            ["record-1", "record-2"]
        )
        XCTAssertEqual(result.queueState.pendingBatches[0].batch.batchId, "replacement-batch")
        XCTAssertEqual(result.queueState.quarantinedEvidence.count, 1)
        XCTAssertEqual(
            result.queueState.quarantinedEvidence[0].reason,
            .beforeParticipationStart
        )
        XCTAssertEqual(
            result.queueState.authoritativeEndedAtByContext[context.key],
            base.addingTimeInterval(3)
        )
    }

    func testOpenFactsAreQuarantinedWithoutMutatingInputSnapshot() throws {
        let validCoordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: base.addingTimeInterval(1.2)
        )
        let input = EventPositionOpenFacts(
            openSlots: [
                base,
                base.addingTimeInterval(1),
                base.addingTimeInterval(2)
            ],
            clockedSlots: [
                base,
                base.addingTimeInterval(1),
                base.addingTimeInterval(2)
            ],
            appNotRunningSlots: [],
            candidatesBySlot: [base.addingTimeInterval(1): validCoordinate]
        )
        let coordinator = EventPositionWindowReconciliationCoordinator {
            "unused"
        }

        let result = try XCTUnwrap(coordinator.reconcile(
            context: context,
            startedAt: base.addingTimeInterval(1),
            endedAt: base.addingTimeInterval(2),
            currentStartedAt: nil,
            currentEndedAt: nil,
            openFacts: input,
            queueState: EventPositionQueueState(),
            now: base.addingTimeInterval(10)
        ))

        XCTAssertEqual(input.openSlots.count, 3)
        XCTAssertEqual(result.openFacts.openSlots, [base.addingTimeInterval(1)])
        XCTAssertEqual(result.openFacts.clockedSlots, [base.addingTimeInterval(1)])
        XCTAssertEqual(result.openFacts.candidatesBySlot[base.addingTimeInterval(1)], validCoordinate)
        XCTAssertEqual(result.queueState.quarantinedEvidence.count, 2)
        XCTAssertEqual(
            Set(result.queueState.quarantinedEvidence.map(\.reason)),
            [.beforeParticipationStart, .participationEnded]
        )
    }

    /// Recovery after an exit ACK that arrived while the protected queue was
    /// unavailable: only the durable draft survives, no in-memory context does.
    /// The ACK's exclusive end must still window that draft and be recorded, or
    /// the context can never be closed.
    func testPersistedOpenDraftIsWindowedAndRecordsAuthoritativeEnd() throws {
        let draft = try EventPositionOpenDraft(
            serviceNamespace: context.serviceNamespace,
            userId: context.userID,
            deviceInstanceId: context.deviceInstanceID,
            eventId: context.eventID,
            role: context.role,
            generation: context.generation,
            openSlots: [base, base.addingTimeInterval(1), base.addingTimeInterval(2)],
            clockedSlots: [base, base.addingTimeInterval(1), base.addingTimeInterval(2)],
            candidates: [
                EventPositionSlotCandidate(
                    slotAt: base.addingTimeInterval(1),
                    coordinate: DeviceCoordinate(
                        latitude: 22.198,
                        longitude: 113.543,
                        accuracyMeters: 8,
                        observedAt: base.addingTimeInterval(1.2)
                    )
                )
            ]
        )
        let queueState = EventPositionQueueState(
            openDraftsByContext: [context.key: draft]
        )
        let coordinator = EventPositionWindowReconciliationCoordinator { "unused" }
        let endedAt = base.addingTimeInterval(2)

        let result = try coordinator.reconcilePersistedOpenDraft(
            context: context,
            startedAt: nil,
            endedAt: endedAt,
            queueState: queueState,
            now: base.addingTimeInterval(10)
        )

        // The authoritative end is recorded so later recovery can replay it, and
        // the second that crossed ACK.exitedAt is quarantined instead of being
        // kept as in-window evidence.
        XCTAssertEqual(result.authoritativeEndedAtByContext[context.key], endedAt)
        XCTAssertEqual(result.quarantinedEvidence.map(\.reason), [.participationEnded])
        let remaining = try XCTUnwrap(result.openDraftsByContext[context.key])
        XCTAssertEqual(
            remaining.openSlots,
            [base, base.addingTimeInterval(1)],
            "合法秒必须留在草稿中，只有越过 ACK.exitedAt 的秒被隔离"
        )
    }

    /// A context that is not present in the queue must be left untouched.
    func testPersistedOpenDraftReconciliationIgnoresUnknownContext() throws {
        let coordinator = EventPositionWindowReconciliationCoordinator { "unused" }
        let other = EventPositionFactContext(
            serviceNamespace: context.serviceNamespace,
            userID: context.userID,
            deviceInstanceID: context.deviceInstanceID,
            eventID: "event-other",
            role: .responder,
            generation: 1
        )
        let result = try coordinator.reconcilePersistedOpenDraft(
            context: other,
            startedAt: nil,
            endedAt: base,
            queueState: EventPositionQueueState(),
            now: base
        )
        XCTAssertTrue(result.authoritativeEndedAtByContext.isEmpty)
        XCTAssertTrue(result.openDraftsByContext.isEmpty)
        XCTAssertTrue(result.quarantinedEvidence.isEmpty)
    }

    /// A persisted open draft that a retried exit window must be able to close on
    /// its own: this is the storage-level half of the parked-ACK recovery, where
    /// no in-memory context exists because the process already restarted.
    func testPersistedOpenDraftReconciliationIsIdempotentAcrossRetries() throws {
        let draft = try EventPositionOpenDraft(
            serviceNamespace: context.serviceNamespace,
            userId: context.userID,
            deviceInstanceId: context.deviceInstanceID,
            eventId: context.eventID,
            role: context.role,
            generation: context.generation,
            openSlots: [base, base.addingTimeInterval(1)],
            clockedSlots: [base, base.addingTimeInterval(1)],
            candidates: []
        )
        let queueState = EventPositionQueueState(openDraftsByContext: [context.key: draft])
        let coordinator = EventPositionWindowReconciliationCoordinator { "unused" }
        let endedAt = base.addingTimeInterval(1)

        // First retry quarantines the slot past the exclusive end and records it.
        let first = try coordinator.reconcilePersistedOpenDraft(
            context: context,
            startedAt: nil,
            endedAt: endedAt,
            queueState: queueState,
            now: base.addingTimeInterval(10)
        )
        XCTAssertEqual(first.authoritativeEndedAtByContext[context.key], endedAt)
        XCTAssertEqual(first.quarantinedEvidence.map(\.slotAt), [base.addingTimeInterval(1)])

        // A later retry of the same window must not quarantine the same slot twice
        // or re-open it: the boundary is already recorded and the draft is stable.
        let second = try coordinator.reconcilePersistedOpenDraft(
            context: context,
            startedAt: nil,
            endedAt: endedAt,
            queueState: first,
            now: base.addingTimeInterval(20)
        )
        XCTAssertEqual(second.authoritativeEndedAtByContext[context.key], endedAt)
        XCTAssertEqual(
            second.quarantinedEvidence.count,
            first.quarantinedEvidence.count,
            "重放同一权威窗口不得重复隔离同一秒"
        )
        XCTAssertEqual(
            second.openDraftsByContext[context.key]?.openSlots,
            [base],
            "已收束的草稿在重放后必须保持稳定"
        )
    }
}
