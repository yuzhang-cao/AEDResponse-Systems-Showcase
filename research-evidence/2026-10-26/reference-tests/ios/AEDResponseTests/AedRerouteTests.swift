import Foundation
import XCTest
@testable import AEDResponse

/// G07 — the client half of the 15-second reroute question.
///
/// The server decides whether a proposal is worth making and whether an answer is
/// still valid.  What the client can get wrong is narrower and is what these tests
/// pin down:
///
///   * answering after the window, or extending its own window with a wrong clock;
///   * treating a `REFUSED` answer (the world changed) as an acceptance and
///     navigating to a device the backend never assigned;
///   * losing the offer because a transport error looked like a decision;
///   * keeping a question on screen after the task it belongs to is gone.
final class AedRerouteTests: XCTestCase {
    private let eventID = "REDACTED-ID-0159"
    private let now = Date(timeIntervalSince1970: 1_760_000_000)

    private func proposal(
        expiresIn seconds: TimeInterval,
        proposalID: String = "REDACTED-ID-0160"
    ) -> PendingRerouteProposal {
        PendingRerouteProposal(
            proposalId: proposalID,
            assignmentId: "REDACTED-ID-0161",
            fromAedId: "aed-patient",
            toAedId: "aed-mid",
            distanceMeters: 240,
            distanceSavingMeters: 180,
            proposedAt: now,
            expiresAt: now.addingTimeInterval(seconds)
        )
    }

