import Foundation
import XCTest
@testable import AEDResponse

final class TestAuthSessionStore: @unchecked Sendable, AuthSessionPersisting {
    private var storedSession: AuthSession?
    var readFailuresRemaining = 0

    init(session: AuthSession?) {
        storedSession = session
    }

    func load() -> AuthSession? { storedSession }
    func loadRecoverable() throws -> AuthSession? {
        if readFailuresRemaining > 0 {
            readFailuresRemaining -= 1
            throw AuthError.persistenceFailed
        }
        return storedSession
    }

    func save(_ session: AuthSession) throws {
        storedSession = session
    }

    func clear() throws {
        storedSession = nil
    }

    static var fixtureSession: AuthSession {
        AuthSession(
            accessToken: "user-access-token",
            refreshToken: "user-refresh-token",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            userId: "user-1",
            method: .apple,
            serviceBaseURL: "http://127.0.0.1:8787/api/v2/"
        )
    }
}

actor TestAuthClient: AuthClient {
    private(set) var appleIdentityTokens: [String] = []
    private var suspendApple = false
    private var appleContinuation: CheckedContinuation<Void, Never>?
    func blockAppleLogin() { suspendApple = true }
    func appleLoginIsBlocked() -> Bool { appleContinuation != nil }
    func releaseAppleLogin() { appleContinuation?.resume(); appleContinuation = nil }
    var sessionMethod: AuthMethod = .apple
    var sessionUserID = "apple-user"
    private var refreshFailures = 0
    private var refreshStatus = 503
    private(set) var refreshAttempts = 0
    func configureRefreshFailures(_ count: Int, status: Int) { refreshFailures = count; refreshStatus = status }

    func requestAppleLoginChallenge() async throws -> AppleLoginChallenge {
        AppleLoginChallenge(challengeId: "REDACTED-SUPPLEMENT-ID-8cca3400b26b",
            nonce: "synthetic-apple-login-challenge", expiresAt: Date(timeIntervalSince1970: 2_000_000_000))
    }

    func authenticateWithApple(
        identityToken: String,
        rawNonce: String,
        authorizationCode: String?,
        challengeID: String?
    ) async throws -> AuthSession {
        guard !identityToken.isEmpty, !rawNonce.isEmpty else {
            throw AuthError.invalidAppleCredential
        }
        appleIdentityTokens.append(identityToken)
        let verifiedUserID = sessionUserID
        if suspendApple {
            suspendApple = false
            await withCheckedContinuation { appleContinuation = $0 }
        }
        return AuthSession(
            accessToken: "apple-access-token",
            refreshToken: "apple-refresh-token",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            userId: verifiedUserID,
            method: .apple
        )
    }

    func refreshSession(_ session: AuthSession) async throws -> AuthSession {
        refreshAttempts += 1
        if refreshFailures > 0 {
            refreshFailures -= 1
            throw APIClientError.unexpectedStatus(refreshStatus)
        }
        return session
    }

    func setSessionUserID(_ value: String) {
        sessionUserID = value
    }
}

