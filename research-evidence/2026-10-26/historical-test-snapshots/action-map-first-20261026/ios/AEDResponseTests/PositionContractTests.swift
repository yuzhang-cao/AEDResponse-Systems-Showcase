import Foundation
import XCTest
@testable import AEDResponse

final class PositionContractTests: XCTestCase {
    func testStrictKindsRoundTrip() throws {
        let patient = try PatientPosition(latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12)
        let responder = try ResponderPosition(latitude: 22.198, longitude: 113.543, accuracyMeters: 10)
        let aed = try AedPosition(latitude: 22.199, longitude: 113.544)
        let encoder = JSONEncoder.contractEncoder()
        let decoder = JSONDecoder.contractDecoder()

        XCTAssertEqual(try decoder.decode(PatientPosition.self, from: encoder.encode(patient)).kind, .patient)
        XCTAssertEqual(try decoder.decode(ResponderPosition.self, from: encoder.encode(responder)).kind, .responder)
        XCTAssertEqual(try decoder.decode(AedPosition.self, from: encoder.encode(aed)).kind, .aed)
    }

    func testPatientDecoderRejectsResponderKind() {
        let data = Data(#"{"kind":"R","latitude":22.1,"longitude":113.5}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(PatientPosition.self, from: data))
    }

    func testPatientAndResponderRequireAccuracy() {
        let patient = Data(#"{"kind":"P","latitude":22.1,"longitude":113.5}"#.utf8)
        let responder = Data(#"{"kind":"R","latitude":22.1,"longitude":113.5}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(PatientPosition.self, from: patient))
        XCTAssertThrowsError(try JSONDecoder().decode(ResponderPosition.self, from: responder))
    }

    func testCoordinateBoundsAreValidated() {
        XCTAssertThrowsError(try PatientPosition(latitude: 90.1, longitude: 0, accuracyMeters: 10))
        XCTAssertThrowsError(try ResponderPosition(latitude: 0, longitude: -180.1, accuracyMeters: 10))
        XCTAssertThrowsError(try AedPosition(latitude: 0, longitude: 0, accuracyMeters: 0))
    }

    func testAedRouteDecoderRequiresExactRAPOrder() throws {
        let invalid = Data(
            #"""
            {
              "aedId":"aed-1",
              "path":[
                {"kind":"R","latitude":22.1,"longitude":113.5},
                {"kind":"P","latitude":22.2,"longitude":113.6},
                {"kind":"A","latitude":22.3,"longitude":113.7}
              ],
              "distanceMeters":10,
              "distanceSource":"AMAP_WALKING"
            }
            """#.utf8
        )
        XCTAssertThrowsError(try JSONDecoder().decode(AedRoute.self, from: invalid))
    }

    func testLatestDevicePositionRequiresEventOnlyForPatientKind() throws {
        let decoder = JSONDecoder.contractDecoder()
        let validPatient = Data(
            #"{"positionUpdateId":"REDACTED-SUPPLEMENT-ID-c11b2d3983cc","position":{"kind":"P","latitude":22.1,"longitude":113.5,"accuracyMeters":8},"eventId":"REDACTED-SUPPLEMENT-ID-ef81f1a34651","observedAt":"2026-09-01T00:00:00Z","serverReceivedAt":"2026-09-01T00:00:01Z"}"#.utf8
        )
        let validResponder = Data(
            #"{"positionUpdateId":"REDACTED-SUPPLEMENT-ID-55cf02864771","position":{"kind":"R","latitude":22.1,"longitude":113.5,"accuracyMeters":8},"observedAt":"2026-09-01T00:00:00Z","serverReceivedAt":"2026-09-01T00:00:01Z"}"#.utf8
        )
        XCTAssertNoThrow(try decoder.decode(LatestDevicePosition.self, from: validPatient))
        XCTAssertNoThrow(try decoder.decode(LatestDevicePosition.self, from: validResponder))

        let patientWithoutEvent = Data(
            #"{"positionUpdateId":"REDACTED-SUPPLEMENT-ID-8c84248ab6ab","position":{"kind":"P","latitude":22.1,"longitude":113.5,"accuracyMeters":8},"observedAt":"2026-09-01T00:00:00Z","serverReceivedAt":"2026-09-01T00:00:01Z"}"#.utf8
        )
        let responderWithEvent = Data(
            #"{"positionUpdateId":"REDACTED-SUPPLEMENT-ID-0a41538f7ff3","position":{"kind":"R","latitude":22.1,"longitude":113.5,"accuracyMeters":8},"eventId":"REDACTED-SUPPLEMENT-ID-ef81f1a34651","observedAt":"2026-09-01T00:00:00Z","serverReceivedAt":"2026-09-01T00:00:01Z"}"#.utf8
        )
        XCTAssertThrowsError(try decoder.decode(LatestDevicePosition.self, from: patientWithoutEvent))
        XCTAssertThrowsError(try decoder.decode(LatestDevicePosition.self, from: responderWithEvent))
    }

    func testEmergencyEventDecodesEveryCanonicalPatientPositionSource() throws {
        let position = try PatientPosition(
            latitude: 22.1987,
            longitude: 113.5439,
            accuracyMeters: 8
        )
        let timestamp = Date(timeIntervalSince1970: 1_788_000_000)
        for source in PatientPositionSource.allCases {
            let event = EmergencyEvent(
                id: "REDACTED-SUPPLEMENT-ID-e2b400c8ac28",
                state: .active,
                recruitmentState: .recruiting,
                canPublishEventPosition: true,
                triggerSource: .watchFallHelpConfirmed,
                fallDetectedAt: timestamp,
                fallResolution: .unresponsive,
                callFirstObservedAt: timestamp.addingTimeInterval(1),
                patientPosition: position,
                patientPositionSource: source,
                patientPositionObservedAt: timestamp,
                patientPositionServerReceivedAt: timestamp.addingTimeInterval(2),
                patientLocationCard: nil,
                viewerRelationship: .patient,
                createdAt: timestamp.addingTimeInterval(2),
                resolvedAt: nil,
                eventPositionParticipationStartedAt: timestamp.addingTimeInterval(2),
                eventPositionParticipationEndedAt: nil,
                pendingResponseRequest: nil,
                currentAssignment: nil
            )

            let data = try JSONEncoder.contractEncoder().encode(event)
            let decoded = try JSONDecoder.contractDecoder().decode(
                EmergencyEvent.self,
                from: data
            )

            XCTAssertEqual(decoded.patientPositionSource, source)
        }
    }
}
