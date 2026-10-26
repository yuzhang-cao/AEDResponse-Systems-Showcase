import Foundation
import XCTest
@testable import AEDResponse

final class FixtureContractTests: XCTestCase {
    func testRecoveryHintsDecodeWithExistingTimelineContract() throws {
        for kind in ["EVENT_ACTIVATED", "FALSE_ALARM_CONFIRMED", "EVENT_RESOLVED", "PASSIVE_OBSERVATION"] {
            let data = Data("""
            [{"id":"REDACTED-SUPPLEMENT-ID-11e594f48195",
              "eventId":"REDACTED-SUPPLEMENT-ID-11e594f48195",
              "occurredAt":"2026-09-09T00:00:00.123Z",
              "kind":"\(kind)","message":"Event state recovered from the authorized snapshot."}]
            """.utf8)
            let hints = try JSONDecoder.contractDecoder().decode([TimelineEntry].self, from: data)
            XCTAssertEqual(hints.count, 1)
            XCTAssertEqual(hints[0].kind.rawValue, kind)
            XCTAssertEqual(hints[0].id, hints[0].eventId)
        }
    }

    func testSharedV2FixtureDecodesWatchObservationAndStrictPositions() throws {
        let fixture = try loadScenario()

        XCTAssertEqual(fixture.schemaVersion, "2.0.0")
        XCTAssertEqual(fixture.watchObservation.schemaVersion, "2.0")
        XCTAssertEqual(fixture.watchObservation.observationKind, .fallContext)
        XCTAssertEqual(fixture.watchObservation.appHelpResponse, .noResponse)
        XCTAssertEqual(
            fixture.watchObservation.callObservationSemantics,
            .firstObservedOutgoingState
        )
        XCTAssertEqual(fixture.watchObservation.patientPosition?.kind, .patient)
        XCTAssertTrue(fixture.responders.allSatisfy { $0.responderPosition.kind == .responder })
        XCTAssertTrue(fixture.responders.allSatisfy { $0.responderPosition.accuracyMeters > 0 })
        XCTAssertTrue(fixture.aeds.allSatisfy { $0.aedPosition.kind == .aed })
        XCTAssertEqual(fixture.expectedAedPathKinds, [.responder, .aed, .patient])
    }

    func testFixtureAssignmentMatrixMatchesFormulaForOneThroughFive() throws {
        let fixture = try loadScenario()

        for count in 1...5 {
            let expected = try XCTUnwrap(fixture.expectedRoleCountsByAcceptedCount[String(count)])
            let plan = try AssignmentPlanner.plan(forAcceptedCount: count)
            XCTAssertEqual(expected.goToPatient, plan.patientCount)
            XCTAssertEqual(expected.fetchAed, plan.aedCount)
            XCTAssertEqual(expected.goToPatient + expected.fetchAed, count)
        }
    }

    func testFixtureAedAcquiredReceiptHasCompleteBusinessKey() throws {
        let receipt = try loadScenario().aedAcquiredReceipt

        XCTAssertFalse(receipt.receiptId.isEmpty)
        XCTAssertFalse(receipt.eventId.isEmpty)
        XCTAssertFalse(receipt.assignmentId.isEmpty)
        XCTAssertFalse(receipt.aedId.isEmpty)
        XCTAssertEqual(receipt.businessKey, "\(receipt.eventId)|\(receipt.assignmentId)|\(receipt.aedId)")
    }

    func testSharedSafetyFixtureMatchesV2HardBoundaries() throws {
        let policy: SafetyPolicy = try decodeContract(
            SafetyPolicy.self,
            pathComponents: ["contracts", "safety.json"]
        )
        try policy.validateBoundaries()

        XCTAssertEqual(policy.schemaVersion, "2.0.0")
        XCTAssertFalse(policy.manualSOSEnabled)
        XCTAssertFalse(policy.appFalseAlarmCountdownEnabled)
        XCTAssertFalse(policy.mockWearableProductionEntryEnabled)
        XCTAssertFalse(policy.iphoneFallDetectionEnabled)
        XCTAssertFalse(policy.automaticCallingEnabled)
    }

