import Foundation
import XCTest
#if canImport(AEDResponse)
@testable import AEDResponse
#else
@testable import AEDResponseWatchLogic
#endif

final class EmergencyAlertPolicyTests: XCTestCase {
    private let eventID = "REDACTED-ID-0170"

    func testReceivedIsNotServerSuccessAndRetransmissionsDoNotRingAgain() throws {
        let received = EmergencyAlertPlan(eventID: eventID, phase: .received, isSimulation: false)
        XCTAssertTrue(received.body.contains("尚未建立"))
        var ledger = EmergencyAlertLedger()
        XCTAssertTrue(ledger.shouldPresent(received))
        ledger.record(received, at: Date())
        let restored = try JSONDecoder().decode(EmergencyAlertLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertFalse(restored.shouldPresent(received))
        XCTAssertTrue(restored.shouldPresent(EmergencyAlertPlan(eventID: eventID, phase: .activated, isSimulation: false)))
    }

    func testLateReceiptCannotOverwriteAcknowledgedOrEndedEvent() {
        var ledger = EmergencyAlertLedger()
        let active = EmergencyAlertPlan(eventID: eventID, phase: .activated, isSimulation: true)
        let ended = EmergencyAlertPlan(eventID: eventID, phase: .ended, isSimulation: true)
        XCTAssertFalse(ledger.shouldPresent(ended), "Do not notify old history on a fresh installation")
        ledger.record(active, at: Date())
        XCTAssertFalse(ledger.shouldPresent(EmergencyAlertPlan(eventID: eventID, phase: .received, isSimulation: true)))
        XCTAssertTrue(ledger.shouldPresent(ended))
        ledger.record(ended, at: Date())
        XCTAssertFalse(ledger.shouldPresent(active))
    }

    func testOwnerIsBoundToAccountAndServiceWithoutLeakingRawIdentity() {
        let first = EmergencyAlertIdentity.owner(serviceURL: "https://example.test", userID: "alice")
        XCTAssertEqual(first.count, 64)
        XCTAssertFalse(first.contains("alice"))
        XCTAssertNotEqual(first, EmergencyAlertIdentity.owner(serviceURL: "https://example.test", userID: "bob"))
        XCTAssertNotEqual(first, EmergencyAlertIdentity.owner(serviceURL: "https://other.test", userID: "alice"))
        XCTAssertFalse(EmergencyAlertLedger().shouldPresent(EmergencyAlertPlan(eventID: "invalid", phase: .received, isSimulation: false)))
    }

    func testNotificationCopyDoesNotAssumeThePhoneIsLocked() {
        // The same delivered notification can move from the lock screen to an
        // unlocked banner or Notification Center without rewriting its content.
        for isSimulation in [false, true] {
            let received = EmergencyAlertPlan(eventID: eventID, phase: .received, isSimulation: isSimulation)
            let activated = EmergencyAlertPlan(eventID: eventID, phase: .activated, isSimulation: isSimulation)
            let ended = EmergencyAlertPlan(eventID: eventID, phase: .ended, isSimulation: isSimulation)
            XCTAssertEqual(received.body, "正在上报，尚未建立救助事件")
            XCTAssertEqual(activated.body, "轻点查看最新救助进展")
            XCTAssertEqual(ended.body, "轻点查看处理结果")
            for plan in [received, activated, ended] {
                XCTAssertFalse(plan.title.contains("解锁"))
                XCTAssertFalse(plan.body.contains("解锁"))
                XCTAssertFalse(plan.body.contains("锁屏"))
            }
        }
    }

    func testForegroundUsesPageWhileBackgroundOrInactiveCanNotify() {
        for phase in [EmergencyAlertPlan.Phase.received, .activated, .ended] {
            let plan = EmergencyAlertPlan(eventID: eventID, phase: phase, isSimulation: false)
            XCTAssertFalse(plan.shouldScheduleNotification(isAppActive: true), "Do not duplicate the foreground page with a system alert")
            XCTAssertEqual(plan.shouldScheduleNotification(isAppActive: false), phase != .ended,
                           "Locked, unlocked in another app, and transiently inactive must not be confused with foreground")
        }
    }

    func testReturningToBackgroundDoesNotReplayTheSameEventPhase() {
        let plan = EmergencyAlertPlan(eventID: eventID, phase: .activated, isSimulation: false)
        var ledger = EmergencyAlertLedger()
        XCTAssertFalse(plan.shouldScheduleNotification(isAppActive: true))
        ledger.record(plan, at: Date())
        XCTAssertTrue(plan.shouldScheduleNotification(isAppActive: false))
        XCTAssertFalse(ledger.shouldPresent(plan), "Changing app state alone must not ring again")
    }
}
