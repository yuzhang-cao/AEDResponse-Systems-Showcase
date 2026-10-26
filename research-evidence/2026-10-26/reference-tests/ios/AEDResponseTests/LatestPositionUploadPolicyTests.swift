import XCTest
@testable import AEDResponse

final class LatestPositionUploadPolicyTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_788_000_000)

    private func fix(meters: Double = 0, seconds: Double = 1) -> DeviceCoordinate {
        DeviceCoordinate(
            latitude: meters / 6_371_008.8 * 180 / .pi,
            longitude: 0, accuracyMeters: 5,
            observedAt: start.addingTimeInterval(seconds)
        )
    }

    private func permits(meters: Double = 0, elapsed: Double, tier: DevicePositioningTier) -> Bool {
        LatestPositionUploadPolicy.permits(
            fix(meters: meters), after: fix(seconds: 0), lastStartedAt: start,
            now: start.addingTimeInterval(elapsed), tier: tier
        )
    }

    func testStandbyTimeAndMovementAreAlternativeThresholds() {
        XCTAssertFalse(permits(meters: 99, elapsed: 119.99, tier: .standby))
        XCTAssertTrue(permits(elapsed: 120, tier: .standby))
        XCTAssertTrue(permits(meters: 101, elapsed: 1, tier: .standby))
    }

    func testSearchRingUsesFifteenSecondsOrThirtyMeters() {
        XCTAssertFalse(permits(meters: 29, elapsed: 14.99, tier: .searchRing))
        XCTAssertTrue(permits(elapsed: 15, tier: .searchRing))
        XCTAssertTrue(permits(meters: 31, elapsed: 1, tier: .searchRing))
        XCTAssertFalse(permits(meters: 31, elapsed: 15, tier: .standby))
    }

    func testEventEvidenceNeverUsesLatestValueQueue() {
        XCTAssertFalse(permits(meters: 500, elapsed: 500, tier: .eventParticipant))
        XCTAssertFalse(LatestPositionUploadPolicy.permits(
            fix(), after: nil, lastStartedAt: nil, now: start, tier: .eventParticipant
        ))
    }

    func testInitialFixUploadsImmediatelyButOldFixCannotBeReplayed() {
        XCTAssertTrue(LatestPositionUploadPolicy.permits(
            fix(), after: nil, lastStartedAt: nil, now: start, tier: .standby
        ))
        for seconds in [-1.0, 0] {
            XCTAssertFalse(LatestPositionUploadPolicy.permits(
                fix(meters: 500, seconds: seconds), after: fix(seconds: 0),
                lastStartedAt: start, now: start.addingTimeInterval(500), tier: .standby
            ))
        }
    }

    func testInvalidFixAndClockRollbackDoNotCauseTimeBasedUpload() {
        let invalid = DeviceCoordinate(latitude: .nan, longitude: 0, accuracyMeters: 5, observedAt: start)
        XCTAssertFalse(LatestPositionUploadPolicy.permits(
            invalid, after: nil, lastStartedAt: nil, now: start, tier: .standby
        ))
        XCTAssertFalse(permits(elapsed: -100, tier: .standby))
        XCTAssertTrue(permits(meters: 101, elapsed: -100, tier: .standby))
    }
}
