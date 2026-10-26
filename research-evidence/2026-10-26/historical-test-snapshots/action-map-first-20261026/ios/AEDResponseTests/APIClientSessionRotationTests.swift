import Foundation
import XCTest
@testable import AEDResponse

final class APIClientSessionRotationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_000_000)

    func testRecoveryDoesNotTreatTransportOrServerFailureAsLogout() {
        XCTAssertFalse(APIClientError.isPermanentAuthenticationFailure(URLError(.notConnectedToInternet)))
        XCTAssertFalse(APIClientError.isPermanentAuthenticationFailure(URLError(.timedOut)))
        XCTAssertFalse(APIClientError.isPermanentAuthenticationFailure(APIClientError.unexpectedStatus(503)))
        XCTAssertFalse(APIClientError.isPermanentAuthenticationFailure(APIClientError.unexpectedStatus(429)))
        XCTAssertTrue(APIClientError.isPermanentAuthenticationFailure(APIClientError.unexpectedStatus(401)))
        XCTAssertTrue(APIClientError.isPermanentAuthenticationFailure(APIClientError.unexpectedStatus(403)))
    }

    func testPushRegistrationAndTapUseDeviceAuthenticatedREST() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3600)),
            .json(statusCode: 201, body: "{}"),
            .json(statusCode: 200, body: #"{"messageId":"notification-1","eventId":null,"actionable":false}"#)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let token = PushTokenRequest(pushToken: String(repeating: "ab", count: 32),
                                    pushEnvironment: "SANDBOX", bundleId: "example.test")
        try await client.registerPushToken(token)
        let route = try await client.notificationRoute(messageID: "notification-1")
        XCTAssertFalse(route.actionable)
        XCTAssertNil(route.eventId)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests[1].path, "/api/v2/me/push-token")
        XCTAssertEqual(requests[1].authorization, "Bearer [REDACTED]")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[1].body)) as? [String: String])
        XCTAssertEqual(body, ["pushToken": token.pushToken, "pushEnvironment": "SANDBOX", "bundleId": "example.test"])
        XCTAssertEqual(requests[2].path, "/api/v2/notifications/notification-1")
        XCTAssertEqual(requests[2].authorization, "Bearer [REDACTED]")
        do {
            _ = try await client.notificationRoute(messageID: "../me")
            XCTFail("Untrusted notification IDs must not change the REST route")
        } catch { XCTAssertEqual(error as? APIClientError, .invalidResponse) }
        let finalRequests = await transport.recordedRequests()
        XCTAssertEqual(finalRequests.count, 3)
    }

    func testNearbyVolunteerRequestReturnsOnlyAggregateRanges() async throws {
        let timestamp = ISO8601DateFormatter().string(from: now)
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: #"{"generatedAt":"\#(timestamp)","ranges":[{"radiusMeters":1000,"count":3},{"radiusMeters":1500,"count":5},{"radiusMeters":2000,"count":8}]}"#)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let summary = try await client.fetchNearbyVolunteerSummary()
        XCTAssertEqual(summary.ranges.map(\.count), [3, 5, 8])
        XCTAssertEqual(summary.generatedAt, now)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.last?.path, "/api/v2/me/nearby-volunteers")
        XCTAssertEqual(requests.last?.authorization, "Bearer [REDACTED]")
    }

    func testBootstrapRequiresAccountBearerBeforeAnyNetworkRequest() async throws {
        let fixedNow = now
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: fixedNow.addingTimeInterval(3_600))
        ])
        let client = APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { fixedNow }
        )

        do {
            _ = try await client.bootstrapSession(request: bootstrapRequest)
            XCTFail("没有账号会话时不得发送设备 bootstrap")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .missingAccountToken)
        }
        let requests = await transport.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testExpiringSessionBootstrapsBeforeAuthenticatedRequest() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "token-1", expiresAt: now.addingTimeInterval(20)),
            .bootstrap(token: "token-2", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: #"{"events":[]}"#)
        ])
        let client = try makeClient(transport: transport)

        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let events = try await client.listEvents()
        XCTAssertEqual(events, [])

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/session/bootstrap",
            "/api/v2/session/bootstrap",
            "/api/v2/events"
        ])
        XCTAssertEqual(requests[0].authorization, "Bearer [REDACTED]")
        XCTAssertEqual(requests[1].authorization, "Bearer [REDACTED]")
        XCTAssertEqual(requests[2].authorization, "Bearer token-2")
    }

    func testUnauthorizedRequestRotatesAndRetriesOnlyOnce() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "token-1", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 401, body: ""),
            .bootstrap(token: "token-2", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 401, body: "")
        ])
        let client = try makeClient(transport: transport)

        _ = try await client.bootstrapSession(request: bootstrapRequest)
        do {
            _ = try await client.listEvents()
            XCTFail("第二次 401 不得再次自动轮换会话。")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .unexpectedStatus(401))
        }

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/session/bootstrap",
            "/api/v2/events",
            "/api/v2/session/bootstrap",
            "/api/v2/events"
        ])
        XCTAssertEqual(requests[0].authorization, "Bearer [REDACTED]")
        XCTAssertEqual(requests[1].authorization, "Bearer token-1")
        XCTAssertEqual(requests[2].authorization, "Bearer [REDACTED]")
        XCTAssertEqual(requests[3].authorization, "Bearer token-2")
    }

    func testV21PositionPresenceAndDecisionBodiesUseCanonicalRestContracts() async throws {
        let responderID = "REDACTED-SUPPLEMENT-ID-ef81f1a34651"
        let patientID = "REDACTED-SUPPLEMENT-ID-f82b864fbf15"
        let presenceID = "REDACTED-SUPPLEMENT-ID-171b48e5cbf1"
        let formatter = ISO8601DateFormatter()
        let observedAt = formatter.string(from: now)
        let result: (String) -> ScriptedTransport.Response = { id in
            .json(
                statusCode: 200,
                body: #"{"positionUpdateId":"\#(id)","applied":true,"idempotent":false,"ignoredAsStale":false,"positionObservedAt":"\#(observedAt)","serverReceivedAt":"\#(observedAt)"}"#
            )
        }
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "token-1", expiresAt: now.addingTimeInterval(3_600)),
            result(responderID),
            result(patientID),
            .json(
                statusCode: 200,
                body: #"{"deviceInstanceId":"REDACTED-SUPPLEMENT-ID-c11b2d3983cc","deviceKind":"IPHONE","lastSeenAt":"\#(observedAt)","lastPresenceUpdateId":"\#(presenceID)","lastPresenceOccurredAt":"\#(observedAt)","availableForResponse":true,"capabilities":{"notificationAuthorized":true,"locationAuthorized":true},"position":null,"freshness":"UNAVAILABLE","currentEventId":null,"currentAssignmentId":null}"#
            ),
            .json(statusCode: 200, body: #"{"decision":"ACCEPT","assignment":null}"#)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        _ = try await client.updateResponderPosition(
            ResponderPositionUpdate(
                positionUpdateId: responderID,
                responderPosition: try ResponderPosition(
                    latitude: 22.198,
                    longitude: 113.543,
                    accuracyMeters: 10
                ),
                observedAt: now
            )
        )
        _ = try await client.updatePatientPosition(
            eventID: "REDACTED-SUPPLEMENT-ID-627f58e32cfe",
            update: PatientPositionUpdate(
                positionUpdateId: patientID,
                patientPosition: try PatientPosition(
                    latitude: 22.1987,
                    longitude: 113.5439,
                    accuracyMeters: 12
                ),
                observedAt: now
            )
        )
        let presence = try await client.updatePresence(
            DevicePresenceUpdate(
                presenceUpdateId: presenceID,
                occurredAt: now,
                availableForResponse: true,
                capabilities: DeviceCapabilities(
                    notificationAuthorized: true,
                    locationAuthorized: true
                )
            )
        )
        XCTAssertEqual(presence.lastPresenceUpdateId, presenceID)
        XCTAssertEqual(presence.lastPresenceOccurredAt, now)
        _ = try await client.respond(
            eventID: "REDACTED-SUPPLEMENT-ID-627f58e32cfe",
            deliveryID: "REDACTED-SUPPLEMENT-ID-4b1fb881ade3",
            accept: true,
            decidedAt: now
        )

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.dropFirst().map(\.path), [
            "/api/v2/me/responder-position",
            "/api/v2/events/REDACTED-SUPPLEMENT-ID-627f58e32cfe/patient-position",
            "/api/v2/me/presence",
            "/api/v2/events/REDACTED-SUPPLEMENT-ID-627f58e32cfe/responses/REDACTED-SUPPLEMENT-ID-4b1fb881ade3"
        ])
        let responderBody = try XCTUnwrap(requests[1].jsonBody)
        XCTAssertEqual(responderBody["positionUpdateId"] as? String, responderID)
        XCTAssertEqual((responderBody["responderPosition"] as? [String: Any])?["kind"] as? String, "R")
        XCTAssertEqual((responderBody["responderPosition"] as? [String: Any])?["accuracyMeters"] as? Double, 10)
        let patientBody = try XCTUnwrap(requests[2].jsonBody)
        XCTAssertEqual(patientBody["positionUpdateId"] as? String, patientID)
        XCTAssertEqual((patientBody["patientPosition"] as? [String: Any])?["kind"] as? String, "P")
        let presenceBody = try XCTUnwrap(requests[3].jsonBody)
        XCTAssertEqual(presenceBody["presenceUpdateId"] as? String, presenceID)
        XCTAssertEqual(presenceBody["availableForResponse"] as? Bool, true)
        let decisionBody = try XCTUnwrap(requests[4].jsonBody)
        XCTAssertEqual(decisionBody["decision"] as? String, "ACCEPT")
        XCTAssertNil(decisionBody["responderPosition"])
    }

    func testStableEndRequestsUseExistingPatientAndResponderContracts() async throws {
        let eventID = "REDACTED-SUPPLEMENT-ID-627f58e32cfe"
        let timestamp = ISO8601DateFormatter().string(from: now)
        let terminal = #"{"id":"\#(eventID)","state":"RESOLVED","recruitmentState":"COMPLETED","canPublishEventPosition":false,"viewerRelationship":"NEUTRAL","createdAt":"\#(timestamp)","resolvedAt":"\#(timestamp)","eventPositionParticipationStartedAt":null,"eventPositionParticipationEndedAt":null}"#
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: terminal), .json(statusCode: 200, body: terminal),
            .json(statusCode: 200, body: terminal)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let commands = [
            EventEndRequest(resolutionId: "end-one", actor: .patient, reason: .falseAlarm, endedAt: now),
            EventEndRequest(resolutionId: "end-two", actor: .patient, reason: .problemResolved, endedAt: now),
            EventEndRequest(resolutionId: "end-three", actor: .onSceneResponder, reason: .professionalTakeover, endedAt: now)
        ]
        for command in commands { _ = try await client.submitEnd(eventID: eventID, request: command) }
        let sent = Array(await transport.recordedRequests().dropFirst())
        XCTAssertEqual(sent.map(\.path), ["/api/v2/events/\(eventID)/end", "/api/v2/events/\(eventID)/end", "/api/v2/events/\(eventID)/resolve"])
        for (index, request) in sent.enumerated() {
            XCTAssertEqual(request.authorization, "Bearer [REDACTED]")
            let body = try XCTUnwrap(request.jsonBody)
            XCTAssertEqual(body["resolutionId"] as? String, commands[index].resolutionId)
            XCTAssertEqual(body["reason"] as? String, commands[index].reason.rawValue)
            XCTAssertEqual(Set(body.keys), index == 2
                ? Set(["resolutionId", "actor", "reason", "resolvedAt"])
                : Set(["resolutionId", "reason", "endedAt"]))
            if index == 2 { XCTAssertEqual(body["actor"] as? String, "ON_SCENE_RESPONDER") }
        }
    }

    @MainActor
    func testLatestPositionUploadCoordinatorRetriesTheSameRequestIdentity() async throws {
        let positionID = "REDACTED-SUPPLEMENT-ID-3ed2dcca9eb2"
        let observedAt = now
        let timestamp = ISO8601DateFormatter().string(from: observedAt)
        let success = "{\"positionUpdateId\":\"\(positionID)\",\"applied\":true,\"idempotent\":false,\"ignoredAsStale\":false,\"positionObservedAt\":\"\(timestamp)\",\"serverReceivedAt\":\"\(timestamp)\"}"
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 503, body: ""),
            .json(statusCode: 200, body: success)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)

        let coordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: observedAt
        )
        var acknowledgements = 0
        var errors = 0
        let coordinator = LatestPositionUploadCoordinator(
            makeID: { positionID },
            apiClient: { client },
            isCurrent: { sessionGeneration, modeGeneration, mode in
                sessionGeneration == 4
                    && modeGeneration == 2
                    && mode == .responder
            },
            currentTier: { .standby },
            now: { observedAt.addingTimeInterval(1) },
            onAck: { _, _, _ in acknowledgements += 1 },
            onError: { _, _ in errors += 1 },
            onAuthoritativeConflict: { _ in }
        )
        coordinator.enqueue(
            coordinate,
            mode: .responder,
            sessionGeneration: 4,
            modeGeneration: 2
        )

        for _ in 0..<400 {
            if acknowledgements == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(acknowledgements, 1)
        XCTAssertEqual(errors, 1)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/session/bootstrap",
            "/api/v2/me/responder-position",
            "/api/v2/me/responder-position"
        ])
        let firstBody = try XCTUnwrap(requests[1].jsonBody)
        let secondBody = try XCTUnwrap(requests[2].jsonBody)
        XCTAssertEqual(firstBody["positionUpdateId"] as? String, positionID)
        XCTAssertEqual(secondBody["positionUpdateId"] as? String, positionID)
        XCTAssertEqual(firstBody["observedAt"] as? String, secondBody["observedAt"] as? String)
    }

    @MainActor
    func testLatestPositionUploadCoordinatorKeepsSampleAfterMismatchedAck() async throws {
        let positionID = "REDACTED-SUPPLEMENT-ID-236a212331ce"
        let wrongID = "REDACTED-SUPPLEMENT-ID-8e0a5e373fc8"
        let observedAt = now
        let timestamp = ISO8601DateFormatter().string(from: observedAt)
        func response(_ id: String) -> String {
            "{\"positionUpdateId\":\"\(id)\",\"applied\":true,\"idempotent\":false,\"ignoredAsStale\":false,\"positionObservedAt\":\"\(timestamp)\",\"serverReceivedAt\":\"\(timestamp)\"}"
        }
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: response(wrongID)),
            .json(statusCode: 200, body: response(positionID))
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)

        let coordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: observedAt
        )
        var acknowledgements = 0
        var errors = 0
        let coordinator = LatestPositionUploadCoordinator(
            makeID: { positionID },
            apiClient: { client },
            isCurrent: { sessionGeneration, modeGeneration, mode in
                sessionGeneration == 5
                    && modeGeneration == 2
                    && mode == .responder
            },
            currentTier: { .standby },
            now: { observedAt.addingTimeInterval(1) },
            onAck: { _, _, _ in acknowledgements += 1 },
            onError: { _, _ in errors += 1 },
            onAuthoritativeConflict: { _ in }
        )
        coordinator.enqueue(
            coordinate,
            mode: .responder,
            sessionGeneration: 5,
            modeGeneration: 2
        )

        for _ in 0..<400 {
            if acknowledgements == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(acknowledgements, 1)
        XCTAssertEqual(errors, 1)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.filter { $0.path == "/api/v2/me/responder-position" }.count, 2)
        XCTAssertEqual(requests[1].jsonBody?["positionUpdateId"] as? String, positionID)
        XCTAssertEqual(requests[2].jsonBody?["positionUpdateId"] as? String, positionID)
    }

    @MainActor
    func testPresenceUploadCoordinatorKeepsIDAcrossRetryAndSuppressesSameSignature() async throws {
        let firstID = "REDACTED-SUPPLEMENT-ID-7cbee8cabd48"
        let secondID = "REDACTED-SUPPLEMENT-ID-f5db5253e16c"
        let timestamp = ISO8601DateFormatter().string(from: now)
        func presenceResponse(_ id: String) -> ScriptedTransport.Response {
            .json(
                statusCode: 200,
                body: #"{"deviceInstanceId":"REDACTED-SUPPLEMENT-ID-c11b2d3983cc","deviceKind":"IPHONE","lastSeenAt":"\#(timestamp)","lastPresenceUpdateId":"\#(id)","lastPresenceOccurredAt":"\#(timestamp)","availableForResponse":true,"capabilities":{"notificationAuthorized":true,"locationAuthorized":true},"position":null,"freshness":"UNAVAILABLE","currentEventId":null,"currentAssignmentId":null}"#
            )
        }
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 503, body: ""),
            presenceResponse(firstID),
            presenceResponse(secondID)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)

        var generatedIDs = [firstID, secondID]
        var acknowledgements: [String] = []
        var errors = 0
        let coordinator = PresenceUploadCoordinator(
            makeID: { generatedIDs.removeFirst() },
            apiClient: { client },
            isCurrent: { sessionGeneration in sessionGeneration == 11 },
            onAck: { _, upload in acknowledgements.append(upload.update.presenceUpdateId) },
            onError: { _ in errors += 1 }
        )
        let signature = PresenceUploadCoordinator.Signature(
            availableForResponse: true,
            capabilities: DeviceCapabilities(
                notificationAuthorized: true,
                locationAuthorized: true
            )
        )

        coordinator.enqueue(
            signature: signature,
            force: false,
            sessionGeneration: 11,
            occurredAt: now
        )
        for _ in 0..<500 {
            if acknowledgements.count == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(acknowledgements, [firstID])
        XCTAssertEqual(errors, 1)

        coordinator.enqueue(
            signature: signature,
            force: false,
            sessionGeneration: 11,
            occurredAt: now.addingTimeInterval(1)
        )
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(acknowledgements, [firstID], "相同 signature 不得重复发送 Presence")

        coordinator.enqueue(
            signature: signature,
            force: true,
            sessionGeneration: 11,
            occurredAt: now.addingTimeInterval(2)
        )
        for _ in 0..<200 {
            if acknowledgements.count == 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(acknowledgements, [firstID, secondID])

        let requests = await transport.recordedRequests()
            .filter { $0.path == "/api/v2/me/presence" }
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(
            requests.map { $0.jsonBody?["presenceUpdateId"] as? String },
            [firstID, firstID, secondID]
        )
        XCTAssertEqual(
            requests[0].jsonBody?["occurredAt"] as? String,
            requests[1].jsonBody?["occurredAt"] as? String
        )
    }

    @MainActor
    func testPresenceUploadCoordinatorSuppressesLateAckAfterReset() async throws {
        let presenceID = "REDACTED-SUPPLEMENT-ID-2a39b1e45383"
        let timestamp = ISO8601DateFormatter().string(from: now)
        let body = #"{"deviceInstanceId":"REDACTED-SUPPLEMENT-ID-c11b2d3983cc","deviceKind":"IPHONE","lastSeenAt":"\#(timestamp)","lastPresenceUpdateId":"\#(presenceID)","lastPresenceOccurredAt":"\#(timestamp)","availableForResponse":true,"capabilities":{"notificationAuthorized":true,"locationAuthorized":true},"position":null,"freshness":"UNAVAILABLE","currentEventId":null,"currentAssignmentId":null}"#
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: body)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        await transport.suspendNextResponseUntilResumed()

        var acknowledgements = 0
        var errors = 0
        let coordinator = PresenceUploadCoordinator(
            makeID: { presenceID },
            apiClient: { client },
            isCurrent: { _ in true },
            onAck: { _, _ in acknowledgements += 1 },
            onError: { _ in errors += 1 }
        )
        let signature = PresenceUploadCoordinator.Signature(
            availableForResponse: true,
            capabilities: DeviceCapabilities(
                notificationAuthorized: true,
                locationAuthorized: true
            )
        )
        coordinator.enqueue(
            signature: signature,
            force: false,
            sessionGeneration: 12,
            occurredAt: now
        )
        for _ in 0..<200 {
            if await transport.isResponseSuspended() { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let suspended = await transport.isResponseSuspended()
        XCTAssertTrue(suspended)

        coordinator.reset(resetLastSignature: false)
        await transport.resumeSuspendedResponse()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(acknowledgements, 0, "reset 后迟到 ACK 不得写入 Presence 投影")
        XCTAssertEqual(errors, 0, "reset 后迟到结果不得污染新会话错误")
    }

    @MainActor
    func testNearbyVolunteerSummaryCoordinatorSuppressesStaleQueryAndAcceptsFreshAggregate() async throws {
        let timestamp = ISO8601DateFormatter().string(from: now)
        let body = #"{"generatedAt":"\#(timestamp)","ranges":[{"radiusMeters":1000,"count":3},{"radiusMeters":1500,"count":5},{"radiusMeters":2000,"count":8}]}"#
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: body),
            .json(statusCode: 200, body: body)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        await transport.suspendNextResponseUntilResumed()

        var summaries: [NearbyVolunteerSummary?] = []
        var refreshReturned = false
        let fixedNow = now
        let coordinator = NearbyVolunteerSummaryCoordinator(
            apiClient: { client },
            isCurrent: { sessionGeneration in sessionGeneration == 31 },
            now: { fixedNow },
            onSummary: { summaries.append($0) }
        )
        let firstRefresh = Task { @MainActor in
            await coordinator.refresh(sessionGeneration: 31)
            refreshReturned = true
        }
        for _ in 0..<200 {
            if await transport.isResponseSuspended() { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let suspended = await transport.isResponseSuspended()
        XCTAssertTrue(suspended)
        XCTAssertFalse(refreshReturned, "HTTP 尚未返回时 refresh 不得提前完成")

        coordinator.clear()
        await transport.resumeSuspendedResponse()
        await firstRefresh.value
        XCTAssertTrue(refreshReturned)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(summaries.compactMap { $0 }.isEmpty, "清理后旧摘要响应不得回写")

        await coordinator.refresh(sessionGeneration: 31)
        for _ in 0..<200 {
            if summaries.compactMap({ $0 }).count == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let accepted = try XCTUnwrap(summaries.compactMap { $0 }.last)
        XCTAssertEqual(accepted.ranges.map(\.count), [3, 5, 8])
        let requests = await transport.recordedRequests()
            .filter { $0.path == "/api/v2/me/nearby-volunteers" }
        XCTAssertEqual(requests.count, 2)
    }

    @MainActor
    func testNearbySummaryRefreshKeepsCurrentMapUntilReplacementArrives() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            nearbySummaryResponse(counts: [3, 5, 8]),
            nearbySummaryResponse(counts: [4, 6, 9])
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let fixedNow = now
        var summaries: [NearbyVolunteerSummary?] = []
        let coordinator = NearbyVolunteerSummaryCoordinator(
            apiClient: { client }, isCurrent: { $0 == 31 }, now: { fixedNow },
            onSummary: { summaries.append($0) }
        )
        await coordinator.refresh(sessionGeneration: 31)
        let initial = try XCTUnwrap(summaries.last ?? nil)
        let changesBeforeRefresh = summaries.count
        await transport.suspendNextResponseUntilResumed()
        let refresh = Task { await coordinator.refresh(sessionGeneration: 31) }
        try await waitForTransportSuspension(transport)

        XCTAssertEqual(summaries.count, changesBeforeRefresh, "刷新在途不应清空有效地图摘要")
        XCTAssertEqual(summaries.last ?? nil, initial)
        await transport.resumeSuspendedResponse()
        await refresh.value
        XCTAssertEqual((summaries.last ?? nil)?.ranges.map(\.count), [4, 6, 9])
        XCTAssertFalse(summaries.dropFirst(changesBeforeRefresh).contains { $0 == nil })
    }

    @MainActor
    func testNearbySummaryCallerCancellationKeepsCacheAndSuppressesLateResult() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            nearbySummaryResponse(counts: [3, 5, 8]),
            nearbySummaryResponse(counts: [4, 6, 9]),
            nearbySummaryResponse(counts: [5, 7, 10])
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let fixedNow = now
        var summaries: [NearbyVolunteerSummary?] = []
        let coordinator = NearbyVolunteerSummaryCoordinator(
            apiClient: { client }, isCurrent: { $0 == 31 }, now: { fixedNow },
            onSummary: { summaries.append($0) }
        )
        await coordinator.refresh(sessionGeneration: 31)
        let initial = try XCTUnwrap(summaries.last ?? nil)
        let changesBeforeRefresh = summaries.count
        await transport.suspendNextResponseUntilResumed()
        let refresh = Task { await coordinator.refresh(sessionGeneration: 31) }
        try await waitForTransportSuspension(transport)
        refresh.cancel()
        XCTAssertEqual(summaries.last ?? nil, initial, "离页取消查询应保留有效缓存")
        await coordinator.refresh(sessionGeneration: 31)
        await transport.resumeSuspendedResponse()
        await refresh.value

        XCTAssertEqual((summaries.last ?? nil)?.ranges.map(\.count), [5, 7, 10],
                       "旧查询的取消回调和迟到结果不能清空或替换新查询摘要")
        XCTAssertFalse(summaries.dropFirst(changesBeforeRefresh).contains { $0 == nil })
        XCTAssertFalse(summaries.compactMap { $0 }.contains { $0.ranges.map(\.count) == [4, 6, 9] })
    }

    @MainActor
    func testNearbySummaryFailurePreservesOnlyUnexpiredCache() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            nearbySummaryResponse(counts: [3, 5, 8]),
            .json(statusCode: 503, body: ""),
            .json(statusCode: 503, body: "")
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        var currentTime = now
        var summary: NearbyVolunteerSummary?
        let coordinator = NearbyVolunteerSummaryCoordinator(
            apiClient: { client }, isCurrent: { $0 == 31 }, now: { currentTime },
            onSummary: { summary = $0 }
        )
        await coordinator.refresh(sessionGeneration: 31)
        let initial = try XCTUnwrap(summary)
        currentTime = now.addingTimeInterval(120)
        await coordinator.refresh(sessionGeneration: 31)
        XCTAssertEqual(summary, initial, "120 秒内查询失败仍可展示原来的有效摘要")
        currentTime = now.addingTimeInterval(121)
        await coordinator.refresh(sessionGeneration: 31)
        XCTAssertNil(summary, "过期摘要不得在查询失败后继续展示或被替换成假零人")
    }

    @MainActor
    func testNearbySummaryExpirationDuringCancelledRefreshClearsCache() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            nearbySummaryResponse(counts: [3, 5, 8]),
            nearbySummaryResponse(counts: [4, 6, 9])
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        var currentTime = now
        var summary: NearbyVolunteerSummary?
        let coordinator = NearbyVolunteerSummaryCoordinator(
            apiClient: { client }, isCurrent: { $0 == 31 }, now: { currentTime },
            onSummary: { summary = $0 }
        )
        await coordinator.refresh(sessionGeneration: 31)
        XCTAssertNotNil(summary)
        await transport.suspendNextResponseUntilResumed()
        let refresh = Task { await coordinator.refresh(sessionGeneration: 31) }
        try await waitForTransportSuspension(transport)
        currentTime = now.addingTimeInterval(121)
        refresh.cancel()
        await transport.resumeSuspendedResponse()
        await refresh.value
        try await waitForMainActorCondition { summary == nil }
        XCTAssertNil(summary, "取消查询只能保留未过期的缓存")
    }

    @MainActor
    func testNearbySummarySessionChangeAndPermissionLossDiscardCachedProjection() async throws {
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            nearbySummaryResponse(counts: [3, 5, 8]),
            nearbySummaryResponse(counts: [4, 6, 9]),
            nearbySummaryResponse(counts: [5, 7, 10])
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        let fixedNow = now
        var sessionGeneration = 31
        var allowed = true
        var summary: NearbyVolunteerSummary?
        let coordinator = NearbyVolunteerSummaryCoordinator(
            apiClient: { client },
            isCurrent: { allowed && $0 == sessionGeneration }, now: { fixedNow },
            onSummary: { summary = $0 }
        )
        await coordinator.refresh(sessionGeneration: 31)
        XCTAssertNotNil(summary)
        sessionGeneration = 32
        await transport.suspendNextResponseUntilResumed()
        let newSessionRefresh = Task { await coordinator.refresh(sessionGeneration: 32) }
        try await waitForTransportSuspension(transport)
        XCTAssertNil(summary, "不能在新会话加载期间显示旧会话缓存")
        await transport.resumeSuspendedResponse()
        await newSessionRefresh.value
        XCTAssertEqual(summary?.ranges.map(\.count), [4, 6, 9])

        await transport.suspendNextResponseUntilResumed()
        let revokedRefresh = Task { await coordinator.refresh(sessionGeneration: 32) }
        try await waitForTransportSuspension(transport)
        allowed = false
        await transport.resumeSuspendedResponse()
        await revokedRefresh.value
        XCTAssertNil(summary, "业务权限变化后既不能保留旧摘要，也不能接收在途结果")
    }

    private func nearbySummaryResponse(counts: [Int]) -> ScriptedTransport.Response {
        let timestamp = ISO8601DateFormatter().string(from: now)
        let ranges = zip([1_000, 1_500, 2_000], counts).map { radius, count in
            #"{"radiusMeters":\#(radius),"count":\#(count)}"#
        }.joined(separator: ",")
        return .json(statusCode: 200, body: #"{"generatedAt":"\#(timestamp)","ranges":[\#(ranges)]}"#)
    }

    @MainActor
    func testEventPositionSchedulerClosesElapsedUtcSlotsAndStopsOnContextLease() async throws {
        let base = Date(timeIntervalSince1970: 1_788_000_000)
        var currentTime = base.addingTimeInterval(3)
        var capturedSlots: [Date] = []
        let context = EventPositionSchedulerCoordinator.Context(
            key: "event-scheduler",
            generation: 7,
            startedAt: base,
            lastFinalizedSlotAt: nil
        )
        let coordinator = EventPositionSchedulerCoordinator(
            now: { currentTime },
            isCurrent: { candidate in
                candidate == context && capturedSlots.count < 4
            },
            capture: { capturedSlots.append($0) },
            sleep: { _ in
                currentTime = currentTime.addingTimeInterval(1)
            }
        )

        coordinator.start(context: context)
        for _ in 0..<200 {
            if capturedSlots.count == 4 { break }
            await Task.yield()
        }
        XCTAssertEqual(capturedSlots, [
            base,
            base.addingTimeInterval(1),
            base.addingTimeInterval(2),
            base.addingTimeInterval(3)
        ])
        for _ in 0..<200 {
            if !coordinator.isRunning { break }
            await Task.yield()
        }
        XCTAssertFalse(coordinator.isRunning, "context lease 失效后 scheduler 应自行停止")
        XCTAssertEqual(capturedSlots.count, 4)
        coordinator.stop()
        XCTAssertFalse(coordinator.isRunning)
        XCTAssertNil(coordinator.activeContext)
    }

    @MainActor
    func testEventPositionRecoverySchedulerWaitsGraceAndStopsAfterPendingClears() async throws {
        let context = EventPositionRecoverySchedulerCoordinator.Context(
            key: "event-recovery-scheduler",
            generation: 9
        )
        var pending = true
        var advances = 0
        var sleepCalls = 0
        let coordinator = EventPositionRecoverySchedulerCoordinator(
            isCurrent: { $0 == context },
            isPending: { pending },
            advance: {
                advances += 1
                if advances == 3 { pending = false }
                return true
            },
            sleep: { duration in
                XCTAssertEqual(duration, .seconds(5))
                XCTAssertEqual(advances, 0, "grace 等待完成前不得推进恢复 slot")
                sleepCalls += 1
            }
        )

        coordinator.start(context: context)
        for _ in 0..<200 {
            if !coordinator.isRunning { break }
            await Task.yield()
        }
        XCTAssertEqual(sleepCalls, 1, "恢复 scheduler 必须先等待一次 5 秒 grace")
        XCTAssertEqual(advances, 3)
        XCTAssertFalse(coordinator.isRunning)
        XCTAssertNil(coordinator.activeContext)
    }

    @MainActor
    func testEventPositionBatchUploadCoordinatorRetriesSameImmutableBatchOnce() async throws {
        let pending = try makeEventPositionUploadBatch()
        let formatter = ISO8601DateFormatter()
        let timestamp = formatter.string(from: now)
        let recordID = pending.batch.records[0].recordId
        let ackBody = """
        {"schemaVersion":"2.0","eventId":"\(pending.eventId)","batchId":"\(pending.batch.batchId)","acceptedRecordCount":1,"idempotent":false,"acknowledgedAt":"\(timestamp)","records":[{"recordId":"\(recordID)","persisted":true,"appliedToLatest":false,"ignoredAsStale":false,"serverReceivedAt":"\(timestamp)"}]}
        """
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 503, body: ""),
            .json(statusCode: 200, body: ackBody)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)

        var acknowledgements = 0
        var drainCalls = 0
        var retryDelays: [Duration] = []
        var permanentFailureCalls = 0
        var reportedErrors: [Error] = []
        var sleepCalls = 0
        // The injected sleep is a release gate: the retry cannot reach the
        // transport until this test allows it.  A sleep that returns immediately
        // lets the retry finish before the observation below, which is how this
        // test previously raced its own assertions.
        var retryReleased = false
        let coordinator = EventPositionBatchUploadCoordinator(
            apiClient: { client },
            isCurrent: { _, generation in generation == 4 },
            onAck: { batch, ack in
                XCTAssertEqual(batch.batch.batchId, pending.batch.batchId)
                XCTAssertTrue(ack.validates(request: batch.batch))
                acknowledgements += 1
                return true
            },
            onPermanentFailure: { _, _ in
                permanentFailureCalls += 1
                return false
            },
            onError: { error in
                reportedErrors.append(error)
            },
            onDrain: {
                drainCalls += 1
            },
            sleep: { duration in
                retryDelays.append(duration)
                sleepCalls += 1
                while !retryReleased {
                    try await Task.sleep(for: .milliseconds(20))
                }
            }
        )

        coordinator.start(batch: pending, connectionGeneration: 4)
        // A duplicate drive request for the same batch must be ignored rather
        // than opening a second parallel write; the transport can only attest
        // that once it has seen the first attempt.
        coordinator.start(batch: pending, connectionGeneration: 4)
        // The first attempt fails with a retryable 503 and enters its backoff.
        // A 503 is a transient server failure: the batch must be retried and must
        // never be treated as permanently rejected evidence.
        try await waitForMainActorCondition { sleepCalls == 1 }
        XCTAssertTrue(coordinator.isRunning, "退避期间协调器仍须占用该批次")
        XCTAssertEqual(permanentFailureCalls, 0, "503 不得进入永久隔离")
        coordinator.start(batch: pending, connectionGeneration: 4)

        // Release the backoff and let the retry task fully finish, so the batch is
        // free again before the next drive request.
        retryReleased = true
        try await waitForMainActorCondition { !coordinator.isRunning }
        XCTAssertEqual(drainCalls, 1, "退避到期只触发一次 drain")
        XCTAssertEqual(sleepCalls, 1, "临时失败只能产生一次退避")
        XCTAssertEqual(acknowledgements, 0)

        // Driving the queue again re-sends the same immutable batch exactly once.
        coordinator.start(batch: pending, connectionGeneration: 4)
        try await waitForMainActorCondition { acknowledgements == 1 && !coordinator.isRunning }
        XCTAssertEqual(acknowledgements, 1)
        XCTAssertEqual(retryDelays, [.seconds(1)])
        XCTAssertEqual(reportedErrors.count, 1)
        XCTAssertEqual(reportedErrors.first as? APIClientError, .unexpectedStatus(503))
        XCTAssertEqual(drainCalls, 2, "临时失败重试和 ACK 后各只触发一次 drain")
        let requests = await transport.recordedRequests()
            .filter { $0.path.contains("/position-batches/") }
        XCTAssertEqual(requests.count, 2, "重复 start 不得产生第二条并行请求")
        XCTAssertEqual(requests.map { $0.jsonBody?["batchId"] as? String }, [pending.batch.batchId, pending.batch.batchId])
    }

    /// Main-actor-safe bounded wait.  `Task.yield()` alone cannot order a
    /// `@MainActor` child task against the test's own continuation, so this
    /// suspends instead of spinning the executor.  The interval is deliberately
    /// coarse: a gated child task needs a real window on the main actor, and a
    /// 2 ms poll starves it when the whole suite is running.
    @MainActor
    private func waitForMainActorCondition(
        _ condition: @MainActor () -> Bool,
        iterations: Int = 400
    ) async throws {
        for _ in 0..<iterations {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("等待协调器状态超时。")
    }

    @MainActor
    func testEventPositionBatchUploadCoordinatorResetSuppressesLateAck() async throws {
        let pending = try makeEventPositionUploadBatch()
        let formatter = ISO8601DateFormatter()
        let timestamp = formatter.string(from: now)
        let recordID = pending.batch.records[0].recordId
        let ackBody = """
        {"schemaVersion":"2.0","eventId":"\(pending.eventId)","batchId":"\(pending.batch.batchId)","acceptedRecordCount":1,"idempotent":false,"acknowledgedAt":"\(timestamp)","records":[{"recordId":"\(recordID)","persisted":true,"appliedToLatest":false,"ignoredAsStale":false,"serverReceivedAt":"\(timestamp)"}]}
        """
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: ackBody)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        await transport.suspendNextResponseUntilResumed()

        var acknowledgements = 0
        var drainCalls = 0
        let coordinator = EventPositionBatchUploadCoordinator(
            apiClient: { client },
            isCurrent: { _, _ in true },
            onAck: { _, _ in acknowledgements += 1; return true },
            onPermanentFailure: { _, _ in XCTFail("挂起请求不应进入永久隔离"); return false },
            onError: { _ in XCTFail("reset 后不应报告旧请求错误") },
            onDrain: { drainCalls += 1 },
            sleep: { _ in }
        )
        coordinator.start(batch: pending, connectionGeneration: 4)
        try await waitForTransportSuspension(transport)
        coordinator.reset()
        await transport.resumeSuspendedResponse()
        try await waitForMainActorCondition { !coordinator.isRunning }
        XCTAssertEqual(acknowledgements, 0, "reset 后不得提交旧批次的 ACK")
        XCTAssertEqual(drainCalls, 0, "reset 后不得继续 drain")
    }

    /// Waits until the scripted transport is holding a response.  The child
    /// upload task and this test both run on the main actor, so a `Task.yield()`
    /// spin cannot order them under load; an explicit suspension can.
    @MainActor
    private func waitForTransportSuspension(
        _ transport: ScriptedTransport,
        iterations: Int = 400
    ) async throws {
        for _ in 0..<iterations {
            if await transport.isResponseSuspended() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("等待脚本传输挂起超时。")
    }

    @MainActor
    func testEventPositionRecoveryAndBatchUploadInterleaveKeepsBothQueueFacts() async throws {
        let original = try makeEventPositionUploadBatch()
        let recovered = try makeEventPositionUploadBatch(
            recordID: "REDACTED-SUPPLEMENT-ID-c6cebafe9817",
            eventID: "REDACTED-SUPPLEMENT-ID-daadba9258ab",
            batchID: "REDACTED-SUPPLEMENT-ID-76f968881808",
            slotAt: now.addingTimeInterval(1)
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("aedresponse-interleave-\(UUID().uuidString)", isDirectory: true)
        let queueURL = directory.appendingPathComponent("queue.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = ProtectedEventPositionQueueStore(fileURL: queueURL)
        try queue.save(EventPositionQueueState(pendingBatches: [original]))

        let formatter = ISO8601DateFormatter()
        let timestamp = formatter.string(from: now)
        let recordID = original.batch.records[0].recordId
        let ackBody = """
        {"schemaVersion":"2.0","eventId":"\(original.eventId)","batchId":"\(original.batch.batchId)","acceptedRecordCount":1,"idempotent":false,"acknowledgedAt":"\(timestamp)","records":[{"recordId":"\(recordID)","persisted":true,"appliedToLatest":false,"ignoredAsStale":false,"serverReceivedAt":"\(timestamp)"}]}
        """
        let transport = ScriptedTransport(responses: [
            .bootstrap(token: "device-token", expiresAt: now.addingTimeInterval(3_600)),
            .json(statusCode: 200, body: ackBody)
        ])
        let client = try makeClient(transport: transport)
        _ = try await client.bootstrapSession(request: bootstrapRequest)
        await transport.suspendNextResponseUntilResumed()

        var uploadAcked = false
        let upload = EventPositionBatchUploadCoordinator(
            apiClient: { client },
            isCurrent: { _, _ in true },
            onAck: { batch, ack in
                guard ack.validates(request: batch.batch) else { return false }
                do {
                    var state = try queue.load()
                    state.pendingBatches.removeAll { $0.batch.batchId == batch.batch.batchId }
                    try queue.save(state)
                    uploadAcked = true
                    return true
                } catch {
                    return false
                }
            },
            onPermanentFailure: { _, _ in false },
            onError: { _ in },
            onDrain: {},
            sleep: { _ in }
        )
        upload.start(batch: original, connectionGeneration: 1)
        for _ in 0..<200 {
            if await transport.isResponseSuspended() { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let suspended = await transport.isResponseSuspended()
        XCTAssertTrue(suspended)

        var recoveryPending = true
        var recoveryAdvances = 0
        let recovery = EventPositionRecoverySchedulerCoordinator(
            isCurrent: { _ in true },
            isPending: { recoveryPending },
            advance: {
                do {
                    var state = try queue.load()
                    state.pendingBatches.append(recovered)
                    try queue.save(state)
                    recoveryAdvances += 1
                    recoveryPending = false
                    return true
                } catch {
                    return false
                }
            },
            sleep: { duration in
                XCTAssertEqual(duration, .seconds(5))
            }
        )
        let recoveryContext = EventPositionRecoverySchedulerCoordinator.Context(
            key: "interleave-context", generation: 1
        )
        recovery.start(context: recoveryContext)
        for _ in 0..<200 {
            if !recovery.isRunning { break }
            await Task.yield()
        }
        XCTAssertEqual(recoveryAdvances, 1)
        XCTAssertFalse(recovery.isRunning)

        await transport.resumeSuspendedResponse()
        for _ in 0..<200 {
            if uploadAcked, !upload.isRunning { break }
            await Task.yield()
        }
        XCTAssertTrue(uploadAcked)
        XCTAssertFalse(upload.isRunning)
        let remaining = try queue.load().pendingBatches
        XCTAssertEqual(remaining.map(\.batch.batchId), [recovered.batch.batchId])
        let requests = await transport.recordedRequests()
            .filter { $0.path.contains("/position-batches/") }
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.jsonBody?["batchId"] as? String, original.batch.batchId)
    }

    @MainActor
    func testEventPositionQueuePersistenceCoordinatorFailsClosedAndPreservesCorruptFile() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("aedresponse-queue-coordinator-\(UUID().uuidString)", isDirectory: true)
        let queueURL = directory.appendingPathComponent("queue.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        let coordinator = EventPositionQueuePersistenceCoordinator(
            store: ProtectedEventPositionQueueStore(fileURL: queueURL)
        )

        XCTAssertEqual(coordinator.load(), EventPositionQueueState())
        XCTAssertTrue(coordinator.isLoaded)
        XCTAssertFalse(coordinator.isUnavailable)
        XCTAssertEqual(coordinator.save(EventPositionQueueState()), .persisted)
        try Data("corrupt".utf8).write(to: queueURL, options: .atomic)

        coordinator.reset()
        XCTAssertNil(coordinator.load())
        XCTAssertFalse(coordinator.isLoaded)
        XCTAssertTrue(coordinator.isUnavailable)
        XCTAssertTrue(coordinator.isBlocked)
        XCTAssertEqual(coordinator.save(EventPositionQueueState()), .failed,
                       "an unreadable queue must not be treated as a successful save")
        XCTAssertEqual(try Data(contentsOf: queueURL), Data("corrupt".utf8))

        coordinator.reset()
        coordinator.markBlocked()
        XCTAssertTrue(coordinator.isBlocked)
        XCTAssertEqual(coordinator.save(EventPositionQueueState()), .failed)
    }

    @MainActor
    func testConnectionRetryCoordinatorKeepsOneBackoffAndCancelsOldGeneration() async throws {
        var attempts = 0
        let coordinator = ConnectionRetryCoordinator { baseURL in
            XCTAssertEqual(baseURL, "https://example.test/api/v2/")
            attempts += 1
            return false
        }
        coordinator.begin(baseURL: "https://example.test/api/v2/")
        coordinator.scheduleIfNeeded()
        coordinator.scheduleIfNeeded()

        for _ in 0..<140 {
            if attempts == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(attempts, 1)
        XCTAssertTrue(coordinator.isScheduled)

        coordinator.begin(baseURL: "https://example.test/api/v2/")
        coordinator.scheduleIfNeeded()
        coordinator.cancel()
        try await Task.sleep(for: .milliseconds(1_100))
        XCTAssertEqual(attempts, 1)
        XCTAssertNil(coordinator.desiredBaseURL)
    }

    @MainActor
    func testRestoreCoordinatorMergesFollowUpAndCancelsOldGeneration() async throws {
        var reconciliations = 0
        var reconciliationInFlight = false
        let coordinator = RestoreCoordinator(
            isEligible: { true },
            reconcile: {
                reconciliations += 1
                reconciliationInFlight = true
                try? await Task.sleep(for: .milliseconds(40))
                reconciliationInFlight = false
                return false
            }
        )

        coordinator.schedule(immediate: true)
        for _ in 0..<100 {
            if reconciliationInFlight { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(reconciliationInFlight)
        coordinator.schedule(immediate: true)

        for _ in 0..<200 {
            if reconciliations >= 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(reconciliations, 2)

        coordinator.reset()
        try await Task.sleep(for: .milliseconds(1_100))
        XCTAssertEqual(reconciliations, 2, "reset 后旧退避不得再次执行恢复")

        var cancelledCalls = 0
        let cancelled = RestoreCoordinator(
            isEligible: { true },
            reconcile: {
                cancelledCalls += 1
                return true
            }
        )
        cancelled.schedule()
        cancelled.reset()
        try await Task.sleep(for: .milliseconds(1_100))
        XCTAssertEqual(cancelledCalls, 0)
    }

    func testEventProjectionReducerPreservesTerminalAndRevisionMonotonicity() {
        func event(
            id: String,
            state: EventState,
            revision: Int
        ) -> EmergencyEvent {
            EmergencyEvent(
                id: id,
                state: state,
                recruitmentState: state.isTerminal ? .completed : .recruiting,
                canPublishEventPosition: false,
                triggerSource: nil,
                fallDetectedAt: nil,
                fallResolution: nil,
                callFirstObservedAt: nil,
                patientPosition: nil,
                patientLocationCard: nil,
                viewerRelationship: .neutral,
                coordination: CoordinationSummary(
                    revision: revision,
                    nearbyCandidateCount: 0,
                    pendingOfferCount: 0,
                    acceptedResponderCount: 0,
                    goToPatientCount: 0,
                    fetchAedCount: 0,
                    enRouteCount: 0,
                    arrivedAtAedCount: 0,
                    arrivedAtPatientCount: 0,
                    aedAcquiredCount: 0,
                    completedAssignmentCount: 0
                ),
                createdAt: now,
                resolvedAt: state.isTerminal ? now : nil,
                pendingResponseRequest: nil,
                currentAssignment: nil
            )
        }

        let current = event(id: "event-projection", state: .active, revision: 2)
        let stale = event(id: "event-projection", state: .active, revision: 1)
        let newer = event(id: "event-projection", state: .active, revision: 3)
        let terminal = event(id: "event-projection", state: .resolved, revision: 1)

        let staleResult = EventProjectionReducer.merge(
            existing: [current],
            incoming: [stale],
            suppressedEventIDs: []
        )
        XCTAssertEqual(staleResult.first?.coordination?.revision, 2)

        let newerResult = EventProjectionReducer.merge(
            existing: [current],
            incoming: [newer],
            suppressedEventIDs: []
        )
        XCTAssertEqual(newerResult.first?.coordination?.revision, 3)

        let terminalResult = EventProjectionReducer.merge(
            existing: [current],
            incoming: [terminal],
            suppressedEventIDs: []
        )
        XCTAssertEqual(terminalResult.first?.state, .resolved)

        let terminalCannotRollback = EventProjectionReducer.merge(
            existing: [terminal],
            incoming: [current],
            suppressedEventIDs: []
        )
        XCTAssertEqual(terminalCannotRollback.first?.state, .resolved)

        let suppressedResult = EventProjectionReducer.merge(
            existing: [],
            incoming: [current, event(id: "event-visible", state: .active, revision: 1)],
            suppressedEventIDs: [current.id]
        )
        XCTAssertEqual(suppressedResult.map(\.id), ["event-visible"])
    }

    @MainActor
    func testResponseOfferProjectionCoordinatorPreservesReceiptGatesAndClear() {
        var projectionChanges: [ResponseOfferProjectionCoordinator.Projection] = []
        var advances: [ResponseOfferProjectionCoordinator.ReceiptAdvance] = []
        var errors = 0
        let fixedNow = now
        let coordinator = ResponseOfferProjectionCoordinator(
            now: { fixedNow },
            onProjectionChanged: { projectionChanges.append($0) },
            onReceiptAdvanced: { advances.append($0) },
            onError: { _ in errors += 1 }
        )
        let request = ResponseRequest(
            schemaVersion: "2.0",
            messageId: "message-response-projection",
            eventId: "event-response-projection",
            deliveryId: "delivery-response-projection",
            deliveryStatus: .sent,
            occurredAt: now,
            eventType: .fallAssistance,
            positioningTier: .searchRing,
            distanceRange: .zeroTo500Meters,
            etaRange: .zeroTo5Minutes,
            currentRecruitmentRadiusMeters: 1_000,
            expiresAt: now.addingTimeInterval(60)
        )

        XCTAssertEqual(
            coordinator.receive(request),
            .accepted(shouldMarkDelivered: true)
        )
        XCTAssertEqual(
            coordinator.receive(request),
            .ignored,
            "same messageId 不得复制当前邀请"
        )
        XCTAssertEqual(coordinator.projection.deliveryStatus, .sent)
        XCTAssertFalse(coordinator.advance(to: .accepted))
        XCTAssertEqual(errors, 1)

        XCTAssertTrue(coordinator.advance(to: .delivered))
        XCTAssertTrue(coordinator.advance(to: .viewed))
        XCTAssertTrue(coordinator.advance(to: .accepted))
        XCTAssertEqual(advances.map(\.status), [.delivered, .viewed, .accepted])
        XCTAssertEqual(projectionChanges.last?.deliveryStatus, .accepted)

        coordinator.clear()
        XCTAssertNil(coordinator.projection.request)
        XCTAssertNil(coordinator.projection.deliveryStatus)
        XCTAssertFalse(coordinator.advance(to: .refused))
    }

    @MainActor
    func testAssignmentProjectionCoordinatorKeepsRevisionAndAedReceiptIdentity() throws {
        var projections: [AssignmentProjectionCoordinator.Projection] = []
        var generatedReceiptIDs = 0
        let coordinator = AssignmentProjectionCoordinator(
            makeID: {
                generatedReceiptIDs += 1
                return "receipt-assignment-projection-\(generatedReceiptIDs)"
            },
            onProjectionChanged: { projections.append($0) }
        )
        func assignment(
            id: String = "assignment-projection",
            revision: Int,
            status: AssignmentStatus = .arrivedAtAed
        ) -> Assignment {
            Assignment(
                id: id,
                eventId: "event-assignment-projection",
                role: .fetchAed,
                status: status,
                revision: revision,
                route: nil,
                aedAcquiredReceipt: nil
            )
        }

        XCTAssertTrue(coordinator.apply(assignment(revision: 2)))
        XCTAssertFalse(coordinator.apply(assignment(revision: 1)))
        XCTAssertEqual(coordinator.projection.assignment?.revision, 2)
        XCTAssertTrue(coordinator.apply(assignment(revision: 3)))

        coordinator.markAccepted(eventID: "event-assignment-projection")
        XCTAssertEqual(coordinator.projection.acceptedResponseEventID, "event-assignment-projection")
        let receipt = coordinator.prepareAedReceipt(
            eventID: "event-assignment-projection",
            assignmentID: "assignment-projection",
            aedID: "aed-projection",
            acquiredAt: now
        )
        let replay = coordinator.prepareAedReceipt(
            eventID: "event-assignment-projection",
            assignmentID: "assignment-projection",
            aedID: "aed-projection",
            acquiredAt: now.addingTimeInterval(1)
        )
        XCTAssertEqual(receipt.receiptId, replay.receiptId)
        XCTAssertEqual(try coordinator.applyAedReceipt(receipt), .recorded(receipt))
        XCTAssertEqual(try coordinator.applyAedReceipt(receipt), .idempotent(receipt))
        XCTAssertEqual(coordinator.projection.assignment?.status, .aedAcquired)

        let otherReceipt = coordinator.prepareAedReceipt(
            eventID: "event-assignment-projection",
            assignmentID: "assignment-other",
            aedID: "aed-other",
            acquiredAt: now
        )
        let otherResult = try coordinator.applyAedReceipt(otherReceipt)
        guard case let .recorded(authoritativeOther) = otherResult else {
            return XCTFail("新的 assignment 首次 AED receipt 必须记录自己的 authoritative receipt")
        }
        XCTAssertEqual(authoritativeOther, otherReceipt)
        XCTAssertEqual(
            coordinator.projection.assignment?.id,
            "assignment-projection",
            "非当前 assignment 的 receipt 不能篡改当前任务投影"
        )

        XCTAssertTrue(coordinator.apply(assignment(id: "assignment-other", revision: 4)))
        XCTAssertEqual(try coordinator.applyAedReceipt(otherReceipt), .idempotent(otherReceipt))
        XCTAssertEqual(coordinator.projection.assignment?.id, "assignment-other")

        XCTAssertTrue(coordinator.markTimedOut(
            assignmentID: "assignment-other",
            eventID: "event-assignment-projection"
        ))
        XCTAssertEqual(coordinator.projection.assignment?.status, .timedOut)
        XCTAssertEqual(
            coordinator.projection.acceptedResponseEventID,
            "event-assignment-projection",
            "超时投影保留既有接受事件关系；AppStore 的连接/状态 lease 会阻止在途旧状态回写"
        )

        coordinator.clear()
        XCTAssertNil(coordinator.projection.assignment)
        XCTAssertNil(coordinator.projection.acceptedResponseEventID)
        XCTAssertGreaterThan(projections.count, 0)
    }

    private var bootstrapRequest: DeviceSessionBootstrapRequest {
        DeviceSessionBootstrapRequest(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-c11b2d3983cc",
            deviceKind: .iPhone,
            companionPairId: "REDACTED-SUPPLEMENT-ID-55cf02864771",
            agreementAcceptances: [
                AgreementAcceptance(kind: .patient, version: "2.0", acceptedAt: now),
                AgreementAcceptance(kind: .volunteerResponder, version: "2.0", acceptedAt: now),
                AgreementAcceptance(kind: .privacyPolicy, version: "2.0", acceptedAt: now),
                AgreementAcceptance(
                    kind: .sensitivePersonalInformation,
                    version: "2.0",
                    acceptedAt: now
                )
            ]
        )
    }

    private func makeClient(transport: ScriptedTransport) throws -> APIClient {
        let fixedNow = now
        return APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { fixedNow },
            authSession: AuthSession(
                accessToken: "account-token",
                refreshToken: "account-refresh-token",
                expiresAt: fixedNow.addingTimeInterval(3_600),
                userId: "user-1",
                method: .apple,
                serviceBaseURL: "https://example.test/api/v2/"
            )
        )
    }

    private func makeEventPositionUploadBatch(
        recordID: String = "REDACTED-SUPPLEMENT-ID-d87e745407ea",
        eventID: String = "REDACTED-SUPPLEMENT-ID-4e355e9b057f",
        batchID: String = "REDACTED-SUPPLEMENT-ID-6533124ee390",
        slotAt: Date? = nil
    ) throws -> PersistedEventPositionBatch {
        let record = try EventPositionRecord.noNewFix(
            recordID: recordID,
            slotAt: slotAt ?? now,
            gapReason: .noFix
        )
        let batch = try EventPositionBatch(
            eventId: eventID,
            batchId: batchID,
            records: [record]
        )
        return try PersistedEventPositionBatch(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-1",
            deviceInstanceId: bootstrapRequest.deviceInstanceId,
            eventId: batch.eventId,
            role: .patient,
            generation: 1,
            windowStartedAt: now,
            batch: batch
        )
    }
}

private actor ScriptedTransport: APIHTTPTransport {
    struct RecordedRequest: Equatable, Sendable {
        let path: String
        let authorization: String?
        let body: Data?

        var jsonBody: [String: Any]? {
            guard let body,
                  let object = try? JSONSerialization.jsonObject(with: body)
            else { return nil }
            return object as? [String: Any]
        }
    }

    struct Response: Sendable {
        let statusCode: Int
        let body: Data

        static func bootstrap(token: String, expiresAt: Date) -> Response {
            let formatter = ISO8601DateFormatter()
            let body = #"{"sessionId":"REDACTED-SUPPLEMENT-ID-81ecc6937557","sessionToken":"\#(token)","expiresAt":"\#(formatter.string(from: expiresAt))","scopes":["events:read"]}"#
            return .json(statusCode: 201, body: body)
        }

        static func json(statusCode: Int, body: String) -> Response {
            Response(statusCode: statusCode, body: Data(body.utf8))
        }
    }

    private var responses: [Response]
    private var requests: [RecordedRequest] = []
    private var suspendNextResponse = false
    private var suspendedResponseContinuation: CheckedContinuation<Void, Never>?

    init(responses: [Response]) {
        self.responses = responses
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url, !responses.isEmpty else {
            throw APIClientError.invalidResponse
        }
        requests.append(
            RecordedRequest(
                path: url.path,
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                body: request.httpBody
            )
        )
        let response = responses.removeFirst()
        if suspendNextResponse {
            suspendNextResponse = false
            await withCheckedContinuation { continuation in
                suspendedResponseContinuation = continuation
            }
        }
        guard let http = HTTPURLResponse(
            url: url,
            statusCode: response.statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw APIClientError.invalidResponse
        }
        return (response.body, http)
    }

    func recordedRequests() -> [RecordedRequest] {
        requests
    }

    func suspendNextResponseUntilResumed() {
        suspendNextResponse = true
    }

    func isResponseSuspended() -> Bool {
        suspendedResponseContinuation != nil
    }

    func resumeSuspendedResponse() {
        suspendedResponseContinuation?.resume()
        suspendedResponseContinuation = nil
    }
}
