import Foundation
import XCTest
@testable import AEDResponse

final class ResponsePrivacyProjectionTests: XCTestCase {
    private let eventID = "REDACTED-SUPPLEMENT-ID-c97f183c255c"
    private let deliveryID = "REDACTED-SUPPLEMENT-ID-12753a07f290"

    func testSimulationPatientIsExplicitAndContainsNoFallEvidence() throws {
        var object = baseEventObject(state: "ACTIVE", recruitmentState: "RECRUITING", viewerRelationship: "PATIENT")
        object["triggerSource"] = "SIMULATED_TEST"
        object["simulation"] = ["runId": eventID, "label": "SIMULATED_TEST"]
        let event = try decode(object, as: EmergencyEvent.self)
        XCTAssertEqual(event.triggerSource, .simulatedTest)
        XCTAssertEqual(event.simulation?.runId, UUID(uuidString: eventID))
        XCTAssertNil(event.fallDetectedAt)
        let roundTrip = try JSONDecoder.contractDecoder().decode(EmergencyEvent.self,
            from: JSONEncoder.contractEncoder().encode(event))
        XCTAssertEqual(roundTrip.simulation, event.simulation)
        object["fallDetectedAt"] = "2026-08-31T01:02:03Z"
        XCTAssertThrowsError(try decode(object, as: EmergencyEvent.self))
        object.removeValue(forKey: "fallDetectedAt")
        object.removeValue(forKey: "simulation")
        XCTAssertThrowsError(try decode(object, as: EmergencyEvent.self))
    }

    func testSimulationOfferMarkerIsEventBoundAndDoesNotPermitPrivateFields() throws {
        var object = responseRequestObject()
        object["simulation"] = ["runId": eventID, "label": "SIMULATED_TEST"]
        let request = try decode(object, as: ResponseRequest.self)
        XCTAssertEqual(request.simulation?.runId, UUID(uuidString: eventID))
        object["patientPosition"] = patientPositionObject()
        XCTAssertThrowsError(try decode(object, as: ResponseRequest.self))
        object.removeValue(forKey: "patientPosition")
        object["simulation"] = ["runId": deliveryID, "label": "SIMULATED_TEST"]
        XCTAssertThrowsError(try decode(object, as: ResponseRequest.self))
    }

    func testPendingResponderProjectionDecodesWithoutExactPatientOrCoordination() throws {
        var object = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "NEUTRAL"
        )
        object["pendingResponseRequest"] = responseRequestObject()

        let event = try decode(object, as: EmergencyEvent.self)

