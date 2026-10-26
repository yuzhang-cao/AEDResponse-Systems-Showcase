import CoreLocation
import Foundation
import XCTest
@testable import AEDResponse

@MainActor
final class LocationFixValidityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_000_100)

    func testSharedFixGateRejectsFutureAndNonFiniteSamples() {
        XCTAssertFalse(LocationFixValidity.isValid(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 5,
            observedAt: now.addingTimeInterval(0.001),
            now: now
        ))
        XCTAssertFalse(LocationFixValidity.isValid(
            latitude: .nan,
            longitude: 113.543,
            accuracyMeters: 5,
            observedAt: now,
            now: now
        ))
        XCTAssertFalse(LocationFixValidity.isValid(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: .infinity,
            observedAt: now,
            now: now
        ))
    }

    func testPhoneAdapterDoesNotPromoteFutureCallbackToCurrentCoordinate() {
        let provider = LocationProvider(manager: nil)
        let futureObservedAt = Date().addingTimeInterval(3600)
        let future = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 22.198, longitude: 113.543),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 10,
            timestamp: futureObservedAt
        )
        provider.locationManager(CLLocationManager(), didUpdateLocations: [future])
        XCTAssertNil(provider.coordinate)
        XCTAssertTrue(provider.locationBatch.isEmpty)
    }

    func testPhoneAdapterRetainsTheOSFixTimeForAValidCallback() {
        let provider = LocationProvider(manager: nil)
        let observedAt = now.addingTimeInterval(-2)
        let location = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 22.198, longitude: 113.543),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 10,
            timestamp: observedAt
        )
        provider.locationManager(CLLocationManager(), didUpdateLocations: [location])
        XCTAssertEqual(provider.coordinate?.observedAt, observedAt)
        XCTAssertEqual(provider.locationBatch.map(\.observedAt), [observedAt])
    }
}