    /// The wire contract, including the null case the server actually sends.
    func testPendingProposalDecodesAndTheNullCaseIsUnderstood() throws {
        let json = """
        { "proposal": { "proposalId": "REDACTED-ID-0160",
          "assignmentId": "REDACTED-ID-0161",
          "fromAedId": "aed-patient", "toAedId": "aed-mid",
          "distanceMeters": 240, "distanceSavingMeters": 180,
          "proposedAt": "2025-10-09T08:00:00.000Z", "expiresAt": "2025-10-09T08:00:15.000Z" } }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder.contractDecoder().decode(PendingRerouteResponse.self, from: json)
        XCTAssertEqual(decoded.proposal?.toAedId, "aed-mid")
        XCTAssertEqual(decoded.proposal?.distanceSavingMeters, 180)
        XCTAssertEqual(decoded.proposal?.isOpen(at: decoded.proposal!.proposedAt), true)
        XCTAssertEqual(decoded.proposal?.isOpen(at: decoded.proposal!.expiresAt), false,
                       "the deadline itself is closed: the server refuses an answer at expiresAt")
        XCTAssertEqual(decoded.proposal?.secondsRemaining(at: decoded.proposal!.proposedAt), 15)

        let empty = #"{ "proposal": null }"#.data(using: .utf8)!
        XCTAssertNil(try JSONDecoder.contractDecoder()
            .decode(PendingRerouteResponse.self, from: empty).proposal)
    }

    @MainActor
    func testAnExpiredQuestionIsDroppedAndNeverAccepted() async {
        let api = RerouteAPIClient()
        api.pending = .success(proposal(expiresIn: -1))
        var clock = now
        let coordinator = RerouteProposalCoordinator(
            apiClient: { api }, isCurrent: { _ in true }, now: { clock },
            currentPosition: { nil }, onChange: {}
        )
        coordinator.currentEventID = eventID
        await coordinator.refresh(sessionGeneration: 1)
        // The server sent a question whose window has already closed: it is shown as
        // expired rather than answered, and the decision endpoint is never called.
        coordinator.expireIfNeeded()
        XCTAssertNil(coordinator.proposal)
        XCTAssertEqual(coordinator.lastResolution, .expired)
        let answered = await coordinator.answer(true, sessionGeneration: 1)
        XCTAssertNil(answered)
        XCTAssertEqual(api.decisions.count, 0, "an expired question must not be answered")

        // A question that expires while it is on screen disappears by itself.  A
        // DIFFERENT proposal id, because the first one was already resolved.
        api.pending = .success(proposal(
            expiresIn: 15, proposalID: "REDACTED-ID-0161"))
        clock = now
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertNotNil(coordinator.proposal)
        XCTAssertEqual(coordinator.isVisible, true)
        clock = now.addingTimeInterval(16)
        XCTAssertEqual(coordinator.isVisible, false, "the server's deadline decides visibility")
        coordinator.expireIfNeeded()
        XCTAssertNil(coordinator.proposal)
        XCTAssertEqual(coordinator.lastResolution, .expired)
    }

    @MainActor
    func testAcceptanceIsSentOnceWithTheCurrentPositionAndRefusalKeepsTheTask() async {
        let api = RerouteAPIClient()
        api.pending = .success(proposal(expiresIn: 15))
        api.decision = .success(AedRerouteDecision(status: .accepted, route: nil, reason: nil))
        let position = try? ResponderPosition(latitude: 22.2095, longitude: 113.5439, accuracyMeters: 10)
        let coordinator = RerouteProposalCoordinator(
            apiClient: { api }, isCurrent: { _ in true }, now: { self.now },
            currentPosition: { position }, onChange: {}
        )
        coordinator.currentEventID = eventID
        await coordinator.refresh(sessionGeneration: 1)

        let resolution = await coordinator.answer(true, sessionGeneration: 1)
        XCTAssertEqual(resolution, .accepted(toAedId: "aed-mid"))
        XCTAssertNil(coordinator.proposal, "an answered question is gone")
        XCTAssertEqual(api.decisions.count, 1)
        XCTAssertEqual(api.decisions[0].accept, true)
        XCTAssertEqual(api.decisions[0].position?.latitude, 22.2095,
                       "the acceptance carries the position the server revalidates")

        // A second tap cannot answer twice.
        let secondAnswer = await coordinator.answer(true, sessionGeneration: 1)
        XCTAssertNil(secondAnswer)
        XCTAssertEqual(api.decisions.count, 1)

        // A refusal from the server (the world changed) is surfaced as a reason and
        // does NOT look like an acceptance.
        let second = self.proposal(expiresIn: 15, proposalID: "REDACTED-ID-0162")
        api.pending = .success(second)
        api.decision = .failure(APIClientError.rejected(ProblemDetails(
            type: "about:blank", title: "Conflict", status: 409,
            detail: "目标 AED 已被其他响应者取用"
        )))
        await coordinator.refresh(sessionGeneration: 1)
        let refused = await coordinator.answer(true, sessionGeneration: 1)
        guard case .refused(let reason) = refused else {
            return XCTFail("a refused answer must not look accepted")
        }
        XCTAssertTrue(reason.contains("已被其他响应者取用"))
        XCTAssertNil(coordinator.proposal)
        XCTAssertEqual(coordinator.lastResolution?.movedTheTask, false)

        // A transport failure is NOT a decision: the question stays while its window
        // is open so the responder can answer again.
        api.pending = .success(self.proposal(expiresIn: 15,
                                             proposalID: "REDACTED-ID-0163"))
        api.decision = .failure(APIClientError.invalidResponse)
        await coordinator.refresh(sessionGeneration: 1)
        let unreachable = await coordinator.answer(true, sessionGeneration: 1)
        XCTAssertNil(unreachable)
        XCTAssertNotNil(coordinator.proposal, "an unreachable server must not consume the offer")
    }

    @MainActor
    func testASessionChangeOrTaskChangeDropsTheQuestion() async {
        let api = RerouteAPIClient()
        api.pending = .success(proposal(expiresIn: 15))
        var generation = 1
        let coordinator = RerouteProposalCoordinator(
            apiClient: { api }, isCurrent: { $0 == generation }, now: { self.now },
            currentPosition: { nil }, onChange: {}
        )
        coordinator.currentEventID = eventID
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertNotNil(coordinator.proposal)

        // The responder exits or the event ends: the question belongs to a task that
        // no longer exists.
        coordinator.clear()
        XCTAssertNil(coordinator.proposal)
        generation = 2
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertNil(coordinator.proposal, "a stale generation must not reload the question")

        // A proposal answered earlier is not offered again if the server still lists it.
        generation = 3
        api.pending = .success(self.proposal(expiresIn: 15))
        api.decision = .success(AedRerouteDecision(status: .accepted, route: nil, reason: nil))
        let fresh = RerouteProposalCoordinator(
            apiClient: { api }, isCurrent: { _ in true }, now: { self.now },
            currentPosition: { nil }, onChange: {}
        )
        fresh.currentEventID = eventID
        await fresh.refresh(sessionGeneration: 3)
        _ = await fresh.answer(false, sessionGeneration: 3)
        await fresh.refresh(sessionGeneration: 3)
        XCTAssertNil(fresh.proposal, "an already answered proposal is not offered twice")
    }
}

/// Records the decisions it is asked to send; the rest of the client refuses.
private final class RerouteAPIClient: EmergencyAPIClient, @unchecked Sendable {
    var pending: Result<PendingRerouteProposal?, Error> = .success(nil)
    var decision: Result<AedRerouteDecision, Error> =
        .success(AedRerouteDecision(status: .rejected, route: nil, reason: nil))
    private(set) var decisions: [(accept: Bool, position: ResponderPosition?)] = []

    func pendingAedReroute(eventID: String) async throws -> PendingRerouteProposal? {
        try pending.get()
    }

    func decideAedReroute(
        eventID: String, proposalID: String, accept: Bool, decidedAt: Date,
        responderPosition: ResponderPosition?
    ) async throws -> AedRerouteDecision {
        decisions.append((accept, responderPosition))
        return try decision.get()
    }

    // MARK: - unused surface
    func bootstrapSession(request: DeviceSessionBootstrapRequest) async throws -> SessionBootstrapResponse {
        throw APIClientError.unsupportedOperation("bootstrap")
    }
    func listEvents() async throws -> [EmergencyEvent] { [] }
    func event(id: String) async throws -> EmergencyEvent {
        throw APIClientError.unsupportedOperation("event")
    }
    func confirmFalseAlarm(eventID: String) async throws -> EmergencyEvent {
        throw APIClientError.unsupportedOperation("confirmFalseAlarm")
    }
    func resolveEvent(
        eventID: String, resolutionID: String, actor: ResolutionActor, resolvedAt: Date
    ) async throws -> EmergencyEvent { throw APIClientError.unsupportedOperation("resolveEvent") }
    func exitEvent(
        eventID: String, exitID: String, exitedAt: Date, reason: String?, soleResponderConfirmed: Bool?
    ) async throws -> ParticipantExitResult { throw APIClientError.unsupportedOperation("exitEvent") }
    func continueStatusConfirmation(
        eventID: String, confirmationID: String, respondedAt: Date
    ) async throws -> StatusConfirmationResult {
        throw APIClientError.unsupportedOperation("statusConfirmation")
    }
    func sendReceipt(
        eventID: String, deliveryID: String, status: DeliveryStatus, occurredAt: Date
    ) async throws { throw APIClientError.unsupportedOperation("sendReceipt") }
    func respond(
        eventID: String, deliveryID: String, accept: Bool, decidedAt: Date
    ) async throws -> RespondResult { throw APIClientError.unsupportedOperation("respond") }
    func reportAedUnavailable(
        reportID: String, eventID: String, assignmentID: String, aedID: String,
        reportedAt: Date, reason: String
    ) async throws { throw APIClientError.unsupportedOperation("aedUnavailable") }
    func reportAedAcquired(_ receipt: AedAcquiredReceipt) async throws -> AedAcquiredReceipt {
        throw APIClientError.unsupportedOperation("aedAcquired")
    }
    func updateAssignmentStatus(
        eventID: String, assignmentID: String, status: AssignmentStatus, occurredAt: Date
    ) async throws -> Assignment { throw APIClientError.unsupportedOperation("assignmentStatus") }
    func timeline(eventID: String) async throws -> [TimelineEntry] { [] }
    func fetchPresence() async throws -> DevicePresence {
        throw APIClientError.unsupportedOperation("fetchPresence")
    }
    func updatePresence(_ update: DevicePresenceUpdate) async throws -> DevicePresence {
        throw APIClientError.unsupportedOperation("updatePresence")
    }
    func updateResponderPosition(_ update: ResponderPositionUpdate) async throws -> PositionUpdateResult {
        throw APIClientError.unsupportedOperation("responderPosition")
    }
    func updatePatientPosition(
        eventID: String, update: PatientPositionUpdate
    ) async throws -> PositionUpdateResult {
        throw APIClientError.unsupportedOperation("patientPosition")
    }
    func sendEventPositionBatch(
        eventID: String, batchID: String, batch: EventPositionBatch
    ) async throws -> EventPositionBatchAck {
        throw APIClientError.unsupportedOperation("positionBatch")
    }
    func fetchAeds() async throws -> [Aed] { [] }
    func estimateRoute(
        responderPosition: ResponderPosition, patientPosition: PatientPosition, at: Date
    ) async throws -> AedRoute { throw APIClientError.unsupportedOperation("estimateRoute") }
    func submitEnd(eventID: String, request command: EventEndRequest) async throws -> EmergencyEvent {
        throw APIClientError.unsupportedOperation("submitEnd")
    }
}
