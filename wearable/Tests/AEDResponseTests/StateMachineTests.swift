import Foundation
import XCTest
@testable import AEDResponseCore

final class StateMachineTests: XCTestCase {
    private let baseDate = Date(timeIntervalSince1970: 1_788_000_000)

    func testPostCallFalseAlarmRequiresExplicitPatientAction() throws {
        var machine = EmergencyEventMachine(event: try makeActiveEvent())

        try machine.confirmFalseAlarm(at: baseDate.addingTimeInterval(30))

        XCTAssertEqual(machine.event.state, .cancelledConfirmedFalseAlarm)
        XCTAssertEqual(machine.event.recruitmentState, .stopped)
        XCTAssertEqual(machine.event.resolvedAt, baseDate.addingTimeInterval(30))
        XCTAssertThrowsError(
            try machine.confirmFalseAlarm(at: baseDate.addingTimeInterval(31))
        )
    }

    func testRealEventRequiresExplicitAuthorizedResolution() throws {
        for actor in [
            ResolutionActor.patient,
            .onSceneResponder,
            .authorizedOperator
        ] {
            var machine = EmergencyEventMachine(event: try makeActiveEvent())
            try machine.resolve(by: actor, at: baseDate.addingTimeInterval(60))
            XCTAssertEqual(machine.event.state, .resolved)
            XCTAssertEqual(machine.event.recruitmentState, .completed)
        }
    }

    func testPassiveRecoverySignalsNeverEndActiveEvent() throws {
        var machine = EmergencyEventMachine(event: try makeActiveEvent())

        for signal in PassiveFollowUpObservation.allCases {
            XCTAssertFalse(machine.observePassive(signal))
            XCTAssertEqual(machine.event.state, .active)
            XCTAssertEqual(machine.event.recruitmentState, .recruiting)
            XCTAssertNil(machine.event.resolvedAt)
        }
    }

    func testReceiptMustAdvanceWithoutSkippingOrGoingBack() throws {
        var receipt = DeliveryReceiptMachine()

        XCTAssertThrowsError(try receipt.advance(to: .viewed))
        XCTAssertTrue(try receipt.advance(to: .delivered))
        XCTAssertFalse(try receipt.advance(to: .delivered), "同级重复回执应幂等")
        XCTAssertTrue(try receipt.advance(to: .viewed))
        XCTAssertThrowsError(try receipt.advance(to: .delivered))
        XCTAssertTrue(try receipt.advance(to: .accepted))
        XCTAssertThrowsError(try receipt.advance(to: .refused))
    }

    func testAssignmentFormulaForOneThroughFiveAcceptedResponders() throws {
        let expected: [(patient: Int, aed: Int)] = [
            (1, 0), (1, 1), (2, 1), (3, 1), (3, 2)
        ]
        for acceptedCount in 1...5 {
            let plan = try AssignmentPlanner.plan(forAcceptedCount: acceptedCount)
            XCTAssertEqual(plan.patientCount, expected[acceptedCount - 1].patient)
            XCTAssertEqual(plan.aedCount, expected[acceptedCount - 1].aed)
            XCTAssertEqual(plan.patientCount + plan.aedCount, acceptedCount)
            XCTAssertEqual(plan.count(for: .goToPatient), plan.patientCount)
            XCTAssertEqual(plan.count(for: .fetchAed), plan.aedCount)
        }
        XCTAssertThrowsError(try AssignmentPlanner.plan(forAcceptedCount: -1))
    }

    func testAedAcquiredReceiptIsIdempotentAndRejectsConflictingReceiptID() throws {
        var machine = AedAcquiredReceiptMachine()
        let receipt = AedAcquiredReceipt(
            receiptId: "receipt-1",
            eventId: "event-1",
            assignmentId: "assignment-1",
            aedId: "aed-1",
            acquiredAt: baseDate
        )

        XCTAssertEqual(try machine.record(receipt), .recorded(receipt))
        XCTAssertEqual(try machine.record(receipt), .idempotent(receipt))

        let duplicateBusinessKey = AedAcquiredReceipt(
            receiptId: "receipt-2",
            eventId: receipt.eventId,
            assignmentId: receipt.assignmentId,
            aedId: receipt.aedId,
            acquiredAt: baseDate.addingTimeInterval(1)
        )
        XCTAssertEqual(try machine.record(duplicateBusinessKey), .idempotent(receipt))
        XCTAssertEqual(try machine.record(duplicateBusinessKey), .idempotent(receipt),
            "Retrying an already accepted receipt alias must remain idempotent")

        let changedAlias = AedAcquiredReceipt(
            receiptId: duplicateBusinessKey.receiptId,
            eventId: duplicateBusinessKey.eventId,
            assignmentId: duplicateBusinessKey.assignmentId,
            aedId: duplicateBusinessKey.aedId,
            acquiredAt: baseDate.addingTimeInterval(2)
        )
        XCTAssertThrowsError(try machine.record(changedAlias))

        let conflict = AedAcquiredReceipt(
            receiptId: receipt.receiptId,
            eventId: "event-other",
            assignmentId: receipt.assignmentId,
            aedId: receipt.aedId,
            acquiredAt: baseDate
        )
        XCTAssertThrowsError(try machine.record(conflict))
    }

    private func makeActiveEvent() throws -> EmergencyEvent {
        EmergencyEvent(
            id: "event-test",
            state: .active,
            recruitmentState: .recruiting,
            canPublishEventPosition: true,
            triggerSource: .watchFallHelpConfirmed,
            fallDetectedAt: baseDate,
            fallResolution: .unresponsive,
            callFirstObservedAt: baseDate.addingTimeInterval(1),
            patientPosition: try PatientPosition(latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12),
            patientLocationCard: PatientLocationCard(
                address: "安全测试地点 A",
                floor: "1F",
                accessNote: "仅供演示"
            ),
            viewerRelationship: .patient,
            createdAt: baseDate.addingTimeInterval(1),
            resolvedAt: nil,
            pendingResponseRequest: nil,
            currentAssignment: nil
        )
    }
}
