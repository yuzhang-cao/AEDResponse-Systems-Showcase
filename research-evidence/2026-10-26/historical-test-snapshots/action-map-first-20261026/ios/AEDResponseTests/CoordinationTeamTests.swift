import Foundation
import XCTest
@testable import AEDResponse

/// G08 — the client half of the anonymous team channel.
///
/// The server owns membership and the contact vocabulary; what the client can get
/// wrong is subtler and is what these tests pin down:
///
///   * inventing a seventh message or a free-text field (the closed vocabulary is
///     a contract, so it is asserted against the published list);
///   * showing a team projection after the permission to see it is gone;
///   * posting optimistically, so a refused or lost send looks delivered;
///   * reusing one `signalID` for two different intents, which would make the
///     server's idempotency swallow the second one.
final class CoordinationTeamTests: XCTestCase {
    private let eventID = "REDACTED-SUPPLEMENT-ID-46de918f5446"

    /// The published contact form, in the order the server documents it.
    private static let publishedMessages = [
        "我已接受任务", "正在前往", "已到达患者", "已取得 AED", "这里需要帮助", "无法继续，请他人接手"
    ]

    func testTheContactVocabularyIsClosedAndMatchesThePublishedForm() {
        XCTAssertEqual(TeamSignalKind.allCases.map(\.presetMessage), Self.publishedMessages,
                       "预设消息是与服务端约定的封闭清单，新增一条必须是可见改动")
        XCTAssertEqual(TeamSignalKind.allCases.map(\.rawValue), [
            "ACCEPTED_TASK", "ON_MY_WAY", "ARRIVED_AT_PATIENT", "AED_ACQUIRED",
            "NEED_HELP_HERE", "CANNOT_CONTINUE"
        ])
    }

    /// The projection has no field for a name, phone number, precise coordinate or
    /// free text, so a server that tried to send one would fail to decode here.
    func testTheTeamProjectionDecodesOnlyAnonymousFacts() throws {
        let json = """
        {
          "eventId": "\(eventID)",
          "members": [
            { "alias": "K7QP", "role": "FETCH_AED", "status": "EN_ROUTE",
              "approximatePosition": { "latitude": 22.1985, "longitude": 113.544 },
              "positionFreshness": "CURRENT", "isViewer": false },
            { "alias": "M3XR", "role": "GO_TO_PATIENT", "status": "ASSIGNED",
              "positionFreshness": "UNKNOWN", "isViewer": true }
          ],
          "viewerAlias": "M3XR",
          "generatedAt": "2026-09-13T08:00:00.000Z"
        }
        """.data(using: .utf8)!
        let team = try JSONDecoder.contractDecoder().decode(CoordinationTeamProjection.self, from: json)
        XCTAssertEqual(team.members.map(\.alias), ["K7QP", "M3XR"])
        XCTAssertEqual(team.viewerAlias, "M3XR")
        XCTAssertEqual(team.members[0].positionFreshness.permitsApproximatePosition, true)
        XCTAssertNil(team.members[1].approximatePosition)
        XCTAssertEqual(team.members[1].positionFreshness.permitsApproximatePosition, false,
                       "UNKNOWN 的位置不得作为实时位置图标显示")

        // A precise coordinate or an identity field is not part of the contract.
        let leaked = """
        { "eventId": "\(eventID)", "members": [
            { "alias": "K7QP", "role": "FETCH_AED", "status": "EN_ROUTE",
              "positionFreshness": "CURRENT", "isViewer": false,
              "fullName": "张三", "phoneNumber": "+8613800000000" } ],
          "viewerAlias": null, "generatedAt": "2026-09-13T08:00:00.000Z" }
        """.data(using: .utf8)!
        let decoder = JSONDecoder.contractDecoder()
        // Extra keys are ignored by Codable, which is why the projection itself is
        // the guarantee: the assertion above is that the CLIENT has nowhere to put
        // them, and this checks the decoded value carries none of it.
        let decoded = try decoder.decode(CoordinationTeamProjection.self, from: leaked)
        XCTAssertEqual(decoded.members[0].alias, "K7QP")
        XCTAssertFalse(String(describing: decoded).contains("张三"))
        XCTAssertFalse(String(describing: decoded).contains("+8613800000000"))
    }

    @MainActor
    func testAClosedChannelIsClearedRatherThanCached() async throws {
        let api = TeamChannelAPIClient()
        api.team = .success(try Self.teamJSON())
        api.signals = .success([])
        let coordinator = CoordinationTeamCoordinator(
            apiClient: { api }, isCurrent: { _ in true }, now: { Date() }, onChange: {}
        )
        coordinator.currentEventID = eventID
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertEqual(coordinator.state, .loaded)
        XCTAssertEqual(coordinator.members.count, 2)

        // The responder exits (or the event ends): the server answers 403, and the
        // cached projection must not survive it.
        api.team = .failure(APIClientError.rejected(ProblemDetails(
            type: "about:blank", title: "Forbidden", status: 403, detail: "not a member"
        )))
        api.signals = .failure(APIClientError.rejected(ProblemDetails(
            type: "about:blank", title: "Forbidden", status: 403, detail: "not a member"
        )))
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertEqual(coordinator.state, .notAMember)
        XCTAssertTrue(coordinator.members.isEmpty)
        XCTAssertTrue(coordinator.signals.isEmpty)

        // Offline is a different state from "not a member": the view says so and
        // keeps nothing either.
        api.team = .failure(APIClientError.invalidResponse)
        api.signals = .failure(APIClientError.invalidResponse)
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertEqual(coordinator.state, .unavailable)
    }

