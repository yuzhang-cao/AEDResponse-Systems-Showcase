import Foundation
import XCTest
@testable import AEDResponseCore

@MainActor
final class WatchCoordinatorContractTests: XCTestCase {
    func testDefaultAssociationWindowIsApproved120Seconds() {
        XCTAssertEqual(FallEmergencyCoordinator.defaultMaximumAssociationInterval, 120)
    }

    func testDeterministicMonitorsExposeSignalsWithoutProductionUIEntry() {
        let fallMonitor = SimulatedFallDetectionMonitor()
        let callMonitor = SimulatedOutgoingCallMonitor()
        var receivedFall: FallDetectionSignal?
        var receivedCall: OutgoingCallSignal?

        fallMonitor.onFall = { signal, completion in
            receivedFall = signal
            completion()
        }
        callMonitor.onOutgoingCall = { receivedCall = $0 }

        let date = Date(timeIntervalSince1970: 1_788_000_000)
        fallMonitor.emit(FallDetectionSignal(detectedAt: date, resolution: .unresponsive))
        callMonitor.emit(
            OutgoingCallSignal(
                callID: "simulated-call",
                firstObservedAt: date.addingTimeInterval(1),
                isOutgoing: true
            )
        )

        XCTAssertEqual(receivedFall?.resolution, .unresponsive)
        XCTAssertEqual(receivedCall?.isOutgoing, true)
    }
}