        XCTAssertNil(event.triggerSource)
        XCTAssertNil(event.fallDetectedAt)
        XCTAssertNil(event.fallResolution)
        XCTAssertNil(event.patientPosition)
        XCTAssertNil(event.patientLocationCard)
        XCTAssertNil(event.coordination)
        XCTAssertEqual(event.pendingResponseRequest?.positioningTier, .searchRing)
        XCTAssertEqual(event.pendingResponseRequest?.distanceRange, .zeroTo500Meters)
        XCTAssertFalse(event.canPublishEventPosition)
    }

    func testAcceptedResponderProjectionDecodesExactPatientDataAndCoordination() throws {
        var object = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "RESPONDER"
        )
        object["patientPosition"] = patientPositionObject()
        object["patientPositionSource"] = "IPHONE_PRIMARY"
        object["patientPositionObservedAt"] = "2026-08-31T01:02:05Z"
        object["patientPositionServerReceivedAt"] = "2026-08-31T01:02:06Z"
        object["patientLocationCard"] = [
            "address": "仅供测试地址",
            "floor": "1F",
            "accessNote": "仅接受后可见"
        ]
        object["coordination"] = coordinationObject()

        let event = try decode(object, as: EmergencyEvent.self)

        XCTAssertNil(event.triggerSource)
        XCTAssertNil(event.fallDetectedAt)
        XCTAssertNotNil(event.patientPosition)
        XCTAssertTrue(event.canPublishEventPosition)
        XCTAssertEqual(event.patientPositionSource, .iPhonePrimary)
        XCTAssertEqual(event.patientLocationCard?.address, "仅供测试地址")
        XCTAssertEqual(event.coordination?.acceptedResponderCount, 1)
    }

    func testPatientProjectionDecodesTriggerExactPatientAndCoordination() throws {
        var object = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "PATIENT"
        )
        object["triggerSource"] = "WATCH_FALL_HELP_CONFIRMED"
        object["fallDetectedAt"] = "2026-08-31T01:02:03Z"
        object["fallResolution"] = "CONFIRMED"
        object["appHelpResponse"] = "NEEDS_HELP"
        object["patientPosition"] = patientPositionObject()
        object["patientPositionSource"] = "WATCH_TRIGGER_SNAPSHOT"
        object["patientPositionObservedAt"] = "2026-08-31T01:02:03Z"
        object["patientPositionServerReceivedAt"] = "2026-08-31T01:02:04Z"
        object["coordination"] = coordinationObject()

        let event = try decode(object, as: EmergencyEvent.self)

        XCTAssertEqual(event.triggerSource, .watchFallHelpConfirmed)
        XCTAssertEqual(event.fallResolution, .confirmed)
        XCTAssertTrue(event.canPublishEventPosition)
        XCTAssertEqual(event.patientPositionSource, .watchTriggerSnapshot)
        XCTAssertNotNil(event.patientPosition)
        XCTAssertNotNil(event.coordination)
    }

    func testMinimalTerminalProjectionDecodesWithoutConditionalFields() throws {
        let object = baseEventObject(
            state: "RESOLVED",
            recruitmentState: "COMPLETED",
            viewerRelationship: "NEUTRAL"
        )

        let event = try decode(object, as: EmergencyEvent.self)

        XCTAssertEqual(event.state, .resolved)
        XCTAssertFalse(event.canPublishEventPosition)
        XCTAssertNil(event.triggerSource)
        XCTAssertNil(event.fallDetectedAt)
        XCTAssertNil(event.patientPosition)
        XCTAssertNil(event.patientLocationCard)
        XCTAssertNil(event.coordination)
        XCTAssertNil(event.pendingResponseRequest)
    }

    func testPendingResponseRequestRejectsPatientPositionAndOtherSensitiveFields() throws {
        var object = responseRequestObject()
        object["patientPosition"] = patientPositionObject()
        object["patientLocationCard"] = [
            "address": "不应出现在候选请求",
            "floor": "1F",
            "accessNote": "不可见"
        ]
        object["triggerSource"] = "WATCH_FALL_HELP_CONFIRMED"
        object["coordination"] = coordinationObject()

        XCTAssertThrowsError(try decode(object, as: ResponseRequest.self)) { error in
            guard case DecodingError.dataCorrupted = error else {
                return XCTFail("Expected strict pre-acceptance privacy rejection")
            }
        }
    }

    func testSecondarySameUserPatientProjectionIsExplicitlyReadOnly() throws {
        var object = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "PATIENT"
        )
        object["canPublishEventPosition"] = false

        let event = try decode(object, as: EmergencyEvent.self)

        XCTAssertEqual(event.viewerRelationship, .patient)
        XCTAssertFalse(event.canPublishEventPosition)
    }

    func testEmergencyEventRequiresCanPublishEventPositionField() throws {
        var object = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "PATIENT"
        )
        object.removeValue(forKey: "canPublishEventPosition")

        XCTAssertThrowsError(try decode(object, as: EmergencyEvent.self))
    }

    func testEmergencyEventRequiresBothNullableParticipationWindowKeys() throws {
        var missingStart = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "PATIENT"
        )
        missingStart.removeValue(forKey: "eventPositionParticipationStartedAt")
        XCTAssertThrowsError(try decode(missingStart, as: EmergencyEvent.self))

        var missingEnd = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "PATIENT"
        )
        missingEnd.removeValue(forKey: "eventPositionParticipationEndedAt")
        XCTAssertThrowsError(try decode(missingEnd, as: EmergencyEvent.self))
    }

    func testWritableEventRequiresNonNullParticipationStart() throws {
        var object = baseEventObject(
            state: "ACTIVE",
            recruitmentState: "RECRUITING",
            viewerRelationship: "PATIENT"
        )
        object["eventPositionParticipationStartedAt"] = NSNull()
        XCTAssertThrowsError(try decode(object, as: EmergencyEvent.self))
    }

    func testOfferExpiryBoundaryIsInclusiveAtExpiresAtAndExpiredAfterward() {
        let now = Date(timeIntervalSince1970: 1_788_000_000)
        let request = ResponseRequest(
            schemaVersion: "2.0",
            messageId: "message-expiry-boundary",
            eventId: eventID,
            deliveryId: deliveryID,
            deliveryStatus: .viewed,
            occurredAt: now.addingTimeInterval(-1),
            eventType: .fallAssistance,
            positioningTier: .searchRing,
            distanceRange: .zeroTo500Meters,
            etaRange: .zeroTo5Minutes,
            currentRecruitmentRadiusMeters: 1_000,
            expiresAt: now
        )

        XCTAssertFalse(request.isExpired(at: now))
        XCTAssertTrue(request.isExpired(at: now.addingTimeInterval(0.001)))
    }

    private func responseRequestObject() -> [String: Any] {
        [
            "schemaVersion": "2.0",
            "messageId": "message-offer-privacy",
            "eventId": eventID,
            "deliveryId": deliveryID,
            "deliveryStatus": "SENT",
            "occurredAt": "2026-08-31T01:02:04Z",
            "eventType": "FALL_ASSISTANCE",
            "positioningTier": "SEARCH_RING",
            "distanceRange": "DISTANCE_0_500M",
            "etaRange": "ETA_0_5_MIN",
            "currentRecruitmentRadiusMeters": 1_000,
            "expiresAt": "2026-08-31T01:02:34Z"
        ]
    }

    private func baseEventObject(
        state: String,
        recruitmentState: String,
        viewerRelationship: String
    ) -> [String: Any] {
        let canPublish = state == "ACTIVE"
            && (viewerRelationship == "PATIENT" || viewerRelationship == "RESPONDER")
        return [
            "id": eventID,
            "state": state,
            "recruitmentState": recruitmentState,
            "eventType": "FALL_ASSISTANCE",
            "positioningTier": viewerRelationship == "NEUTRAL" ? "SEARCH_RING" : "EVENT_PARTICIPANT",
            "canPublishEventPosition": canPublish,
            "eventPositionParticipationStartedAt": canPublish
                ? "2026-08-31T01:02:04Z"
                : NSNull(),
            "eventPositionParticipationEndedAt": NSNull(),
            "currentRecruitmentRadiusMeters": 1_000,
            "distanceRange": "DISTANCE_0_500M",
            "etaRange": "ETA_0_5_MIN",
            "expiresAt": "2026-08-31T01:02:34Z",
            "viewerRelationship": viewerRelationship,
            "createdAt": "2026-08-31T01:02:04Z"
        ]
    }

    private func patientPositionObject() -> [String: Any] {
        [
            "kind": "P",
            "latitude": 22.1987,
            "longitude": 113.5439,
            "accuracyMeters": 12
        ]
    }

    private func coordinationObject() -> [String: Any] {
        [
            "revision": 2,
            "nearbyCandidateCount": 2,
            "pendingOfferCount": 1,
            "acceptedResponderCount": 1,
            "goToPatientCount": 1,
            "fetchAedCount": 0,
            "enRouteCount": 0,
            "arrivedAtAedCount": 0,
            "arrivedAtPatientCount": 0,
            "aedAcquiredCount": 0,
            "completedAssignmentCount": 0
        ]
    }

    private func decode<T: Decodable>(_ object: [String: Any], as type: T.Type) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder.contractDecoder().decode(type, from: data)
    }
}