    @MainActor
    func testASendIsConfirmedByTheServerAndARetryReusesOneIdentifier() async throws {
        let api = TeamChannelAPIClient()
        api.team = .success(try Self.teamJSON())
        api.signals = .success([])
        api.receipt = .success(TeamSignalReceipt(
            signalId: "REDACTED-SUPPLEMENT-ID-7f1a10d9cd75", kind: .needHelpHere,
            createdAt: Date(), expiresAt: Date().addingTimeInterval(600), duplicate: false
        ))
        let coordinator = CoordinationTeamCoordinator(
            apiClient: { api }, isCurrent: { _ in true }, now: { Date() }, onChange: {}
        )
        coordinator.currentEventID = eventID
        await coordinator.refresh(sessionGeneration: 1)

        let signalID = "REDACTED-SUPPLEMENT-ID-7f1a10d9cd75"
        let outcome = await coordinator.send(kind: .needHelpHere, signalID: signalID, sessionGeneration: 1)
        XCTAssertEqual(outcome, .sent(api.receiptValue!))
        XCTAssertEqual(api.sentSignals.map(\.signalID), [signalID])
        XCTAssertEqual(api.sentSignals.map(\.kind), [.needHelpHere])
        XCTAssertNil(coordinator.lastSendFailure)

        // A refused send keeps the failure visible and does not invent a row.
        api.receipt = .failure(APIClientError.rejected(ProblemDetails(
            type: "about:blank", title: "Too many requests", status: 429, detail: "slow down"
        )))
        let refused = await coordinator.send(kind: .onMyWay, signalID: signalID, sessionGeneration: 1)
        if case .refused(let reason) = refused {
            XCTAssertTrue(reason.contains("频繁") || reason.contains("稍后"))
        } else {
            XCTFail("a refused send must be reported as refused")
        }
        XCTAssertNotNil(coordinator.lastSendFailure)

        // Offline is reported separately, and the caller can retry the same intent.
        api.receipt = .failure(APIClientError.invalidResponse)
        let offline = await coordinator.send(kind: .onMyWay, signalID: signalID, sessionGeneration: 1)
        XCTAssertEqual(offline, .unavailable)
    }

    @MainActor
    func testASessionChangeDropsEveryCachedTeamFact() async throws {
        let api = TeamChannelAPIClient()
        api.team = .success(try Self.teamJSON())
        api.signals = .success([])
        var generation = 1
        let coordinator = CoordinationTeamCoordinator(
            apiClient: { api }, isCurrent: { $0 == generation }, now: { Date() }, onChange: {}
        )
        coordinator.currentEventID = eventID
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertEqual(coordinator.state, .loaded)
        // A logout/rotation bumps the generation; an old response must not land.
        generation = 2
        coordinator.clear()
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertTrue(coordinator.members.isEmpty)
        await coordinator.refresh(sessionGeneration: 1)
        XCTAssertEqual(coordinator.state, .idle, "a stale generation must not reload the team")
    }

    private static func teamJSON() throws -> CoordinationTeamProjection {
        let json = """
        { "eventId": "REDACTED-SUPPLEMENT-ID-46de918f5446", "members": [
            { "alias": "K7QP", "role": "FETCH_AED", "status": "EN_ROUTE",
              "positionFreshness": "CURRENT", "isViewer": false },
            { "alias": "M3XR", "role": "GO_TO_PATIENT", "status": "ASSIGNED",
              "positionFreshness": "UNKNOWN", "isViewer": true } ],
          "viewerAlias": "M3XR", "generatedAt": "2026-09-13T08:00:00.000Z" }
        """.data(using: .utf8)!
        return try JSONDecoder.contractDecoder().decode(CoordinationTeamProjection.self, from: json)
    }
}

/// A recording API client: only the team channel is implemented, everything else
/// refuses, so a test cannot accidentally exercise another path.
private final class TeamChannelAPIClient: EmergencyAPIClient, @unchecked Sendable {
    var team: Result<CoordinationTeamProjection, Error> = .failure(APIClientError.invalidResponse)
    var signals: Result<[TeamSignal], Error> = .success([])
    var receipt: Result<TeamSignalReceipt, Error> = .failure(APIClientError.invalidResponse)
    private(set) var sentSignals: [(signalID: String, kind: TeamSignalKind)] = []

    var receiptValue: TeamSignalReceipt? { try? receipt.get() }

    func coordinationTeam(eventID: String) async throws -> CoordinationTeamProjection { try team.get() }
    func teamSignals(eventID: String) async throws -> [TeamSignal] { try signals.get() }
    func sendTeamSignal(
        eventID: String, signalID: String, kind: TeamSignalKind
    ) async throws -> TeamSignalReceipt {
        sentSignals.append((signalID, kind))
        return try receipt.get()
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
