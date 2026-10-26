import Foundation
import XCTest
@testable import AEDResponse

/// Behaviour of the single-event REST reconciliation decision.
///
/// The checklist flagged this path as a code-level risk: after a normal offer
/// expiry or a false-alarm cancellation the device can no longer read the event,
/// the server answers 404, and the old code turned that correct answer into a
/// "REST 状态同步失败" alert.  These tests fix the decision in place so the
/// branches cannot regress without a live session.
final class EventReconcileOutcomeTests: XCTestCase {
    private let baseDate = Date(timeIntervalSince1970: 1_788_000_000)

    private func makeEvent(id: String = "event-test") throws -> EmergencyEvent {
        EmergencyEvent(
            id: id,
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
            viewerRelationship: .responder,
            createdAt: baseDate.addingTimeInterval(1),
            resolvedAt: nil,
            pendingResponseRequest: nil,
            currentAssignment: nil
        )
    }

    private struct NotFound: Error {}

    private func resolve(
        _ result: Result<EmergencyEvent, Error>,
        tombstoned: Bool = false
    ) -> EventReconcileOutcome {
        EventReconcileOutcome.resolve(
            result: result,
            isTombstoned: tombstoned,
            isNotFound: { $0 is NotFound },
            describe: { _ in "network down" }
        )
    }

    func testReadableEventIsApplied() throws {
        let event = try makeEvent()
        XCTAssertEqual(resolve(.success(event)), .visible(event))
    }

    func testNotFoundWithoutTombstoneSettlesSilently() throws {
        // The offer-expiry path: the event was only visible through the offer.
        XCTAssertEqual(
            resolve(.failure(NotFound())),
            .notVisible(tombstoned: false),
            "404 是正常终点的正确答复，不能变成失败弹窗"
        )
    }

    func testNotFoundAfterDeliberateExitIsAlsoSilent() throws {
        XCTAssertEqual(
            resolve(.failure(NotFound()), tombstoned: true),
            .notVisible(tombstoned: true),
            "已主动退出并留 tombstone 的事件同样安静收束"
        )
    }

    func testTransportFailureStillSurfaces() throws {
        let failure = URLError(.notConnectedToInternet)
        XCTAssertEqual(
            resolve(.failure(failure)),
            .failed("network down"),
            "真正的网络/服务端失败仍必须让用户知道"
        )
        XCTAssertEqual(
            resolve(.failure(failure), tombstoned: true),
            .failed("network down"),
            "tombstone 只影响 404 的解释，不能吞掉真实故障"
        )
    }

    func testNotFoundIsDistinguishedFromOtherServerErrors() throws {
        struct ServerError: Error {}
        XCTAssertEqual(
            EventReconcileOutcome.resolve(
                result: .failure(ServerError()),
                isTombstoned: false,
                isNotFound: { $0 is NotFound },
                describe: { _ in "server error" }
            ),
            .failed("server error")
        )
    }
}
