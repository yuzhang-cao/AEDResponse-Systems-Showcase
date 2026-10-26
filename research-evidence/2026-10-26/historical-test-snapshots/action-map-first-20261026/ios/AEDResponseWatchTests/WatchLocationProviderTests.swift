import CoreLocation
import Foundation
import XCTest
@testable import AEDResponseWatch

@MainActor
final class WatchLocationProviderTests: XCTestCase {
    func testFutureFixIsNotRetainedAsWatchSnapshot() {
        let provider = WatchLocationProvider()
        let future = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 22.198, longitude: 113.543),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 10,
            timestamp: Date().addingTimeInterval(3600)
        )
        provider.locationManager(CLLocationManager(), didUpdateLocations: [future])
        let snapshot = provider.snapshot()
        XCTAssertNil(snapshot.patientPosition)
        XCTAssertNil(snapshot.observedAt)
    }

    func testValidFixKeepsTheOSObservedTime() {
        let provider = WatchLocationProvider()
        let observedAt = Date().addingTimeInterval(-2)
        let location = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 22.198, longitude: 113.543),
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 10,
            timestamp: observedAt
        )
        provider.locationManager(CLLocationManager(), didUpdateLocations: [location])
        XCTAssertEqual(provider.snapshot().observedAt, observedAt)
        XCTAssertNotNil(provider.snapshot().patientPosition)
    }
}