actor BlockingRefreshAuthClient: AuthClient {
    private let refreshedSession: AuthSession
    private var continuation: CheckedContinuation<AuthSession, Error>?
    private(set) var didStartRefresh = false

    init(session: AuthSession) {
        refreshedSession = session
    }

    func authenticateWithApple(
        identityToken: String,
        rawNonce: String,
        authorizationCode: String?,
        challengeID: String?
    ) async throws -> AuthSession {
        throw AuthError.invalidResponse
    }

    func refreshSession(_ session: AuthSession) async throws -> AuthSession {
        didStartRefresh = true
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func refreshStarted() -> Bool { didStartRefresh }

    func release() {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(returning: refreshedSession)
    }
}

@MainActor
final class AuthenticationArchitectureTests: XCTestCase {
    func testRemoteNotificationInterruptsIntroWithoutAuthenticatingOrGrantingAnEvent() throws {
        let store = makeStore(scenario: try loadScenario(), authSessionStore: TestAuthSessionStore(session: nil),
                              authClient: TestAuthClient())
        store.beginLaunchPresentation(reduceMotion: false)
        XCTAssertTrue(store.launchPresentation.isPresenting)
        store.remoteNotificationTapped(messageID: "pending-notification")
        XCTAssertEqual(store.launchPresentation.phase, .finished)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.visibleEvents.isEmpty)
        store.beginLaunchPresentation(reduceMotion: false)
        XCTAssertFalse(store.launchPresentation.isPresenting)
    }

    func testLocalNotificationBeforeRootSkipsIntroWithoutGrantingAnEvent() throws {
        let store = makeStore(scenario: try loadScenario(), authSessionStore: TestAuthSessionStore(session: nil),
                              authClient: TestAuthClient())
        store.localEmergencyNotificationTapped(eventID: UUID().uuidString, owner: String(repeating: "a", count: 64))
        store.beginLaunchPresentation(reduceMotion: false)
        XCTAssertEqual(store.launchPresentation.phase, .finished)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.visibleEvents.isEmpty)
    }

    func testRestoredAccountWithUnknownServerStateSkipsIntro() throws {
        let store = makeStore(scenario: try loadScenario(),
                              authSessionStore: TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession),
                              authClient: TestAuthClient())
        defer { store.disconnect() }
        XCTAssertTrue(store.launchPresentationContext.requiresImmediateContent)
        store.beginLaunchPresentation(reduceMotion: false)
        XCTAssertEqual(store.launchPresentation.phase, .finished)
    }

    func testTemporarilyUnreadableKeychainWaitsInsteadOfShowingSignedOut() async throws {
        let persisted = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        persisted.readFailuresRemaining = 1
        let store = makeStore(scenario: try loadScenario(), authSessionStore: persisted, authClient: TestAuthClient())
        XCTAssertTrue(store.isRestoringAuthentication)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNotNil(persisted.load())
        for _ in 0..<300 {
            if store.isAuthenticated { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertFalse(store.isRestoringAuthentication)
        XCTAssertNotNil(persisted.load())
        store.logout()
    }

    func testTwoAPIClientsRestoreExpiredLoginThroughOneDurableRotation() async throws {
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let expiry = ISO8601DateFormatter().string(from: now.addingTimeInterval(900))
        let old = AuthSession(accessToken: "expired", refreshToken: "original-refresh",
            expiresAt: now.addingTimeInterval(-7_200), userId: "user-1", method: .apple,
            serviceBaseURL: "https://example.test/api/v2/", loginID: "one-explicit-login")
        let persisted = TestAuthSessionStore(session: old)
        let refresher = AuthSessionRefreshCoordinator(store: persisted)
        let transport = AuthTransport(responses: [
            .json(statusCode: 200, body: "{\"userId\":\"user-1\",\"sessionToken\":\"new-account\",\"refreshToken\":\"new-refresh\",\"expiresAt\":\"\(expiry)\"}"),
            .json(statusCode: 201, body: "{\"sessionId\":\"device-1\",\"sessionToken\":\"device-one\",\"expiresAt\":\"\(expiry)\",\"scopes\":[\"events:read\"]}"),
            .json(statusCode: 201, body: "{\"sessionId\":\"device-2\",\"sessionToken\":\"device-two\",\"expiresAt\":\"\(expiry)\",\"scopes\":[\"events:read\"]}")
        ], delayNanoseconds: 20_000_000)
        let configuration = try APIConfiguration(userEnteredURL: "https://example.test")
        let first = APIClient(configuration: configuration, transport: transport, now: { now },
                              authSession: old, accountSessionRefresher: refresher)
        let reconnected = APIClient(configuration: configuration, transport: transport, now: { now },
                                    authSession: old, accountSessionRefresher: refresher)
        let request = DeviceSessionBootstrapRequest(deviceInstanceId: "REDACTED-SUPPLEMENT-ID-11e594f48195",
            deviceKind: .iPhone, companionPairId: "REDACTED-SUPPLEMENT-ID-e79acd97ac88", agreementAcceptances: [])
        async let firstResult = first.bootstrapSession(request: request)
        async let secondResult = reconnected.bootstrapSession(request: request)
        _ = try await (firstResult, secondResult)
        XCTAssertEqual(persisted.load()?.refreshToken, "new-refresh", "No UI callback is needed to save rotation")
        XCTAssertEqual(persisted.load()?.loginID, old.loginID)
        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.path.hasSuffix("/refresh") }.count, 1)
        XCTAssertTrue(requests.filter { $0.path.hasSuffix("/bootstrap") }.allSatisfy { $0.authorization == "Bearer new-account" })
    }

    func testRejectedAccountGetsStableSeparateDeviceAndPairWithoutReplacingLegacy() throws {
        let name = "device-account-isolation-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let identities = UserDefaultsDeviceIdentityStore(defaults: defaults)
        let session = TestAuthSessionStore.fixtureSession
        let original = identities.identity(for: session)
        XCTAssertTrue(identities.isolateRejectedAccount(session))
        XCTAssertFalse(identities.isolateRejectedAccount(session))
        let scoped = identities.identity(for: session)
        XCTAssertNotEqual(scoped.device, original.device)
        XCTAssertNotEqual(scoped.pair, original.pair)
        XCTAssertEqual(identities.deviceInstanceID(), original.device)
        XCTAssertEqual(identities.companionPairID(), original.pair)
        let reopened = UserDefaultsDeviceIdentityStore(defaults: defaults)
        XCTAssertEqual(reopened.identity(for: session).device, scoped.device)
        XCTAssertEqual(reopened.identity(for: session).pair, scoped.pair)
    }

    func testDeviceBindingConflictRequiresSpecificContract() {
        func problem(_ type: String, _ status: Int, _ detail: String?) -> ProblemDetails {
            ProblemDetails(type: type, title: "Forbidden", status: status, detail: detail)
        }
        let typed = "https://aedresponse.invalid/problems/device-account-binding-conflict"
        let legacy = "https://aedresponse.invalid/problems/403"
        let detail = "deviceInstanceId is already bound to a different authenticated account"
        XCTAssertTrue(problem(typed, 403, "localized message").isDeviceAccountBindingConflict)
        XCTAssertTrue(problem(legacy, 403, detail).isDeviceAccountBindingConflict)
        XCTAssertFalse(problem(typed, 401, detail).isDeviceAccountBindingConflict)
        XCTAssertFalse(problem(legacy, 403, "access revoked").isDeviceAccountBindingConflict)
        XCTAssertFalse(problem("other", 403, detail).isDeviceAccountBindingConflict)
    }

    func testOldAppleLoginCannotReplaceNewerSessionAfterLogout() async throws {
        let client = TestAuthClient()
        let persisted = TestAuthSessionStore(session: nil)
        let store = makeStore(scenario: try loadScenario(), authSessionStore: persisted, authClient: client)
        await client.setSessionUserID("old-user")
        await client.blockAppleLogin()
        let old = Task { await store.signInWithApple(baseURL: "https://example.test",
            identityToken: "old-apple", rawNonce: "nonce", authorizationCode: nil) }
        try await waitUntilAsync { await client.appleLoginIsBlocked() }
        store.logout()
        // A second identity completes while the first verified result is parked.
        await client.setSessionUserID("fresh-user")
        let freshChallenge = try await store.requestAppleLoginChallenge(baseURL: "https://example.test")
        let loggedIn = await store.signInWithApple(
            baseURL: "https://example.test",
            identityToken: "fresh-apple",
            rawNonce: freshChallenge.nonce,
            authorizationCode: nil
        )
        XCTAssertTrue(loggedIn)
        await client.releaseAppleLogin()
        let oldResult = await old.value
        XCTAssertFalse(oldResult)
        XCTAssertEqual(store.authSession?.userId, "fresh-user")
        XCTAssertEqual(persisted.load()?.userId, "fresh-user")
        XCTAssertFalse(store.isAuthenticating)
    }

    func testOnboardingPermissionResultAfterLogoutCannotSaveConsent() async throws {
        let notifications = TestNotificationPermissions()
        let client = TestAuthClient()
        let store = makeStore(scenario: try loadScenario(), notificationPermissions: notifications,
            authSessionStore: TestAuthSessionStore(session: nil), authClient: client)
        let login = await store.signInWithApple(baseURL: "https://example.test",
            identityToken: "apple", rawNonce: "nonce", authorizationCode: nil)
        XCTAssertTrue(login)
        notifications.blockRequest = true
        let pending = Task { await store.completeOnboarding(patientAgreementAccepted: true,
            responderAgreementAccepted: true, privacyPolicyAccepted: true,
            sensitivePersonalInformationAccepted: true) }
        try await waitUntil { notifications.pendingRequest != nil }
        store.logout()
        notifications.releaseRequest()
        let accepted = await pending.value
        XCTAssertFalse(accepted)
        XCTAssertFalse(store.isOnboardingComplete)
        XCTAssertFalse(store.notificationPermissionGranted)
        XCTAssertFalse(store.isCompletingOnboarding)
        XCTAssertFalse(store.isBusinessAccessReady)
    }

    func testApplePreparationUsesUnauthenticatedCanonicalEndpoint() async throws {
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let expiresAt = ISO8601DateFormatter().string(from: now.addingTimeInterval(300))
        let transport = AuthTransport(responses: [.json(
            statusCode: 201,
            body: "{\"provider\":\"APPLE\",\"challengeId\":\"REDACTED-SUPPLEMENT-ID-f1c20ffa0fd7\",\"nonce\":\"abcdefghijklmnopqrstuvwxyz0123456789\",\"expiresAt\":\"\(expiresAt)\"}"
        )])
        let client = APIClient(configuration: try APIConfiguration(userEnteredURL: "https://example.test"), transport: transport, now: { now })
        let challenge = try await client.requestAppleLoginChallenge()
        XCTAssertEqual(challenge.challengeId, "REDACTED-SUPPLEMENT-ID-f1c20ffa0fd7")
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.path, "/api/v2/auth/apple/challenges")
        XCTAssertNil(requests.first?.authorization)
        XCTAssertEqual(requests.first?.jsonBody?.count, 0)
    }

    func testAppleLoginCannotSubmitWithoutPreparedChallenge() async throws {
        let transport = AuthTransport(responses: [])
        let client = APIClient(configuration: try APIConfiguration(userEnteredURL: "https://example.test"), transport: transport)
        do {
            _ = try await client.authenticateWithApple(identityToken: "synthetic-token", rawNonce: "raw", authorizationCode: nil)
            XCTFail("A missing Apple challenge must fail before network I/O")
        } catch AuthError.invalidAppleCredential { }
        let requests = await transport.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testKeychainSessionCreateAndUpdateRoundTrip() throws {
        let sessionStore = KeychainAuthSessionStore(
            service: "dev.codex.aedresponse.keychain-validation.\(UUID().uuidString)"
        )
        defer { try? sessionStore.clear() }
        let initial = TestAuthSessionStore.fixtureSession
        try sessionStore.save(initial)
        XCTAssertEqual(sessionStore.load(), initial)
        let refreshed = AuthSession(
            accessToken: "keychain-fixture-refreshed-access",
            refreshToken: "keychain-fixture-refreshed-refresh",
            expiresAt: initial.expiresAt,
            userId: initial.userId,
            method: initial.method,
            serviceBaseURL: initial.serviceBaseURL
        )
        try sessionStore.save(refreshed)
        XCTAssertEqual(sessionStore.load(), refreshed)
    }
    func testAgreementPersistenceIsPartitionedByBackendUserId() throws {
        let suiteName = "aedresponse-auth-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UserDefaultsAgreementStore(defaults: defaults)
        let time = Date(timeIntervalSince1970: 1_788_000_100)
        let userA = AgreementState(
            patientAcceptedAt: time,
            responderAcceptedAt: time,
            privacyPolicyAcceptedAt: time,
            sensitivePersonalInformationAcceptedAt: time,
            patientAcceptedVersion: "2.0",
            responderAcceptedVersion: "2.0",
            privacyPolicyAcceptedVersion: "2.0",
            sensitivePersonalInformationAcceptedVersion: "2.0"
        )

        store.save(userA, for: "user-A")

        XCTAssertTrue(store.load(for: "user-A").isComplete)
        XCTAssertFalse(store.load(for: "user-B").isComplete)
        XCTAssertFalse(store.load().isComplete)
    }
    func testColdStartRefreshKeepsIdentityAndBusinessGatesClosedUntilSuccess() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let persisted = TestAuthSessionStore(
            session: AuthSession(
                accessToken: "expired-account-token",
                refreshToken: "account-refresh-token",
                expiresAt: now.addingTimeInterval(5),
                userId: "user-1",
                method: .apple,
                serviceBaseURL: "http://127.0.0.1:8787/api/v2/"
            )
        )
        let authClient = BlockingRefreshAuthClient(
            session: persisted.load()!
        )
        let connectivity = TestCompanionConnectivity()
        let notifications = TestNotificationPermissions()
        let location = LocationProvider(manager: nil)
        let api = TestEmergencyAPIClient()
        let store = makeStore(
            scenario: scenario,
            api: api,
            locationProvider: location,
            companionConnectivity: connectivity,
            notificationPermissions: notifications,
            authSessionStore: persisted,
            authClient: authClient
        )

        XCTAssertTrue(store.isRestoringAuthentication)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertEqual(connectivity.activationCount, 0)
        XCTAssertEqual(notifications.currentAuthorizationQueryCount, 0)
        XCTAssertEqual(notifications.requestCount, 0)
        XCTAssertFalse(location.isContinuousUpdating)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 0)

        try await waitUntilAsync { await authClient.refreshStarted() }
        XCTAssertTrue(store.isRestoringAuthentication)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertEqual(connectivity.activationCount, 0)
        XCTAssertFalse(location.isContinuousUpdating)

        await authClient.release()
        try await waitUntil { !store.isRestoringAuthentication }
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertEqual(store.authSession?.accessToken, "expired-account-token")
    }

    func testLogoutInvalidatesInFlightColdStartRefresh() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let persisted = TestAuthSessionStore(
            session: AuthSession(
                accessToken: "expired-account-token",
                refreshToken: "account-refresh-token",
                expiresAt: now.addingTimeInterval(5),
                userId: "user-1",
                method: .apple,
                serviceBaseURL: "http://127.0.0.1:8787/api/v2/"
            )
        )
        let authClient = BlockingRefreshAuthClient(session: persisted.load()!)
        let store = makeStore(
            scenario: scenario,
            api: TestEmergencyAPIClient(),
            authSessionStore: persisted,
            authClient: authClient
        )

        try await waitUntilAsync { await authClient.refreshStarted() }
        store.logout()
        await authClient.release()
        for _ in 0..<8 { await Task.yield() }

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertFalse(store.isRestoringAuthentication)
        XCTAssertNil(persisted.load())
    }

    func testTransientColdStartFailureKeepsCredentialAndAutomaticallyRecovers() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let persisted = TestAuthSessionStore(session: AuthSession(accessToken: "old", refreshToken: "refresh",
            expiresAt: now.addingTimeInterval(5), userId: "user-1", method: .apple,
            serviceBaseURL: "http://127.0.0.1:8787/api/v2/"))
        let auth = TestAuthClient()
        await auth.configureRefreshFailures(1, status: 503)
        let store = makeStore(scenario: scenario, api: TestEmergencyAPIClient(), authSessionStore: persisted, authClient: auth)
        try await waitUntilAsync { await auth.refreshAttempts == 1 }
        XCTAssertNotNil(persisted.load())
        XCTAssertTrue(store.isRestoringAuthentication)
        XCTAssertFalse(store.isAuthenticated)
        for _ in 0..<200 {
            if store.isAuthenticated { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertNotNil(persisted.load())
        XCTAssertNil(store.authenticationRestoreNotice)
        store.logout()
    }

    func testDefinitiveColdStartUnauthorizedClearsCredentialWithoutRetryLoop() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let persisted = TestAuthSessionStore(session: AuthSession(accessToken: "old", refreshToken: "revoked-refresh",
            expiresAt: now.addingTimeInterval(5), userId: "user-1", method: .apple,
            serviceBaseURL: "http://127.0.0.1:8787/api/v2/"))
        let auth = TestAuthClient()
        await auth.configureRefreshFailures(2, status: 401)
        let store = makeStore(scenario: scenario, api: TestEmergencyAPIClient(), authSessionStore: persisted, authClient: auth)
        try await waitUntil { !store.isRestoringAuthentication }
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(persisted.load())
        let attempts = await auth.refreshAttempts
        XCTAssertEqual(attempts, 1)
    }

    func testOrdinaryBuildRejectsPersistedControlledTestIdentity() async throws {
        let scenario = try loadScenario()
        let persisted = TestAuthSessionStore(session: AuthSession(
            accessToken: "controlled-test-fixture-token",
            refreshToken: "controlled-test-fixture-refresh",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            userId: "REDACTED-SUPPLEMENT-ID-46de918f5446",
            method: .controlledTest,
            serviceBaseURL: "https://example.test/api/v2/"
        ))
        let location = LocationProvider(manager: nil)
        let api = TestEmergencyAPIClient()
        let store = makeStore(
            scenario: scenario,
            api: api,
            locationProvider: location,
            authSessionStore: persisted,
            authClient: TestAuthClient()
        )
        XCTAssertFalse(AppFeatureFlags.usesControlledTestAccount)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertFalse(location.isContinuousUpdating)
        XCTAssertNil(persisted.load())
        let count = await api.bootstrapRequestCount()
        XCTAssertEqual(count, 0)
    }

    func testAppleLoginUsesInjectedAuthPortAndPersistsSession() async throws {
        let scenario = try loadScenario()
        let authStore = TestAuthSessionStore(session: nil)
        let authClient = TestAuthClient()
        let store = makeStore(
            scenario: scenario,
            authSessionStore: authStore,
            authClient: authClient
        )

        let signedIn = await store.signInWithApple(
            baseURL: "https://example.test",
            identityToken: "apple.identity.token",
            rawNonce: "raw-nonce",
            authorizationCode: "apple-code"
        )
        XCTAssertTrue(signedIn)
        XCTAssertEqual(store.authSession?.method, .apple)
        XCTAssertEqual(authStore.load()?.method, .apple)
        XCTAssertEqual(authStore.load()?.userId, "apple-user")
    }

    func testLogoutClearsSessionAndStopsBusinessServices() async throws {
        let scenario = try loadScenario()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let connectivity = TestCompanionConnectivity()
        let api = TestEmergencyAPIClient()
        let authClient = TestAuthClient()
        let stream = TestEventStream()
        let locationProvider = LocationProvider(manager: nil)
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let agreements = TestAgreementStore(
            state: AgreementState(
                patientAcceptedAt: now,
                responderAcceptedAt: now,
                privacyPolicyAcceptedAt: now,
                sensitivePersonalInformationAcceptedAt: now,
                patientAcceptedVersion: "2.0",
                responderAcceptedVersion: "2.0",
                privacyPolicyAcceptedVersion: "2.0",
                sensitivePersonalInformationAcceptedVersion: "2.0"
            )
        )
        let store = makeStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            agreementStore: agreements,
            companionConnectivity: connectivity,
            authSessionStore: authStore,
            authClient: authClient,
            makeStream: { stream }
        )

        XCTAssertTrue(store.isAuthenticated)
        XCTAssertEqual(connectivity.activationCount, 1)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.connectionState == ConnectionState.connected }

        store.logout()

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(authStore.load())
        XCTAssertFalse(locationProvider.isContinuousUpdating)
        XCTAssertEqual(store.connectionState, ConnectionState.disconnected)
        XCTAssertEqual(connectivity.deactivationCount, 1)
        XCTAssertTrue(store.visibleEvents.isEmpty)
        XCTAssertFalse(store.isOnboardingComplete)
        XCTAssertTrue(agreements.load().isComplete)

        // Logout is not consent withdrawal. The same backend user can sign
        // in again and immediately recover the current agreement versions.
        await authClient.setSessionUserID("user-1")
        let freshChallenge = try await store.requestAppleLoginChallenge(
            baseURL: "http://127.0.0.1:8787"
        )
        let reloggedIn = await store.signInWithApple(
            baseURL: "http://127.0.0.1:8787",
            identityToken: "fresh-apple",
            rawNonce: freshChallenge.nonce,
            authorizationCode: nil
        )
        XCTAssertTrue(reloggedIn)
        XCTAssertEqual(store.authSession?.userId, "user-1")
        XCTAssertTrue(store.isOnboardingComplete)
    }

    func testAuthClientUsesCanonicalBodiesAndAccountBearerForBootstrap() async throws {
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let formatter = ISO8601DateFormatter()
        let expiresAt = formatter.string(from: now.addingTimeInterval(3_600))
        let transport = AuthTransport(responses: [
            .json(
                statusCode: 200,
                body: "{\"provider\":\"APPLE\",\"userId\":\"user-2\",\"sessionId\":\"account-2\",\"sessionToken\":\"apple-token\",\"refreshToken\":\"apple-refresh\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"session:bootstrap\"]}"
            ),
            .json(
                statusCode: 200,
                body: "{\"provider\":\"APPLE\",\"userId\":\"user-2\",\"sessionId\":\"account-3\",\"sessionToken\":\"refreshed-token\",\"refreshToken\":\"refreshed-refresh\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"session:bootstrap\"]}"
            ),
            .json(
                statusCode: 201,
                body: "{\"sessionId\":\"device-1\",\"sessionToken\":\"device-token\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"events:read\"]}"
            )
        ])
        let client = APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { now }
        )

        let appleSession = try await client.authenticateWithApple(
            identityToken: "identity-token",
            rawNonce: "raw-nonce",
            authorizationCode: "authorization-code",
            challengeID: "REDACTED-SUPPLEMENT-ID-f1c20ffa0fd7"
        )
        XCTAssertEqual(appleSession.method, .apple)
        let refreshed = try await client.refreshSession(appleSession)
        XCTAssertEqual(refreshed.accessToken, "refreshed-token")

        _ = try await client.bootstrapSession(request: DeviceSessionBootstrapRequest(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            deviceKind: .iPhone,
            companionPairId: "REDACTED-SUPPLEMENT-ID-c491e0abab48",
            agreementAcceptances: [],
            capabilities: DeviceCapabilities(notificationAuthorized: false, locationAuthorized: false),
            availableForResponse: false
        ))

        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/auth/apple",
            "/api/v2/auth/session/refresh",
            "/api/v2/session/bootstrap"
        ])
        XCTAssertNil(requests[0].authorization)
        XCTAssertNil(requests[1].authorization)
        XCTAssertEqual(requests[2].authorization, "Bearer [REDACTED]")
        let appleBody = try XCTUnwrap(requests[0].jsonBody)
        XCTAssertEqual(appleBody["identityToken"] as? String, "identity-token")
        XCTAssertEqual(appleBody["nonce"] as? String, "raw-nonce")
        XCTAssertEqual(appleBody["challengeId"] as? String, "REDACTED-SUPPLEMENT-ID-f1c20ffa0fd7")
        XCTAssertEqual(appleBody["authorizationCode"] as? String, "authorization-code")
        XCTAssertNil(appleBody["givenName"])
        XCTAssertNil(appleBody["familyName"])
    }

    func testNearExpiryAccountTokenRefreshesBeforeDeviceBootstrapAndPersistsRotation() async throws {
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let formatter = ISO8601DateFormatter()
        let expiresAt = formatter.string(from: now.addingTimeInterval(3_600))
        let transport = AuthTransport(responses: [
            .json(
                statusCode: 200,
                body: "{\"provider\":\"APPLE\",\"userId\":\"user-1\",\"sessionId\":\"account-2\",\"sessionToken\":\"rotated-account-token\",\"refreshToken\":\"rotated-refresh-token\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"session:bootstrap\"]}"
            ),
            .json(
                statusCode: 201,
                body: "{\"sessionId\":\"device-1\",\"sessionToken\":\"device-token\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"events:read\"]}"
            )
        ])
        let rotatedSessions = RotatedSessionSink()
        let accountSession = AuthSession(
            accessToken: "old-account-token",
            refreshToken: "old-refresh-token",
            expiresAt: now.addingTimeInterval(5),
            userId: "user-1",
            method: .apple,
            serviceBaseURL: "https://example.test/api/v2/"
        )
        let client = APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { now },
            authSession: accountSession,
            onAuthSessionUpdated: { session in
                rotatedSessions.append(session)
            }
        )

        _ = try await client.bootstrapSession(request: DeviceSessionBootstrapRequest(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            deviceKind: .iPhone,
            companionPairId: "REDACTED-SUPPLEMENT-ID-c491e0abab48",
            agreementAcceptances: [],
            capabilities: DeviceCapabilities(notificationAuthorized: false, locationAuthorized: false),
            availableForResponse: false
        ))

        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/auth/session/refresh",
            "/api/v2/session/bootstrap"
        ])
        // Refresh credentials are carried only in the strict request body;
        // the public refresh endpoint intentionally has no bearer auth.
        XCTAssertNil(requests[0].authorization)
        XCTAssertEqual(requests[1].authorization, "Bearer [REDACTED]")
        let refreshBody = try XCTUnwrap(requests[0].jsonBody)
        XCTAssertEqual(refreshBody["refreshToken"] as? String, "old-refresh-token")
        let persisted = rotatedSessions.values()
        XCTAssertEqual(persisted.count, 1)
        XCTAssertEqual(persisted.first?.refreshToken, "rotated-refresh-token")
    }

    func testConcurrentExpiredBootstrapRequestsShareAccountRefreshAndDeviceRotation() async throws {
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let formatter = ISO8601DateFormatter()
        let expiresAt = formatter.string(from: now.addingTimeInterval(3_600))
        let transport = AuthTransport(
            responses: [
                .json(
                    statusCode: 200,
                    body: "{\"provider\":\"APPLE\",\"userId\":\"user-1\",\"sessionToken\":\"rotated-account-token\",\"refreshToken\":\"rotated-refresh-token\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"session:bootstrap\"]}"
                ),
                .json(
                    statusCode: 201,
                    body: "{\"sessionId\":\"device-1\",\"sessionToken\":\"device-token\",\"expiresAt\":\"\(expiresAt)\",\"scopes\":[\"events:read\"]}"
                )
            ],
            delayNanoseconds: 50_000_000
        )
        let accountSession = AuthSession(
            accessToken: "old-account-token",
            refreshToken: "old-refresh-token",
            expiresAt: now.addingTimeInterval(5),
            userId: "user-1",
            method: .apple,
            serviceBaseURL: "https://example.test/api/v2/"
        )
        let client = APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { now },
            authSession: accountSession
        )
        let request = DeviceSessionBootstrapRequest(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            deviceKind: .iPhone,
            companionPairId: "REDACTED-SUPPLEMENT-ID-c491e0abab48",
            agreementAcceptances: [],
            capabilities: DeviceCapabilities(notificationAuthorized: false, locationAuthorized: false),
            availableForResponse: false
        )

        let results = try await withThrowingTaskGroup(of: SessionBootstrapResponse.self) { group in
            group.addTask { try await client.bootstrapSession(request: request) }
            group.addTask { try await client.bootstrapSession(request: request) }
            var values: [SessionBootstrapResponse] = []
            for try await value in group { values.append(value) }
            return values
        }

        XCTAssertEqual(results.count, 2)
        XCTAssertTrue(results.allSatisfy { $0.token == "device-token" })
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/auth/session/refresh",
            "/api/v2/session/bootstrap"
        ])
    }

    private func makeStore(
        scenario: DemoScenario,
        api: TestEmergencyAPIClient = TestEmergencyAPIClient(),
        locationProvider: LocationProvider = LocationProvider(manager: nil),
        agreementStore: TestAgreementStore = TestAgreementStore(state: AgreementState()),
        companionConnectivity: TestCompanionConnectivity = TestCompanionConnectivity(),
        notificationPermissions: TestNotificationPermissions = TestNotificationPermissions(),
        authSessionStore: TestAuthSessionStore,
        authClient: any AuthClient,
        makeStream: @escaping () -> TestEventStream = { TestEventStream() }
    ) -> AppStore {
        AppStore(
            environment: AppEnvironment(
                locationProvider: locationProvider,
                requestInitialLocationAccess: {},
                notificationPermissions: notificationPermissions,
                companionConnectivity: companionConnectivity,
                authSessionStore: authSessionStore,
                agreementStore: agreementStore,
                eventPositionQueueStore: MemoryEventPositionQueueStore(),
                locationSpeaker: TestLocationSpeaker(),
                safeDialer: TestSafeDialer(),
                demoScenarioEngine: DemoScenarioEngine(),
                demoAssignmentFactory: DemoAssignmentFactory(),
                safetyPolicy: .fallback,
                demoScenario: scenario,
                agreementVersions: scenario.agreementVersions,
                deviceInstanceID: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
                companionPairID: "REDACTED-SUPPLEMENT-ID-c491e0abab48",
                configuredServiceBaseURL: "http://127.0.0.1:8787",
                allowsLiveNetworking: true,
                makeAuthClient: { _, _ in authClient },
                makeAPIClient: { _, _, _ in api },
                makeEventStream: { _, _ in makeStream() },
                makeID: { UUID().uuidString },
                now: { Date(timeIntervalSince1970: 1_788_000_100) }
            )
        )
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
                Bundle.main.url(forResource: "demo-scenario", withExtension: "json"),
                "缺少真机测试资源 demo-scenario.json"
            )
        return try JSONDecoder.contractDecoder().decode(
            DemoScenario.self,
            from: Data(contentsOf: url)
        )
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool
    ) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task<Never, Never>.sleep(for: .milliseconds(10))
        }
        XCTFail("等待登录门禁测试状态超时。")
    }

    private func waitUntilAsync(
        _ condition: @escaping @MainActor () async -> Bool
    ) async throws {
        for _ in 0..<100 {
            if await condition() { return }
            try await Task<Never, Never>.sleep(for: .milliseconds(10))
        }
        XCTFail("等待登录门禁测试状态超时。")
    }
}