    func testOpenAPIV21AddsPhonePositionPresenceAndCoordinationContracts() throws {
        let source = try String(
            contentsOf: contractURL(
                pathComponents: ["contracts", "openapi.yaml"],
                bundledName: "openapi",
                bundledExtension: "yaml"
            ),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("version: 2.1.0"))
        XCTAssertTrue(source.contains("/session/bootstrap:"))
        XCTAssertTrue(source.contains("/watch/emergency-observations/{eventId}:"))
        XCTAssertTrue(source.contains("/aed-acquired:"))
        XCTAssertTrue(source.contains("/me/responder-position:"))
        XCTAssertTrue(source.contains("/events/{eventId}/patient-position:"))
        XCTAssertTrue(source.contains("/watch/events/{eventId}/fallback-position/{positionUpdateId}:"))
        XCTAssertTrue(source.contains("/me/presence:"))
        XCTAssertTrue(source.contains("positionUpdateId"))
        XCTAssertTrue(source.contains("CoordinationSummary:"))
        XCTAssertTrue(source.contains("PendingDeliveryStatus:"))
        XCTAssertTrue(source.contains("PatientPositionSource:"))
        XCTAssertTrue(source.contains("WATCH_TRIGGER_SNAPSHOT"))
        XCTAssertTrue(source.contains("IPHONE_PRIMARY"))
        XCTAssertTrue(source.contains("WATCH_FALLBACK"))
        XCTAssertTrue(source.contains("callFirstObservedAt"))
        XCTAssertFalse(source.contains("/auth/login:"))
        XCTAssertFalse(source.contains("PENDING_CANCEL"))
        XCTAssertFalse(source.contains("GUIDE_AMBULANCE"))
        XCTAssertFalse(source.contains("MANUAL_SOS"))
        XCTAssertFalse(source.contains("WEARABLE_MOCK"))
    }

    func testAPIConfigurationDefaultsToV2Path() throws {
        let configuration = try APIConfiguration(userEnteredURL: "http://127.0.0.1:8787")
        XCTAssertEqual(configuration.baseURL.absoluteString, "http://127.0.0.1:8787/api/v2/")
        XCTAssertEqual(configuration.socketServerURL.absoluteString, "http://127.0.0.1:8787")
    }

    func testAPIConfigurationRejectsCredentialQueryFragmentAndNonV2Path() {
        for value in [
            "https://[REDACTED_EMAIL]",
            "https://example.test/api/v2?tenant=other",
            "https://example.test/api/v2#fragment",
            "https://example.test/custom"
        ] {
            XCTAssertThrowsError(try APIConfiguration(userEnteredURL: value), value)
        }
    }

    func testSessionBootstrapRequiresCanonicalAuthenticatedTokenShape() throws {
        let data = Data(
            #"{"sessionId":"REDACTED-SUPPLEMENT-ID-7ac1b8d7010b","sessionToken":"token","expiresAt":"2026-08-31T02:00:00Z","scopes":["events:read"]}"#.utf8
        )
        let response = try JSONDecoder.contractDecoder().decode(
            SessionBootstrapResponse.self,
            from: data
        )

        XCTAssertEqual(response.token, "token")
        XCTAssertEqual(response.scopes, ["events:read"])
        XCTAssertThrowsError(
            try JSONDecoder.contractDecoder().decode(
                SessionBootstrapResponse.self,
                from: Data(#"{"token":"legacy"}"#.utf8)
            )
        )
    }

    private func loadScenario() throws -> DemoScenario {
        try decodeContract(
            DemoScenario.self,
            pathComponents: ["contracts", "fixtures", "demo-scenario.json"]
        )
    }

    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func decodeContract<T: Decodable>(
        _ type: T.Type,
        pathComponents: [String]
    ) throws -> T {
        let filename = try XCTUnwrap(pathComponents.last)
        let fileURL = URL(fileURLWithPath: filename)
        let url = try contractURL(
            pathComponents: pathComponents,
            bundledName: fileURL.deletingPathExtension().lastPathComponent,
            bundledExtension: fileURL.pathExtension
        )
        return try JSONDecoder.contractDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    private func contractURL(
        pathComponents: [String],
        bundledName: String,
        bundledExtension: String
    ) throws -> URL {
        let repositoryURL = pathComponents.reduce(repositoryRoot) { partial, component in
            partial.appending(path: component)
        }
        if FileManager.default.fileExists(atPath: repositoryURL.path) { return repositoryURL }
        return try XCTUnwrap(
            Bundle.main.url(forResource: bundledName, withExtension: bundledExtension),
            "缺少测试资源 \(bundledName).\(bundledExtension)"
        )
    }
}
