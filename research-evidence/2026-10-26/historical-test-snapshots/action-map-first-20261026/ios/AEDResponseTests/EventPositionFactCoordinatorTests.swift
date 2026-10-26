import Foundation
import XCTest
@testable import AEDResponse

final class EventPositionFactCoordinatorTests: XCTestCase {
    func testOpenFactDraftRoundTripsAndSealedSlotsAreRemoved() throws {
        let coordinator = EventPositionFactCoordinator()
        coordinator.context = EventPositionFactContext(
            serviceNamespace: "https://example.invalid/api/v2/",
            userID: "user-1",
            deviceInstanceID: "device-1",
            eventID: "event-1",
            role: .patient,
            generation: 1
        )
        let slot = Date(timeIntervalSince1970: 1_788_000_000)
        let coordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: slot
        )
        XCTAssertTrue(coordinator.recordCandidate(coordinate, at: slot))
        coordinator.markClocked(slot)

        let draft = try XCTUnwrap(coordinator.makeOpenDraft())
        XCTAssertEqual(draft.openSlots, [slot])
        XCTAssertEqual(draft.clockedSlots, [slot])
        XCTAssertEqual(draft.candidates.first?.coordinate, coordinate)

        let restored = EventPositionFactCoordinator()
        restored.context = coordinator.context
        restored.restoreOpenFacts(from: draft)
        XCTAssertEqual(restored.openSlots, [slot])
        XCTAssertEqual(restored.candidatesBySlot[slot], coordinate)
        restored.removeSealedSlots([slot])
        XCTAssertTrue(restored.openSlots.isEmpty)
        XCTAssertTrue(restored.candidatesBySlot.isEmpty)
    }
}

