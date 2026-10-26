import Foundation
import XCTest
@testable import AEDResponseWatchLogic

final class WatchFallbackAPIContractTests: XCTestCase {
    private let baseURL = "https://fallback.example.test"
    private let pairID = "REDACTED-SUPPLEMENT-ID-46de918f5446"
    private let now = Date(timeIntervalSince1970: 1_788_000_000)

    func testStateRecoveryUsesGETWithoutBodyAndPreservesEveryTerminalKind() async throws {
        let eventID = "REDACTED-SUPPLEMENT-ID-2bd401df1e27"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "WatchStateContract.\(UUID().uuidString)"))
        let configuration = WatchConfigurationStore(defaults: defaults)
        configuration.applyLinkedConfiguration(baseURL: baseURL, companionPairID: pairID)
        let session = WatchAuthSession(accessToken: "watch-access", refreshToken: "watch-refresh",
            expiresAt: now.addingTimeInterval(3_600), baseURL: "\(baseURL)/api/v2/",
            deviceInstanceID: configuration.load().deviceInstanceID, companionPairID: pairID)
        let formatter = ISO8601DateFormatter()
        let states: [EventState] = [.active, .resolved, .cancelledConfirmedFalseAlarm, .closedUnconfirmedNoResponse]
        let transport = RecordingWatchTransportForFallback(responses: states.map { state in
            let ended = state == .active ? "null" : "\"\(formatter.string(from: now.addingTimeInterval(20)))\""
            return .json(statusCode: 200, body: "{\"eventId\":\"\(eventID)\",\"state\":\"\(state.rawValue)\",\"createdAt\":\"\(formatter.string(from: now))\",\"resolvedAt\":\(ended)}")
        })
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: MemoryWatchAuthStoreForFallback(session: session),
            appAttestKeyStore: MemoryAppAttestKeyStoreForFallback(), appAttest: FakeWatchAppAttestForFallback(),
            now: { Date(timeIntervalSince1970: 1_788_000_000) })
        for state in states {
            let recovered = try await reporter.fetchEventState(eventID: eventID)
            XCTAssertEqual(recovered.state, state)
            XCTAssertEqual(recovered.createdAt, now)
            XCTAssertEqual(recovered.resolvedAt, state == .active ? nil : now.addingTimeInterval(20))
        }
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 4)
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" && $0.httpBody == nil })
        XCTAssertTrue(requests.allSatisfy { $0.url?.path == "/api/v2/watch/events/\(eventID)/state" })
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer [REDACTED]" })
    }

    func testFallbackUsesNewEndpointExactBodyAndDeviceBearer() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "WatchFallbackAPIContractTests.\(UUID().uuidString)"))
        let configuration = WatchConfigurationStore(defaults: defaults)
        configuration.applyLinkedConfiguration(baseURL: baseURL, companionPairID: pairID)
        let deviceID = configuration.load().deviceInstanceID
        let authStore = MemoryWatchAuthStoreForFallback(session: WatchAuthSession(
            accessToken: "watch-access",
            refreshToken: "watch-refresh",
            expiresAt: now.addingTimeInterval(3_600),
            baseURL: "\(baseURL)/api/v2/",
            deviceInstanceID: deviceID,
            companionPairID: pairID, userID: "watch-user", accountID: "watch-account"
        ))
        let transport = RecordingWatchTransportForFallback(responses: [
            .json(statusCode: 200, body: positionBody(id: "position-901")),
            .json(statusCode: 200, body: "{\"id\":\"REDACTED-SUPPLEMENT-ID-7f1a10d9cd75\",\"state\":\"ACTIVE\"}")
        ])
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: authStore,
            appAttestKeyStore: MemoryAppAttestKeyStoreForFallback(),
            appAttest: FakeWatchAppAttestForFallback(),
            now: { Date(timeIntervalSince1970: 1_788_000_000) }
        )
        let update = WatchFallbackPositionUpdate(
            eventId: "REDACTED-SUPPLEMENT-ID-7f1a10d9cd75",
            positionUpdateId: "position-901",
            observedAt: now,
            patientPosition: try PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            activationState: .inactive,
            iphoneReachable: true,
            networkAvailable: true
        )

        _ = try await reporter.reportFallbackPosition(update)

        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(
            request.url?.path,
            "/api/v2/watch/events/REDACTED-SUPPLEMENT-ID-7f1a10d9cd75/fallback-position/position-901"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer [REDACTED]")
        let body = try jsonObject(request)
        XCTAssertEqual(
            Set(body.keys),
            [
                "schemaVersion", "eventId", "positionUpdateId", "observedAt",
                "patientPosition", "activationState", "iphoneReachable", "networkAvailable"
            ]
        )
        XCTAssertEqual(body["activationState"] as? String, "INACTIVE")
        XCTAssertEqual(body["iphoneReachable"] as? Bool, true)
        XCTAssertEqual(body["networkAvailable"] as? Bool, true)

        let observation = WatchEmergencyObservation(
            eventId: update.eventId,
            fallDetectedAt: now,
            fallResolution: .confirmed,
            appHelpResponse: .needsHelp,
            patientPosition: update.patientPosition,
            patientPositionObservedAt: now.addingTimeInterval(-700.125),
            locationUnavailableReason: nil
        )
        let binding = await reporter.observationSourceBinding()
        try await reporter.report(observation, sourceBinding: XCTUnwrap(binding))
        let allRequests = await transport.requests()
        XCTAssertEqual(allRequests.count, 2)
        let triggerRequest = try XCTUnwrap(allRequests.last)
        XCTAssertEqual(triggerRequest.url?.path, "/api/v2/watch/emergency-observations/\(update.eventId)")
        let transmitted = try JSONDecoder.contractDecoder().decode(
            WatchEmergencyObservation.self, from: XCTUnwrap(triggerRequest.httpBody)
        )
        XCTAssertEqual(transmitted, observation)
        XCTAssertNotEqual(transmitted.patientPositionObservedAt, transmitted.fallDetectedAt)
    }

    func testTriggerACKRequiresMatchingEventAndValidState() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "WatchACK.\(UUID().uuidString)"))
        let configuration = WatchConfigurationStore(defaults: defaults)
        configuration.applyLinkedConfiguration(baseURL: baseURL, companionPairID: pairID)
        let id = "REDACTED-SUPPLEMENT-ID-36a6938925da"
        let auth = MemoryWatchAuthStoreForFallback(session: WatchAuthSession(accessToken: "watch-access",
            refreshToken: "watch-refresh", expiresAt: now.addingTimeInterval(3600), baseURL: "\(baseURL)/api/v2/",
            deviceInstanceID: configuration.load().deviceInstanceID, companionPairID: pairID,
            userID: "watch-user", accountID: "watch-account"))
        let transport = RecordingWatchTransportForFallback(responses: [
            .json(statusCode: 200, body: "{}"),
            .json(statusCode: 201, body: "{\"id\":\"wrong-event\",\"state\":\"ACTIVE\"}"),
            .json(statusCode: 200, body: "{\"id\":\"\(id)\",\"state\":\"UNKNOWN\"}"),
            .json(statusCode: 200, body: "{\"id\":\"\(id)\",\"state\":\"RESOLVED\"}")
        ])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: auth, appAttestKeyStore: MemoryAppAttestKeyStoreForFallback(),
            appAttest: FakeWatchAppAttestForFallback(), now: { Date(timeIntervalSince1970: 1_788_000_000) })
        let observation = WatchEmergencyObservation(eventId: id, fallDetectedAt: now, fallResolution: .confirmed,
            appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "TEST_NO_FIX")
        let binding = await reporter.observationSourceBinding()
        let sourceBinding = try XCTUnwrap(binding)
        for _ in 0..<3 {
            do { try await reporter.report(observation, sourceBinding: sourceBinding); XCTFail("Malformed or mismatched ACK must be rejected") }
            catch { }
        }
        try await reporter.report(observation, sourceBinding: sourceBinding)
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 4)
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "PUT" && $0.httpBody == requests[0].httpBody })
    }

    func testForbiddenFallbackDoesNotRotateWatchRefresh() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "WatchFallbackAPIContractTests.\(UUID().uuidString)"))
        let configuration = WatchConfigurationStore(defaults: defaults)
        configuration.applyLinkedConfiguration(baseURL: baseURL, companionPairID: pairID)
        let deviceID = configuration.load().deviceInstanceID
        let authStore = MemoryWatchAuthStoreForFallback(session: WatchAuthSession(
            accessToken: "watch-access",
            refreshToken: "watch-refresh",
            expiresAt: now.addingTimeInterval(3_600),
            baseURL: "\(baseURL)/api/v2/",
            deviceInstanceID: deviceID,
            companionPairID: pairID
        ))
        let transport = RecordingWatchTransportForFallback(responses: [
            .json(statusCode: 403, body: "{}")
        ])
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: authStore,
            appAttestKeyStore: MemoryAppAttestKeyStoreForFallback(),
            appAttest: FakeWatchAppAttestForFallback(),
            now: { Date(timeIntervalSince1970: 1_788_000_000) }
        )
        let update = WatchFallbackPositionUpdate(
            eventId: "REDACTED-SUPPLEMENT-ID-97fdd5e0b0f0",
            positionUpdateId: "position-903",
            observedAt: now,
            patientPosition: try PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            activationState: .activated,
            iphoneReachable: true,
            networkAvailable: true
        )

        await XCTAssertThrowsErrorAsyncForFallback(
            try await reporter.reportFallbackPosition(update)
        ) { error in
            guard case WatchAPIError.rejected(403) = error else {
                return XCTFail("expected HTTP 403")
            }
        }
        let requestCount = await transport.requests().count
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(authStore.loadAuthSession()?.refreshToken, "watch-refresh")
    }

    private func positionBody(id: String) -> String {
        let date = ISO8601DateFormatter().string(from: now)
        return "{\"positionUpdateId\":\"\(id)\",\"applied\":true,\"idempotent\":false,\"ignoredAsStale\":false,\"positionObservedAt\":\"\(date)\",\"serverReceivedAt\":\"\(date)\"}"
    }

    private func jsonObject(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class MemoryWatchAuthStoreForFallback: @unchecked Sendable, WatchAuthSessionPersisting {
    private let lock = NSLock()
    private var session: WatchAuthSession?

    init(session: WatchAuthSession?) { self.session = session }
    func loadAuthSession() -> WatchAuthSession? {
        lock.lock(); defer { lock.unlock() }; return session
    }
    func saveAuthSession(_ session: WatchAuthSession) throws {
        lock.lock(); self.session = session; lock.unlock()
    }
    func clearAuthSession() throws {
        lock.lock(); session = nil; lock.unlock()
    }
}

private final class MemoryAppAttestKeyStoreForFallback: @unchecked Sendable, WatchAppAttestKeyPersisting {
    func loadAppAttestKeyID() -> String? { nil }
    func saveAppAttestKeyID(_ keyID: String) throws { _ = keyID }
    func clearAppAttestKeyID() throws {}
}

private struct FakeWatchAppAttestForFallback: WatchAppAttestProviding {
    let isSupported = true
    func generateKey() async throws -> String { "key" }
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        _ = keyID; _ = clientDataHash; return Data()
    }
}

private actor RecordingWatchTransportForFallback: WatchAPIHTTPTransport {
    struct Response: Sendable {
        let statusCode: Int
        let body: Data
        static func json(statusCode: Int, body: String) -> Response {
            Response(statusCode: statusCode, body: Data(body.utf8))
        }
    }
    private var responses: [Response]
    private var recorded: [URLRequest] = []
    init(responses: [Response]) { self.responses = responses }
    func requests() -> [URLRequest] { recorded }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        recorded.append(request)
        guard let url = request.url, !responses.isEmpty else {
            throw WatchAPIError.invalidResponse
        }
        let response = responses.removeFirst()
        return (
            response.body,
            try XCTUnwrap(HTTPURLResponse(
                url: url,
                statusCode: response.statusCode,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            ))
        )
    }
}

private func XCTAssertThrowsErrorAsyncForFallback<T>(
    _ expression: @autoclosure () async throws -> T,
    _ handler: (Error) -> Void
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an asynchronous error")
    } catch {
        handler(error)
    }
}
