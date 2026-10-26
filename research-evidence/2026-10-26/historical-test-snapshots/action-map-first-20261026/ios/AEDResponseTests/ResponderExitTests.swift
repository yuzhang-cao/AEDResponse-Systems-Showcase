import Foundation
import XCTest
@testable import AEDResponse

final class ResponderExitTests: XCTestCase {
    func testAllRescueCancellationFlowsCanRequireThreeClicksWithoutSoleResponderWording() {
        var coordinator = ExitConfirmationCoordinator()
        var current = coordinator.begin(eventID: "withdrawal", acceptedResponderCount: 3, requiresThreeConfirmations: true)
        XCTAssertFalse(current.requiresSoleResponderConfirmation)
        XCTAssertEqual(current.requiredConfirmationCount, 3)
        for step in 1...2 {
            XCTAssertEqual(current.confirmationIndex, step)
            guard case let .continuePrompt(next) = coordinator.confirm(eventID: current.eventID,
                expectedPromptID: current.confirmationToken, acceptedResponderCount: 3) else { return XCTFail("Must not submit early") }
            XCTAssertEqual(coordinator.confirm(eventID: current.eventID,
                expectedPromptID: current.confirmationToken, acceptedResponderCount: 3), .ignored)
            current = next
        }
        guard case .submit = coordinator.confirm(eventID: current.eventID,
            expectedPromptID: current.confirmationToken, acceptedResponderCount: 3) else { return XCTFail("Third tap must submit") }
        coordinator.invalidate()
        XCTAssertEqual(coordinator.begin(eventID: "withdrawal", acceptedResponderCount: 3,
            requiresThreeConfirmations: true).confirmationIndex, 1)
    }

    func testSoleResponderRequiresThreeExplicitClicksAndOpeningDoesNotCount() {
        var coordinator = ExitConfirmationCoordinator()
        let first = coordinator.begin(eventID: "event-1", acceptedResponderCount: 1)

        XCTAssertEqual(first.confirmationIndex, 1)
        XCTAssertEqual(first.requiredConfirmationCount, 3)
        XCTAssertEqual(coordinator.completedConfirmationCount, 0)
        XCTAssertTrue(first.message.contains("你是当前任务唯一一名响应者，确定要退出吗。"))

        let second = prompt(
            from: coordinator.confirm(
                eventID: first.eventID,
                expectedPromptID: first.confirmationToken,
                acceptedResponderCount: 1
            )
        )
        XCTAssertEqual(second.confirmationIndex, 2)
        XCTAssertEqual(coordinator.completedConfirmationCount, 1)

        let third = prompt(
            from: coordinator.confirm(
                eventID: second.eventID,
                expectedPromptID: second.confirmationToken,
                acceptedResponderCount: 1
            )
        )
        XCTAssertEqual(third.confirmationIndex, 3)
        XCTAssertEqual(coordinator.completedConfirmationCount, 2)

        guard case let .submit(submission) = coordinator.confirm(
            eventID: third.eventID,
            expectedPromptID: third.confirmationToken,
            acceptedResponderCount: 1
        ) else {
            return XCTFail("The third explicit click must submit the sole-responder flag.")
        }
        XCTAssertTrue(submission.soleResponderConfirmed)
        XCTAssertFalse(coordinator.isPresenting)
    }

    func testCancelResetsSequenceAndInvalidatesStalePrompt() {
        var coordinator = ExitConfirmationCoordinator()
        let first = coordinator.begin(eventID: "event-1", acceptedResponderCount: 1)
        _ = coordinator.confirm(
            eventID: first.eventID,
            expectedPromptID: first.confirmationToken,
            acceptedResponderCount: 1
        )
        coordinator.cancel(eventID: first.eventID)

        XCTAssertNil(coordinator.currentPrompt)
        XCTAssertEqual(coordinator.completedConfirmationCount, 0)

        let reopened = coordinator.begin(eventID: first.eventID, acceptedResponderCount: 1)
        XCTAssertGreaterThan(reopened.generation, first.generation)
        XCTAssertEqual(reopened.confirmationIndex, 1)
        XCTAssertEqual(
            coordinator.confirm(
                eventID: reopened.eventID,
                expectedPromptID: first.confirmationToken,
                acceptedResponderCount: 1
            ),
            .ignored
        )
        XCTAssertEqual(coordinator.completedConfirmationCount, 0)
    }