private actor AuthTransport: APIHTTPTransport {
    struct Response: Sendable {
        let statusCode: Int
        let body: Data

        static func json(statusCode: Int, body: String) -> Response {
            Response(statusCode: statusCode, body: Data(body.utf8))
        }
    }

    struct RecordedRequest: Sendable {
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

    private var responses: [Response]
    private var recorded: [RecordedRequest] = []

    private let delayNanoseconds: UInt64

    init(responses: [Response], delayNanoseconds: UInt64 = 0) {
        self.responses = responses
        self.delayNanoseconds = delayNanoseconds
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url, !responses.isEmpty else {
            throw APIClientError.invalidResponse
        }
        if delayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: delayNanoseconds)
        }
        recorded.append(RecordedRequest(
            path: url.path,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: request.httpBody
        ))
        let response = responses.removeFirst()
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

    func requests() -> [RecordedRequest] { recorded }
}

private final class RotatedSessionSink: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [AuthSession] = []

    func append(_ session: AuthSession) {
        lock.lock()
        stored.append(session)
        lock.unlock()
    }

    func values() -> [AuthSession] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

@MainActor
private final class TestCompanionConnectivity: CompanionConnectivityActivating {
    private(set) var activationCount = 0
    private(set) var deactivationCount = 0

    func activate() { activationCount += 1 }
    func deactivate() { deactivationCount += 1 }
}

