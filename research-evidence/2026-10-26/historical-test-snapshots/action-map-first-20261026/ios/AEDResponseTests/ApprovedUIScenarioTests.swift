import Foundation
import XCTest
@testable import AEDResponse

/// Small, deterministic checks backing the TestHost UI scenarios.  These tests
/// deliberately exercise the fixture/model layer only; they do not construct a
/// server, URL session, MapKit request, or production AppStore mutation.
final class ApprovedUIScenarioTests: XCTestCase {
    func testLoginConsentRequiresEveryReadableAgreementAndStartsUnchecked() {
        let kinds = AgreementKind.allCases
        let readable = Set(kinds)
        XCTAssertFalse(LoginAgreementConsent().canSignIn(readableKinds: readable))
        for mask in 0..<(1 << kinds.count) {
            let accepted = Set(kinds.enumerated().compactMap { index, kind in
                mask & (1 << index) != 0 ? kind : nil
            })
            let consent = LoginAgreementConsent(acceptedKinds: accepted)
            XCTAssertEqual(consent.canSignIn(readableKinds: readable), mask == (1 << kinds.count) - 1)
        }
        let allAccepted = LoginAgreementConsent(acceptedKinds: readable)
        for missing in kinds {
            XCTAssertFalse(allAccepted.canSignIn(readableKinds: readable.subtracting([missing])))
        }
    }

    func testNearbyFixtureCanBeGeneratedAtControlledNowAndIsNotExpired() throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "ui-nearby-message",
            deliveryID: "ui-nearby-delivery",
            occurredAt: now
        )

        XCTAssertEqual(request.eventType, .fallAssistance)
        XCTAssertEqual(request.positioningTier, .searchRing)
        XCTAssertFalse(request.isExpired(at: now))
        XCTAssertGreaterThan(request.expiresAt, now)
        XCTAssertEqual(request.expiresAt.timeIntervalSince(request.occurredAt), 30)
    }

    func testResponderFixtureUsesTruthfulCountsAndRapRoute() throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "ui-responder-message",
            deliveryID: "ui-responder-delivery",
            occurredAt: now
        )
        let plan = try AssignmentPlanner.plan(forAcceptedCount: 2)
        let assignment = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: plan.acceptedCount,
            assignedRole: .fetchAed,
            responderFixtureIndex: 0,
            assignmentID: "ui-responder-assignment",
            at: now
        )

        let expectedCounts = try XCTUnwrap(
            scenario.expectedRoleCountsByAcceptedCount[String(plan.acceptedCount)]
        )
        XCTAssertEqual(plan.patientCount, expectedCounts.goToPatient)
        XCTAssertEqual(plan.aedCount, expectedCounts.fetchAed)
        XCTAssertEqual(assignment.role, .fetchAed)
        XCTAssertEqual(
            assignment.route?.pathKinds,
            scenario.expectedAedPathKinds
        )
        XCTAssertEqual(assignment.route?.patientPosition, scenario.patient.patientPosition)
        XCTAssertTrue(
            scenario.aeds.contains {
                $0.id == assignment.route?.aedId && $0.available
            }
        )
    }

    private func loadScenario() throws -> DemoScenario {
        let repositoryURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "contracts/fixtures/demo-scenario.json")
        let url = FileManager.default.fileExists(atPath: repositoryURL.path)
            ? repositoryURL
            : try XCTUnwrap(
                Bundle.main.url(forResource: "demo-scenario", withExtension: "json")
            )
        return try JSONDecoder.contractDecoder().decode(
            DemoScenario.self,
            from: Data(contentsOf: url)
        )
    }
}
