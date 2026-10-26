import Foundation
import XCTest
@testable import AEDResponse

final class AedRouteEstimatorTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    func testOfflineRouteIsStrictRAPAndUsesDistance() throws {
        let estimator = AedRouteEstimator(calendar: calendar)
        let route = try estimator.bestRoute(
            responder: try ResponderPosition(latitude: 22.198, longitude: 113.543, accuracyMeters: 10),
            patient: try PatientPosition(latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12),
            aeds: [try makeAed()],
            at: Date(timeIntervalSince1970: 0)
        )

        XCTAssertEqual(route.pathKinds, [.responder, .aed, .patient])
        XCTAssertGreaterThan(try XCTUnwrap(route.distanceMeters), 0)
        XCTAssertEqual(route.distanceSource, "GEODESIC_ESTIMATE")

        let encoded = try JSONEncoder.contractEncoder().encode(route)
        let decoded = try JSONDecoder.contractDecoder().decode(AedRoute.self, from: encoded)
        XCTAssertEqual(decoded.pathKinds, [.responder, .aed, .patient])
    }

    func testUnavailableAndClosedAedsAreExcluded() throws {
        let estimator = AedRouteEstimator(calendar: calendar)
        let responder = try ResponderPosition(latitude: 22.198, longitude: 113.543, accuracyMeters: 10)
        let patient = try PatientPosition(latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12)
        var unavailable = try makeAed(available: false)

        XCTAssertThrowsError(
            try estimator.bestRoute(
                responder: responder,
                patient: patient,
                aeds: [unavailable],
                at: Date(timeIntervalSince1970: 0)
            )
        )

        unavailable = try makeAed(openFrom: "09:00", openUntil: "10:00")
        XCTAssertThrowsError(
            try estimator.bestRoute(
                responder: responder,
                patient: patient,
                aeds: [unavailable],
                at: Date(timeIntervalSince1970: 0)
            )
        )
    }

    func testEqualOpeningTimesMeanAllDay() throws {
        let estimator = AedRouteEstimator(calendar: calendar)
        XCTAssertTrue(try estimator.isOpen(try makeAed(openFrom: "00:00", openUntil: "00:00"), at: Date()))
    }

    func testLegacyEtaDoesNotBecomeADistance() throws {
        let legacy = #"{"aedId":"old","path":[{"kind":"R","latitude":22,"longitude":113,"accuracyMeters":5},{"kind":"A","latitude":22.01,"longitude":113.01},{"kind":"P","latitude":22.02,"longitude":113.02,"accuracyMeters":5}],"etaSeconds":600,"walkingSeconds":500,"overheadSeconds":100}"#.data(using: .utf8)!
        let route = try JSONDecoder.contractDecoder().decode(AedRoute.self, from: legacy)
        XCTAssertNil(route.distanceMeters)
        XCTAssertNil(route.amapNavigation)
        let encoded = try JSONEncoder.contractEncoder().encode(route)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("etaSeconds"))
        var invalid = try XCTUnwrap(JSONSerialization.jsonObject(with: legacy) as? [String: Any])
        invalid["distanceMeters"] = -1
        XCTAssertThrowsError(try JSONDecoder.contractDecoder().decode(AedRoute.self,
            from: JSONSerialization.data(withJSONObject: invalid)))
    }

    private func makeAed(
        available: Bool = true,
        openFrom: String = "00:00",
        openUntil: String = "00:00"
    ) throws -> Aed {
        Aed(
            id: "aed-test",
            name: "测试 AED",
            aedPosition: try AedPosition(latitude: 22.199, longitude: 113.544),
            openFrom: openFrom,
            openUntil: openUntil,
            floor: "2F",
            floorTransferSeconds: 45,
            accessNote: "向测试前台取用",
            accessDelaySeconds: 60,
            verificationSeconds: 30,
            available: available
        )
    }
}
