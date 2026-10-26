import Foundation
import XCTest
@testable import AEDResponse

/// Client half of the presence freshness contract.
///
/// There is currently no view that renders `DevicePresence.position`, so the
/// visual requirement ("a STALE coordinate must not use the live-position
/// treatment") is deferred until such a view exists.  What can be verified today
/// is the decoding contract, including what happens when the server introduces a
/// verdict this build does not know.
final class PresenceFreshnessTests: XCTestCase {
    private func presenceJSON(freshness: String) -> Data {
        Data("""
        {
          "deviceInstanceId": "REDACTED-ID-0096",
          "deviceKind": "IPHONE",
          "lastSeenAt": "2026-08-31T01:02:00.000Z",
          "availableForResponse": true,
          "capabilities": { "notificationAuthorized": true, "locationAuthorized": true },
          "positioningTier": "EVENT_PARTICIPANT",
          "position": {
            "coordinate": { "kind": "R", "latitude": 22.198, "longitude": 113.543, "accuracyMeters": 10 },
            "observedAt": "2026-08-31T01:02:00.000Z"
          },
          "freshness": "\(freshness)",
          "ageSeconds": 742,
          "currentEventId": null,
          "currentAssignmentId": null
        }
        """.utf8)
    }

    func testKnownFreshnessVerdictsDecode() throws {
        let decoder = JSONDecoder.contractDecoder()
        XCTAssertEqual(try decoder.decode(DevicePresence.self, from: presenceJSON(freshness: "FRESH")).freshness, .fresh)
        XCTAssertEqual(try decoder.decode(DevicePresence.self, from: presenceJSON(freshness: "STALE")).freshness, .stale)
        XCTAssertEqual(try decoder.decode(DevicePresence.self, from: presenceJSON(freshness: "UNAVAILABLE")).freshness, .unavailable)
    }

    /// A verdict added by a newer server must not break an older client's whole
    /// presence decode, and must never be treated as a current location.
    func testUnknownFreshnessVerdictDecodesAndFailsClosed() throws {
        let decoded = try JSONDecoder.contractDecoder().decode(
            DevicePresence.self,
            from: presenceJSON(freshness: "DEGRADED")
        )
        XCTAssertEqual(decoded.freshness, .unrecognized("DEGRADED"))
        XCTAssertEqual(decoded.freshness.rawValue, "DEGRADED", "the raw verdict is preserved for diagnostics")
        XCTAssertFalse(decoded.freshness.permitsCurrentLocation,
                       "an unrecognised verdict must never authorise using the coordinate as current")
    }

    func testOnlyFreshPermitsCurrentLocation() {
        XCTAssertTrue(PositionFreshness.fresh.permitsCurrentLocation)
        XCTAssertFalse(PositionFreshness.stale.permitsCurrentLocation)
        XCTAssertFalse(PositionFreshness.unavailable.permitsCurrentLocation)
        XCTAssertFalse(PositionFreshness.unrecognized("ANYTHING").permitsCurrentLocation)
    }

    /// A stale participant still carries a coordinate: the client must be able to
    /// show a last-known position without treating it as live.
    func testStaleParticipantRetainsCoordinate() throws {
        let decoded = try JSONDecoder.contractDecoder().decode(
            DevicePresence.self,
            from: presenceJSON(freshness: "STALE")
        )
        XCTAssertNotNil(decoded.position)
        XCTAssertEqual(decoded.position?.coordinate.kind, .responder)
        XCTAssertEqual(decoded.ageSeconds, 742)
        XCTAssertFalse(decoded.freshness.permitsCurrentLocation)
    }

    /// No coordinate at all is UNAVAILABLE rather than a fabricated verdict.
    func testAbsentCoordinateIsUnavailable() throws {
        let data = Data("""
        {
          "deviceInstanceId": "REDACTED-ID-0097",
          "deviceKind": "IPHONE",
          "lastSeenAt": "2026-08-31T01:02:00.000Z",
          "availableForResponse": true,
          "capabilities": { "notificationAuthorized": true, "locationAuthorized": true },
          "positioningTier": "STANDBY",
          "position": null,
          "freshness": "UNAVAILABLE",
          "ageSeconds": null,
          "currentEventId": null,
          "currentAssignmentId": null
        }
        """.utf8)
        let decoded = try JSONDecoder.contractDecoder().decode(DevicePresence.self, from: data)
        XCTAssertNil(decoded.position)
        XCTAssertEqual(decoded.freshness, .unavailable)
        XCTAssertNil(decoded.ageSeconds)
    }

    func testFreshnessRoundTrips() throws {
        let encoder = JSONEncoder.contractEncoder()
        for verdict in [PositionFreshness.fresh, .stale, .unavailable, .unrecognized("FUTURE")] {
            let data = try encoder.encode(verdict)
            XCTAssertEqual(try JSONDecoder.contractDecoder().decode(PositionFreshness.self, from: data), verdict)
        }
    }
}
