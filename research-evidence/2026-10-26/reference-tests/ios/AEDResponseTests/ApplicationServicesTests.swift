import Foundation
import XCTest
@testable import AEDResponse

final class ApplicationServicesTests: XCTestCase {
    func testDemoScenarioEngineProducesOnlyActiveWatchTriggeredEvent() throws {
        let scenario = try loadScenario()
        let engine = DemoScenarioEngine()

        let event = engine.makePatientEvent(scenario: scenario)
        let request = engine.makeResponseRequest(
            scenario: scenario,
            messageID: "message-test",
            deliveryID: "delivery-test"
        )
        XCTAssertEqual(event.state, .active)
        XCTAssertEqual(event.recruitmentState, .recruiting)
        XCTAssertEqual(event.triggerSource, .watchFallNoResponseOutgoingCallObserved)
        XCTAssertEqual(event.viewerRelationship, .patient)
        XCTAssertEqual(event.callFirstObservedAt, scenario.watchObservation.callFirstObservedAt)
        XCTAssertEqual(request.schemaVersion, "2.0")
        XCTAssertEqual(request.eventId, event.id)
        XCTAssertEqual(request.deliveryStatus, .sent)
        XCTAssertEqual(request.eventType, .fallAssistance)
        XCTAssertEqual(request.positioningTier, .searchRing)
        XCTAssertEqual(request.distanceRange, .zeroTo500Meters)
        XCTAssertEqual(request.etaRange, .zeroTo5Minutes)
        XCTAssertEqual(request.currentRecruitmentRadiusMeters, 1_000)
        XCTAssertEqual(request.expiresAt, request.occurredAt.addingTimeInterval(30))
    }

    func testDemoAssignmentFactoryUsesExplicitServerRoleAndRAPRoute() throws {
        let scenario = try loadScenario()
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-assignment-test",
            deliveryID: "delivery-assignment-test"
        )
        let triggerAt = scenario.watchObservation.callFirstObservedAt
            ?? scenario.watchObservation.fallDetectedAt
        let factory = DemoAssignmentFactory()

        for acceptedCount in 1...5 {
            let plan = try AssignmentPlanner.plan(forAcceptedCount: acceptedCount)
            for role in [AssignmentRole.goToPatient, .fetchAed] where plan.count(for: role) > 0 {
                let assignment = try factory.makeAssignment(
                    request: request,
                    scenario: scenario,
                    acceptedCount: acceptedCount,
                    assignedRole: role,
                    responderFixtureIndex: 0,
                    assignmentID: "assignment-\(acceptedCount)-\(role.rawValue)",
                    at: triggerAt
                )
                XCTAssertEqual(assignment.role, role)
                if assignment.role == .fetchAed {
                    XCTAssertEqual(assignment.route?.pathKinds, [.responder, .aed, .patient])
                } else {
                    XCTAssertNil(assignment.route)
                }
            }
        }

        XCTAssertThrowsError(
            try factory.makeAssignment(
                request: request,
                scenario: scenario,
                acceptedCount: 1,
                assignedRole: .fetchAed,
                responderFixtureIndex: 0,
                assignmentID: "assignment-invalid-aed-role",
                at: triggerAt
            )
        )
    }

    func testTimelineReducerDeduplicatesAndSortsDeterministically() {
        let base = Date(timeIntervalSince1970: 100)
        let current = [
            TimelineEntry(
                id: "b",
                eventId: "event",
                occurredAt: base.addingTimeInterval(2),
                kind: .eventActivated,
                message: "later"
            )
        ]
        let incoming = [
            TimelineEntry(
                id: "b",
                eventId: "event",
                occurredAt: base,
                kind: .watchFallNoResponseOutgoingCallObserved,
                message: "duplicate"
            ),
            TimelineEntry(
                id: "c",
                eventId: "event",
                occurredAt: base.addingTimeInterval(1),
                kind: .receiptAdvanced,
                message: "middle"
            ),
            TimelineEntry(
                id: "a",
                eventId: "event",
                occurredAt: base.addingTimeInterval(1),
                kind: .responseRequested,
                message: "same time, lower id"
            )
        ]

        let merged = TimelineReducer.merging(current: current, incoming: incoming)

        XCTAssertEqual(merged.map(\.id), ["a", "c", "b"])
        XCTAssertEqual(merged.filter { $0.id == "b" }.count, 1)
        XCTAssertEqual(merged.last?.message, "later")
    }

    @MainActor
    func testLocationProviderExplicitlyStartsAndStopsContinuousUpdates() {
        let provider = LocationProvider(manager: nil)
        XCTAssertFalse(provider.isContinuousUpdating)
        provider.startContinuousUpdates()
        XCTAssertTrue(provider.isContinuousUpdating)
        provider.stopContinuousUpdates()
        XCTAssertFalse(provider.isContinuousUpdating)
    }

    private func loadScenario() throws -> DemoScenario {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let repositoryURL = root.appending(path: "contracts/fixtures/demo-scenario.json")
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

    /// The bundled agreements must decode with the same decoder the app uses at
    /// runtime.  A JSON/model mismatch would leave the consent gate with no
    /// readable document, which is exactly the App Store 5.1.1(i) failure this
    /// work is meant to prevent.
    func testBundledAgreementResourceDecodesWithContractDecoder() throws {
        let documents = try ResourceLoader.agreementDocuments(bundle: .main)
        XCTAssertEqual(documents.schemaVersion, "2.0")
        XCTAssertEqual(documents.documents.count, AgreementKind.allCases.count)
        for kind in AgreementKind.allCases {
            let document = try XCTUnwrap(documents.document(for: kind))
            XCTAssertTrue(document.isReadable)
            XCTAssertEqual(document.kind, kind)
            XCTAssertFalse(document.sections.isEmpty)
        }
        // Contact details are still template placeholders at this point.
        XCTAssertFalse(documents.isReadyForSubmission)
    }
}