    func testMultiResponderUsesOneConfirmationWithoutSoleFlag() {
        var coordinator = ExitConfirmationCoordinator()
        let prompt = coordinator.begin(eventID: "event-2", acceptedResponderCount: 2)

        guard case let .submit(submission) = coordinator.confirm(
            eventID: prompt.eventID,
            expectedPromptID: prompt.confirmationToken,
            acceptedResponderCount: 2
        ) else {
            return XCTFail("A multi-responder event should submit after one click.")
        }
        XCTAssertFalse(submission.soleResponderConfirmed)
    }

    func testBackendSoleRequirementStaysStickyAgainstStaleN() {
        var coordinator = ExitConfirmationCoordinator()
        let first = coordinator.beginSoleResponderConfirmation(eventID: "event-3")

        let second = prompt(
            from: coordinator.confirm(
                eventID: first.eventID,
                expectedPromptID: first.confirmationToken,
                // Local REST projection may still say N=2 after the 409.
                acceptedResponderCount: 2
            )
        )
        XCTAssertEqual(second.confirmationIndex, 2)

        let third = prompt(
            from: coordinator.confirm(
                eventID: second.eventID,
                expectedPromptID: second.confirmationToken,
                acceptedResponderCount: 2
            )
        )
        XCTAssertEqual(third.confirmationIndex, 3)

        guard case let .submit(submission) = coordinator.confirm(
            eventID: third.eventID,
            expectedPromptID: third.confirmationToken,
            acceptedResponderCount: 2
        ) else {
            return XCTFail("A backend-forced sole-responder flow must remain three-click.")
        }
        XCTAssertTrue(submission.soleResponderConfirmed)
    }

    func testInvalidResponderCountCannotSubmit() {
        var coordinator = ExitConfirmationCoordinator()
        let prompt = coordinator.begin(eventID: "event-4", acceptedResponderCount: 1)
        XCTAssertEqual(
            coordinator.confirm(
                eventID: prompt.eventID,
                expectedPromptID: prompt.confirmationToken,
                acceptedResponderCount: 0
            ),
            .ignored
        )
        XCTAssertEqual(coordinator.completedConfirmationCount, 0)
    }

    func testOrdinaryExitOmitsSoleResponderFlagAndTrueIsEncoded() throws {
        let ordinary = ParticipantExitRequest(
            exitId: "exit-ordinary",
            exitedAt: Date(timeIntervalSince1970: 1_788_000_100)
        )
        let guarded = ParticipantExitRequest(
            exitId: "exit-sole",
            exitedAt: Date(timeIntervalSince1970: 1_788_000_100),
            soleResponderConfirmed: true
        )
        let ordinaryObject = try JSONSerialization.jsonObject(
            with: JSONEncoder.contractEncoder().encode(ordinary)
        ) as? [String: Any]
        let guardedObject = try JSONSerialization.jsonObject(
            with: JSONEncoder.contractEncoder().encode(guarded)
        ) as? [String: Any]

        XCTAssertNil(ordinaryObject?["soleResponderConfirmed"])
        XCTAssertEqual(guardedObject?["soleResponderConfirmed"] as? Bool, true)
    }

    private func prompt(from action: ExitConfirmationAction) -> ExitConfirmationPrompt {
        guard case let .continuePrompt(prompt) = action else {
            XCTFail("Expected the next confirmation prompt.")
            return ExitConfirmationPrompt(
                eventID: "invalid",
                generation: -1,
                confirmationIndex: -1,
                requiredConfirmationCount: -1,
                requiresSoleResponderConfirmation: false,
                message: ""
            )
        }
        return prompt
    }
}
