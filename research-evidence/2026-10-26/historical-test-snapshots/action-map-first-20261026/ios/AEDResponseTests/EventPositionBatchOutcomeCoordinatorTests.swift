import Foundation
import XCTest
@testable import AEDResponse

final class EventPositionBatchOutcomeCoordinatorTests: XCTestCase {
    private let slot = Date(timeIntervalSince1970: 1_780_000_100)

    private func pending(batchID: String) throws -> PersistedEventPositionBatch {
        let eventID = "event-outcome"
        let record = try EventPositionRecord.noNewFix(
            recordID: "record-\(batchID)",
            slotAt: slot,
            gapReason: .noFix
        )
        return try PersistedEventPositionBatch(
            serviceNamespace: "https://example.invalid/api/v2/",
            userId: "user-1",
            deviceInstanceId: "device-1",
            eventId: eventID,
            role: .patient,
            generation: 1,
            windowStartedAt: slot,
            batch: try EventPositionBatch(
                eventId: eventID,
                batchId: batchID,
                records: [record]
            )
        )
    }

    func testAcknowledgementRemovesOnlyTheExactBatch() throws {
        let original = try pending(batchID: "batch-original")
        let following = try pending(batchID: "batch-following")
        let ack = EventPositionBatchAck(
            schemaVersion: "2.0",
            eventId: original.eventId,
            batchId: original.batch.batchId,
            acceptedRecordCount: 1,
            idempotent: false,
            acknowledgedAt: slot.addingTimeInterval(10),
            records: [EventPositionRecordAck(
                recordId: original.batch.records[0].recordId,
                persisted: true,
                appliedToLatest: false,
                ignoredAsStale: false,
                serverReceivedAt: slot.addingTimeInterval(10)
            )]
        )
        let coordinator = EventPositionBatchOutcomeCoordinator()

        let result = try XCTUnwrap(coordinator.acknowledge(
            original,
            ack: ack,
            queueState: EventPositionQueueState(pendingBatches: [original, following])
        ))

        XCTAssertEqual(result.ack, ack)
        XCTAssertEqual(result.queueState.pendingBatches.map { $0.batch.batchId }, ["batch-following"])
        XCTAssertNil(coordinator.acknowledge(
            original,
            ack: EventPositionBatchAck(
                schemaVersion: "2.0",
                eventId: original.eventId,
                batchId: original.batch.batchId,
                acceptedRecordCount: 0,
                idempotent: false,
                acknowledgedAt: slot,
                records: []
            ),
            queueState: EventPositionQueueState(pendingBatches: [original])
        ))
    }

    func testPermanentFailureBlocksTheMatchingBatchAndPreservesFacts() throws {
        let original = try pending(batchID: "batch-original")
        let following = try pending(batchID: "batch-following")
        let error = NSError(
            domain: "AEDResponseTests",
            code: 422,
            userInfo: [NSLocalizedDescriptionKey: "内容冲突"]
        )
        let coordinator = EventPositionBatchOutcomeCoordinator()

        let state = try XCTUnwrap(coordinator.isolate(
            original,
            error: error,
            queueState: EventPositionQueueState(pendingBatches: [original, following])
        ))

        XCTAssertEqual(state.pendingBatches.count, 2)
        XCTAssertEqual(state.pendingBatches[0].batch.records, original.batch.records)
        XCTAssertEqual(state.pendingBatches[0].blockedReason, "内容冲突")
        XCTAssertNil(state.pendingBatches[1].blockedReason)
        let noMatch = try coordinator.isolate(
            original,
            error: error,
            queueState: EventPositionQueueState()
        )
        XCTAssertNil(noMatch)
    }
}
