import Foundation
import XCTest
@testable import AEDResponse

/// G05 — the five terminal facts must stay five separate facts on screen.
///
/// A single "已结束" label would tell the patient something untrue: a false alarm is
/// not a completed rescue, withdrawing assistance is not a confirmation, and an
/// unconfirmed close is explicitly NOT a resolution.  These tests are about the
/// wording, because the wording is what the person reads; they fail if a future edit
/// flattens the distinctions or lets the patient card and the responder card drift.
final class EventOutcomePresentationTests: XCTestCase {
    /// The four terminal states the server can put an event into.
    private let terminalStates: [EventState] = [
        .resolved, .cancelledConfirmedFalseAlarm, .cancelledAssistanceWithdrawn,
        .closedUnconfirmedNoResponse
    ]

    func testEveryTerminalFactHasItsOwnPatientFacingTitle() {
        let titles = terminalStates.map(EventOutcomePresentation.title(for:))
        XCTAssertEqual(Set(titles).count, terminalStates.count,
                       "五个终态事实必须各自有不同文案：\(titles)")
        XCTAssertEqual(Set(titles).contains("已结束"), false,
                       "不得用笼统的“已结束”代替具体事实")
        XCTAssertEqual(Set(titles).contains("救助已结束"), true)
    }

    func testOnlyResolutionClaimsTheEmergencyWasResolved() {
        XCTAssertTrue(EventOutcomePresentation.confirmsOutcome(.resolved))
        for state in terminalStates where state != .resolved {
            XCTAssertFalse(EventOutcomePresentation.confirmsOutcome(state),
                           "\(state.rawValue) 不得被表述为“已确认需要/完成救助”")
        }
    }

    func testCancellationAndFalseAlarmReadDifferentlyForBothRoles() {
        XCTAssertNotEqual(EventOutcomePresentation.title(for: .cancelledConfirmedFalseAlarm),
                          EventOutcomePresentation.title(for: .cancelledAssistanceWithdrawn))
        XCTAssertNotEqual(
            EventOutcomePresentation.responderTitle(for: .cancelledConfirmedFalseAlarm),
            EventOutcomePresentation.responderTitle(for: .cancelledAssistanceWithdrawn),
            "响应者需要知道是患者取消了救助，还是被标记为误报"
        )
        // An unconfirmed close must say so rather than implying a resolution.
        XCTAssertTrue(EventOutcomePresentation.title(for: .closedUnconfirmedNoResponse)
            .contains("未确认"))
        XCTAssertTrue(EventOutcomePresentation.responderTitle(for: .closedUnconfirmedNoResponse)
            .contains("未确认"))
    }

    func testActiveStateIsNotPresentedAsAnOutcome() {
        XCTAssertEqual(EventOutcomePresentation.title(for: .active), "救助进行中")
        XCTAssertFalse(EventOutcomePresentation.confirmsOutcome(.active))
        XCTAssertNotEqual(EventOutcomePresentation.title(for: .active),
                          EventOutcomePresentation.title(for: .resolved))
    }

    /// The responder's own task ending is a separate fact from the event outcome:
    /// a completed task inside a cancelled event must not read as "the rescue ended".
    func testResponderTaskEndAndEventOutcomeAreSeparateStatements() {
        let taskEnd = AssignmentStatus.completed.teamDisplayText
        XCTAssertEqual(taskEnd, "任务完成")
        XCTAssertNotEqual(taskEnd, EventOutcomePresentation.responderTitle(for: .cancelledAssistanceWithdrawn))
        XCTAssertNotEqual(AssignmentStatus.aedUnavailable.teamDisplayText,
                          EventOutcomePresentation.responderTitle(for: .resolved))
    }
}