private final class TestAgreementStore: @unchecked Sendable, AgreementPersisting {
    private var state: AgreementState

    init(state: AgreementState) { self.state = state }
    func load() -> AgreementState { state }
    func save(_ state: AgreementState) { self.state = state }
}

@MainActor
private final class TestNotificationPermissions: NotificationPermissionRequesting {
    var blockRequest = false
    var pendingRequest: CheckedContinuation<Bool, Never>?
    func releaseRequest() { pendingRequest?.resume(returning: true); pendingRequest = nil }
    private(set) var requestCount = 0
    private(set) var currentAuthorizationQueryCount = 0
    var cachedAuthorizationGranted: Bool { true }
    func requestAuthorization() async throws -> Bool {
        requestCount += 1
        if blockRequest {
            return await withCheckedContinuation { pendingRequest = $0 }
        }
        return true
    }
    func currentAuthorizationGranted() async -> Bool {
        currentAuthorizationQueryCount += 1
        return true
    }
}

@MainActor
private final class TestLocationSpeaker: LocationCardSpeaking {
    func speak(_ card: PatientLocationCard) {}
    func stop() {}
}

@MainActor
private struct TestSafeDialer: SafeDialing {
    func open(policy: SafetyPolicy) async throws {}
}

private actor TestEmergencyAPIClient: EmergencyAPIClient, SessionLogoutClient {
    private var bootstrapCount = 0

    func bootstrapSession(request: DeviceSessionBootstrapRequest) async throws -> SessionBootstrapResponse {
        bootstrapCount += 1
        return SessionBootstrapResponse(
            sessionId: "test-device-session",
            token: "test-device-token",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            scopes: ["events:read"]
        )
    }
    func bootstrapRequestCount() -> Int { bootstrapCount }
    func listEvents() async throws -> [EmergencyEvent] { [] }
    func event(id: String) async throws -> EmergencyEvent { throw APIClientError.invalidResponse }
    func submitEnd(eventID: String, request: EventEndRequest) async throws -> EmergencyEvent { throw APIClientError.invalidResponse }
    func confirmFalseAlarm(eventID: String) async throws -> EmergencyEvent { throw APIClientError.invalidResponse }
    func resolveEvent(eventID: String, resolutionID: String, actor: ResolutionActor, resolvedAt: Date) async throws -> EmergencyEvent {
        throw APIClientError.invalidResponse
    }
    func continueStatusConfirmation(
        eventID: String,
        confirmationID: String,
        respondedAt: Date
    ) async throws -> StatusConfirmationResult {
        throw APIClientError.invalidResponse
    }
    func sendReceipt(eventID: String, deliveryID: String, status: DeliveryStatus, occurredAt: Date) async throws {}
    func revokeDeviceSession() async throws {}
    func revokeAccountSession() async throws {}
    func respond(eventID: String, deliveryID: String, accept: Bool, decidedAt: Date) async throws -> RespondResult {
        throw APIClientError.invalidResponse
    }
    func reportAedUnavailable(reportID: String, eventID: String, assignmentID: String, aedID: String, reportedAt: Date, reason: String) async throws {}
    func reportAedAcquired(_ receipt: AedAcquiredReceipt) async throws -> AedAcquiredReceipt { receipt }
    func updateAssignmentStatus(eventID: String, assignmentID: String, status: AssignmentStatus, occurredAt: Date) async throws -> Assignment {
        throw APIClientError.invalidResponse
    }
    func timeline(eventID: String) async throws -> [TimelineEntry] { [] }
    func fetchPresence() async throws -> DevicePresence { throw APIClientError.invalidResponse }
    func updatePresence(_ update: DevicePresenceUpdate) async throws -> DevicePresence { throw APIClientError.invalidResponse }
    func updateResponderPosition(_ update: ResponderPositionUpdate) async throws -> PositionUpdateResult { throw APIClientError.invalidResponse }
    func updatePatientPosition(eventID: String, update: PatientPositionUpdate) async throws -> PositionUpdateResult { throw APIClientError.invalidResponse }
    func sendEventPositionBatch(
        eventID: String,
        batchID: String,
        batch: EventPositionBatch
    ) async throws -> EventPositionBatchAck {
        throw APIClientError.invalidResponse
    }
    func fetchAeds() async throws -> [Aed] { [] }
    func estimateRoute(responderPosition: ResponderPosition, patientPosition: PatientPosition, at: Date) async throws -> AedRoute {
        throw APIClientError.invalidResponse
    }
}

@MainActor
private final class TestEventStream: EventStreamClient {
    var onEvent: ((RealtimeEvent) -> Void)?
    private(set) var connectCount = 0
    private(set) var disconnectCount = 0

    func connect() { connectCount += 1 }
    func disconnect() { disconnectCount += 1 }
    func send(_ event: RealtimeEvent) { onEvent?(event) }
}
