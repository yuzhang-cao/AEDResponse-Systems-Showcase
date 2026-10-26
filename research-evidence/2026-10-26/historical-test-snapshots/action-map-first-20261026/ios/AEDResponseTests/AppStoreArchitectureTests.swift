import CoreLocation
import Foundation
import XCTest
@testable import AEDResponse

private struct ClientRouteTestCalculator {
    let calculate: @MainActor (ClientAedRouteContext) async throws -> [ClientAedRouteDistance]
}

@MainActor
private final class ResponseDecisionTestClock {
    var date: Date
    init(date: Date) { self.date = date }
}

@MainActor
final class AppStoreArchitectureTests: XCTestCase {
    func testPushTokenIsGatedByDeviceSessionAndStopsAtLogout() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let store = makeAcceptedStore(scenario: scenario, api: api)
        defer { store.disconnect() }
        let token = PushTokenRequest(pushToken: "first", pushEnvironment: "SANDBOX", bundleId: "example.test")
        store.receiveRemoteNotificationToken(token)
        var records = await api.recordedPushTokens()
        XCTAssertTrue(records.isEmpty)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        try await waitUntil { await api.recordedPushTokens().count == 1 }
        store.logout()
        store.receiveRemoteNotificationToken(PushTokenRequest(pushToken: "after-logout", pushEnvironment: "SANDBOX", bundleId: "example.test"))
        store.remoteNotificationTapped(messageID: "old-message")
        try await Task.sleep(for: .milliseconds(40))
        records = await api.recordedPushTokens()
        XCTAssertEqual(records, [token])
        let routes = await api.recordedPushRoutes()
        XCTAssertTrue(routes.isEmpty)
    }

    func testPushRegistrationFailureIsNonblockingAndClearsOnlyAfterServerRegistration() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let store = makeAcceptedStore(scenario: scenario, api: api)
        defer { store.disconnect() }
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        let previousError = store.lastError
        store.remoteNotificationRegistrationFailed()
        store.remoteNotificationRegistrationFailed()
        XCTAssertNotNil(store.backgroundReminderIssue)
        XCTAssertEqual(store.lastError, previousError)
        XCTAssertTrue(store.isAuthenticated)
        store.receiveRemoteNotificationToken(PushTokenRequest(
            pushToken: "recovered", pushEnvironment: "SANDBOX", bundleId: "example.test"))
        try await waitUntil { await api.recordedPushTokens().count == 1 && store.backgroundReminderIssue == nil }
        store.remoteNotificationRegistrationFailed()
        XCTAssertNotNil(store.backgroundReminderIssue)
        store.receiveRemoteNotificationToken(PushTokenRequest(
            pushToken: "recovered", pushEnvironment: "SANDBOX", bundleId: "example.test"))
        XCTAssertNil(store.backgroundReminderIssue)
        let registrations = await api.recordedPushTokens()
        XCTAssertEqual(registrations.count, 1)
    }

    func testPushTapReadsServerRouteWithoutAcceptingAnOffer() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let store = makeAcceptedStore(scenario: scenario, api: api)
        defer { store.disconnect() }
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        store.remoteNotificationTapped(messageID: "old-message")
        try await waitUntil { await api.recordedPushRoutes().count == 1 }
        XCTAssertNil(store.responseRequest)
        XCTAssertTrue(store.visibleEvents.isEmpty)
    }

    func testRESTSnapshotAndQueuedPushTapDoNotWaitForSocketReady() async throws {
        let scenario = try loadScenario()
        let patient = makeEvent(scenario: scenario, viewerRelationship: .patient)
        let api = FakeEmergencyAPIClient(events: [patient])
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api, makeStream: { stream })
        defer { store.disconnect() }
        store.remoteNotificationTapped(messageID: "queued-before-bootstrap")
        let beforeBootstrap = await api.recordedPushRoutes()
        XCTAssertTrue(beforeBootstrap.isEmpty)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        // No .connected Socket event is emitted by this transport.
        try await waitUntil {
            let routeCount = await api.recordedPushRoutes().count
            return store.currentEvent?.id == patient.id
                && store.positionPublishingMode == .patient(eventID: patient.id)
                && routeCount == 1
        }
        XCTAssertEqual(store.connectionState, .connecting)
    }

    func testActivePatientAndResponderCannotLogoutOrCloseAccountLocally() async throws {
        for relationship in [ViewerRelationship.patient, .responder] {
            let scenario = try loadScenario()
            let event = makeEvent(scenario: scenario, viewerRelationship: relationship)
            let api = FakeEmergencyAPIClient(events: [event])
            let store = makeAcceptedStore(scenario: scenario, api: api)
            defer { store.disconnect() }
            _ = await store.connect(baseURL: "http://127.0.0.1:8787")
            store.applyServerSnapshot([event])
            XCTAssertTrue(store.hasActiveRescueParticipation)
            store.logout()
            store.deleteAccount()
            XCTAssertTrue(store.isAuthenticated)
            XCTAssertTrue(store.lastError?.contains("正在参与救助") == true)
            let attempts = await api.recordedAccountDeletions()
            XCTAssertEqual(attempts, 0)
        }
    }

    func testEndRetryPreservesOperationIdentity() async throws {
        let scenario = try loadScenario()
        let event = makeEvent(scenario: scenario, viewerRelationship: .patient)
        let api = FakeEmergencyAPIClient(events: [event])
        let store = makeAcceptedStore(scenario: scenario, api: api)
        defer { store.disconnect() }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        store.applyServerSnapshot([event])
        await api.failNextResolution()
        store.resolveCurrentEvent()
        try await waitUntil { await api.resolutionAttemptRecords().count == 1 && store.lastError != nil }
        store.resolveCurrentEvent()
        try await waitUntil { await api.resolutionAttemptRecords().count == 2 }
        let requests = await api.resolutionAttemptRecords()
        XCTAssertEqual(requests[0], requests[1])
    }

    func testUnconfirmedEndCannotBeBypassedByLogout() async throws {
        let scenario = try loadScenario()
        let event = makeEvent(scenario: scenario, viewerRelationship: .patient)
        let api = FakeEmergencyAPIClient(events: [event])
        let store = makeAcceptedStore(scenario: scenario, api: api)
        defer { store.disconnect() }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        store.applyServerSnapshot([event])
        await api.suspendNextResolution()
        store.resolveCurrentEvent()
        try await waitUntil { await api.isResolutionSuspended() }
        store.logout()
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertTrue(store.lastError?.contains("正在参与救助") == true)
        await api.releaseResolution()
        try await waitUntil { store.currentEvent?.state.isTerminal == true }
        store.logout()
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertTrue(store.visibleEvents.isEmpty)
    }

    func testAutomaticConnectionStartsOnceWithoutManualConnect() async throws {
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: try loadScenario(), api: api,
            automaticallyConnectOnReady: true, makeStream: { stream }
        )
        defer { store.disconnect() }
        for _ in 0..<4 { store.appDidBecomeActive() }
        try await waitUntil { stream.connectCount == 1 }
        stream.send(.connected)
        try await waitUntil { store.connectionState == .connected }
        for _ in 0..<4 { store.appDidBecomeActive() }
        try await Task.sleep(for: .milliseconds(80))
        let count = await api.bootstrapRequestCount()
        XCTAssertEqual(count, 1)
        XCTAssertEqual(stream.connectCount, 1)
    }

    func testAutomaticConnectionPreservesAllGatesAndOfflineIsolation() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stores = [
            makeStore(scenario: scenario, api: api, authSessionStore: TestAuthSessionStore(session: nil),
                automaticallyConnectOnReady: true),
            makeStore(scenario: scenario, api: api, automaticallyConnectOnReady: true),
            makeAcceptedStore(scenario: scenario, api: api, allowsLiveNetworking: false,
                automaticallyConnectOnReady: true),
            makeAcceptedStore(scenario: scenario, api: api,
                notificationPermissions: FakeNotificationPermissions(granted: false),
                automaticallyConnectOnReady: true),
            makeAcceptedStore(scenario: scenario, api: api, locationProvider: LocationProvider(manager: nil,
                authorizationStatusOverride: .authorizedWhenInUse, accuracyAuthorizationOverride: .fullAccuracy),
                automaticallyConnectOnReady: true),
            makeAcceptedStore(scenario: scenario, api: api, locationProvider: LocationProvider(manager: nil,
                authorizationStatusOverride: .authorizedAlways, accuracyAuthorizationOverride: .reducedAccuracy),
                automaticallyConnectOnReady: true)
        ]
        defer { stores.forEach { $0.disconnect() } }
        stores.forEach { $0.appDidBecomeActive() }
        try await Task.sleep(for: .milliseconds(100))
        let count = await api.bootstrapRequestCount()
        XCTAssertEqual(count, 0)
        XCTAssertFalse(AppEnvironment.production().automaticallyConnectOnReady)
    }

    func testAutomaticConnectionStartsAfterPermissionBecomesEligible() async throws {
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let location = LocationProvider(manager: nil,
            authorizationStatusOverride: .authorizedWhenInUse, accuracyAuthorizationOverride: .fullAccuracy)
        let store = makeAcceptedStore(scenario: try loadScenario(), api: api, locationProvider: location,
            automaticallyConnectOnReady: true, makeStream: { stream })
        defer { store.disconnect() }
        let before = await api.bootstrapRequestCount()
        XCTAssertEqual(before, 0)
        location.simulateAuthorizationChange(status: .authorizedAlways, accuracy: .fullAccuracy)
        try await waitUntil { stream.connectCount == 1 }
        let after = await api.bootstrapRequestCount()
        XCTAssertEqual(after, 1)
    }

    func testAutomaticConnectionRetriesInitialFailureWithoutForegroundDuplicates() async throws {
        let api = FakeEmergencyAPIClient()
        await api.failNextBootstrapRequests(1)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: try loadScenario(), api: api,
            automaticallyConnectOnReady: true, makeStream: { stream })
        defer { store.disconnect() }
        try await waitUntil { await api.bootstrapRequestCount() == 1 }
        for _ in 0..<4 { store.appDidBecomeActive() }
        try await waitUntil { stream.connectCount == 1 }
        let count = await api.bootstrapRequestCount()
        XCTAssertEqual(count, 2)
    }

    func testAutomaticConnectionCancelledByImmediateLogout() async throws {
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: try loadScenario(), api: api,
            automaticallyConnectOnReady: true, makeStream: { stream })
        store.logout()
        store.appDidBecomeActive()
        try await Task.sleep(for: .milliseconds(80))
        let count = await api.bootstrapRequestCount()
        XCTAssertEqual(count, 0)
        XCTAssertEqual(stream.connectCount, 0)
        XCTAssertFalse(store.isAuthenticated)
    }

    func testAutomaticConnectionCannotOpenSocketAfterLogoutDuringBootstrap() async throws {
        let api = FakeEmergencyAPIClient()
        await api.suspendNextBootstrapRequest()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: try loadScenario(), api: api,
            automaticallyConnectOnReady: true, makeStream: { stream })
        try await waitUntil { await api.isBootstrapSuspended() }
        store.logout()
        await api.releaseBootstrapRequest()
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(stream.connectCount, 0)
        XCTAssertEqual(store.connectionState, .disconnected)
        XCTAssertFalse(store.isAuthenticated)
    }

    func testUnauthenticatedStoreDoesNotStartBusinessServices() async throws {
        let scenario = try loadScenario()
        let connectivity = FakeCompanionConnectivityActivator()
        let notifications = FakeNotificationPermissions(granted: true)
        let authStore = TestAuthSessionStore(session: nil)
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        var locationRequestCount = 0
        let locationProvider = LocationProvider(manager: nil)
        let store = makeStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            notificationPermissions: notifications,
            requestLocation: { locationRequestCount += 1 },
            companionConnectivity: connectivity,
            authSessionStore: authStore,
            makeStream: { stream }
        )

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertFalse(store.isOnboardingComplete)
        XCTAssertEqual(connectivity.activationCount, 0)
        XCTAssertFalse(locationProvider.isContinuousUpdating)
        XCTAssertEqual(locationRequestCount, 0)
        XCTAssertEqual(notifications.requestCount, 0)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertFalse(connected)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 0)
        XCTAssertEqual(stream.connectCount, 0)
        XCTAssertFalse(store.visibleEvents.count > 0)
    }

    func testLogoutStopsLiveBusinessAndClearsIdentityState() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let connectivity = FakeCompanionConnectivityActivator()
        let agreements = FakeAgreementStore(
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
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let locationProvider = LocationProvider(manager: nil)
        let store = makeStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            agreementStore: agreements,
            companionConnectivity: connectivity,
            authSessionStore: authStore,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.connectionState == .connected }

        store.logout()

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(authStore.load())
        XCTAssertEqual(store.connectionState, .disconnected)
        XCTAssertFalse(locationProvider.isContinuousUpdating)
        XCTAssertTrue(store.visibleEvents.isEmpty)
        XCTAssertFalse(store.isOnboardingComplete)
        XCTAssertTrue(agreements.load().isComplete)
        try await waitUntil {
            await api.recordedLogoutOperations() == ["device", "account"]
        }
    }

    func testWhenInUseLocationCannotOpenBusinessGate() async throws {
        let scenario = try loadScenario()
        let locationProvider = LocationProvider(
            manager: nil,
            authorizationStatusOverride: .authorizedWhenInUse,
            accuracyAuthorizationOverride: .fullAccuracy
        )
        let connectivity = FakeCompanionConnectivityActivator()
        let api = FakeEmergencyAPIClient()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            allowsLiveNetworking: true,
            companionConnectivity: connectivity
        )

        XCTAssertFalse(store.isBusinessAccessReady)
        XCTAssertEqual(connectivity.activationCount, 0)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertFalse(connected)
        XCTAssertFalse(locationProvider.isContinuousUpdating)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 0)
    }

    func testReducedAccuracyCannotOpenBusinessGate() async throws {
        let scenario = try loadScenario()
        let locationProvider = LocationProvider(
            manager: nil,
            authorizationStatusOverride: .authorizedAlways,
            accuracyAuthorizationOverride: .reducedAccuracy
        )
        let connectivity = FakeCompanionConnectivityActivator()
        let api = FakeEmergencyAPIClient()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            allowsLiveNetworking: true,
            companionConnectivity: connectivity
        )

        XCTAssertFalse(store.isBusinessAccessReady)
        XCTAssertEqual(connectivity.activationCount, 0)
        XCTAssertFalse(locationProvider.isContinuousUpdating)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertFalse(connected)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 0)
    }

    func testDeniedNotificationsCannotOpenBusinessGate() async throws {
        let scenario = try loadScenario()
        let notifications = FakeNotificationPermissions(granted: false)
        let connectivity = FakeCompanionConnectivityActivator()
        let api = FakeEmergencyAPIClient()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            allowsLiveNetworking: true,
            companionConnectivity: connectivity,
            notificationPermissions: notifications
        )

        XCTAssertFalse(store.isBusinessAccessReady)
        XCTAssertEqual(connectivity.activationCount, 0)
        XCTAssertEqual(notifications.requestCount, 0)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertFalse(connected)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 0)
    }

    func testLocationAuthorizationDowngradeStopsLiveBusinessImmediately() async throws {
        let scenario = try loadScenario()
        let locationProvider = LocationProvider(manager: nil)
        let connectivity = FakeCompanionConnectivityActivator()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            locationProvider: locationProvider,
            allowsLiveNetworking: true,
            companionConnectivity: connectivity,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.connectionState == .connected
                && locationProvider.isContinuousUpdating
        }
        XCTAssertTrue(locationProvider.isContinuousUpdating)

        locationProvider.simulateAuthorizationChange(
            status: .authorizedWhenInUse,
            accuracy: .fullAccuracy
        )
        try await waitUntil {
            store.connectionState == .disconnected
                && !locationProvider.isContinuousUpdating
        }
        XCTAssertEqual(connectivity.deactivationCount, 1)
    }

    func testForegroundNotificationRevocationStopsLiveBusiness() async throws {
        let scenario = try loadScenario()
        let notifications = FakeNotificationPermissions(granted: true)
        let connectivity = FakeCompanionConnectivityActivator()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            allowsLiveNetworking: true,
            companionConnectivity: connectivity,
            notificationPermissions: notifications,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.connectionState == .connected }

        notifications.granted = false
        store.appDidBecomeActive()
        try await waitUntil {
            store.connectionState == .disconnected
                && !store.isBusinessAccessReady
        }
        XCTAssertEqual(connectivity.deactivationCount, 1)
    }

    func testAccountBearerCannotBeSentToDifferentIssuer() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            makeStream: { stream }
        )

        let hostMismatch = await store.connect(baseURL: "http://localhost:8787")
        XCTAssertFalse(hostMismatch)
        let pathMismatch = await store.connect(baseURL: "http://127.0.0.1:8787/custom")
        XCTAssertFalse(pathMismatch)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 0)
        XCTAssertEqual(stream.connectCount, 0)
        XCTAssertNotNil(store.lastError)
    }

    func testCompanionTicketIsRequestedOnlyAfterDeviceSessionAndReachableWatch() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let connectivity = FakeCompanionConnectivityActivator()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            companionConnectivity: connectivity
        )

        connectivity.setState(
            CompanionConnectivityState(
                activationState: .activated,
                watchReachable: true
            )
        )
        XCTAssertTrue(connectivity.sentEnvelopes.isEmpty)

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        try await waitUntil {
            connectivity.sentEnvelopes.count == 1
        }

        let envelope = try XCTUnwrap(connectivity.sentEnvelopes.first)
        XCTAssertEqual(envelope.baseURL, TestAuthSessionStore.fixtureSession.serviceBaseURL)
        XCTAssertEqual(envelope.companionPairId, "REDACTED-SUPPLEMENT-ID-c491e0abab48")
        XCTAssertTrue(envelope.companionLinkTicket.contains("ticket-1"))
        XCTAssertTrue(envelope.expiresAt > Date(timeIntervalSince1970: 1_788_000_100))
        let ticketRequestCount = await api.companionLinkTicketRequestCount()
        XCTAssertEqual(ticketRequestCount, 1)
    }

    func testIPhoneDoesNotActivateCompanionBeforeAllOnboardingGates() throws {
        let scenario = try loadScenario()
        let connectivity = FakeCompanionConnectivityActivator()

        _ = makeStore(scenario: scenario, companionConnectivity: connectivity)

        XCTAssertEqual(connectivity.activationCount, 0)
    }

    func testOnboardingPersistsFourConsentsAndRequestsPermissions() async throws {
        let scenario = try loadScenario()
        let agreements = FakeAgreementStore(state: AgreementState())
        let notifications = FakeNotificationPermissions(granted: true)
        var locationRequestCount = 0
        let store = makeStore(
            scenario: scenario,
            agreementStore: agreements,
            notificationPermissions: notifications,
            requestLocation: { locationRequestCount += 1 }
        )

        let completed = await store.completeOnboarding(
            patientAgreementAccepted: true,
            responderAgreementAccepted: true,
            privacyPolicyAccepted: true,
            sensitivePersonalInformationAccepted: true
        )

        XCTAssertTrue(completed)
        XCTAssertTrue(store.isOnboardingComplete)
        XCTAssertNotNil(store.agreementState.patientAcceptedAt)
        XCTAssertNotNil(store.agreementState.responderAcceptedAt)
        XCTAssertNotNil(store.agreementState.privacyPolicyAcceptedAt)
        XCTAssertNotNil(store.agreementState.sensitivePersonalInformationAcceptedAt)
        XCTAssertEqual(agreements.load(), store.agreementState)
        XCTAssertEqual(locationRequestCount, 1)
        XCTAssertEqual(notifications.requestCount, 1)
        XCTAssertTrue(store.notificationPermissionRequested)
        XCTAssertTrue(store.notificationPermissionGranted)
    }

    func testOnboardingRequiresSeparateAgreementAcceptance() async throws {
        let store = makeStore(scenario: try loadScenario())

        let completed = await store.completeOnboarding(
            patientAgreementAccepted: true,
            responderAgreementAccepted: false,
            privacyPolicyAccepted: true,
            sensitivePersonalInformationAccepted: true
        )
        XCTAssertFalse(completed)
        XCTAssertFalse(store.isOnboardingComplete)
    }

    func testLocalTestHostScenariosDerivePatientAndResponderRoles() throws {
        let scenario = try loadScenario()
        let store = makeAcceptedStore(scenario: scenario)

        store.applyLocalTestScenario(.patient)
        XCTAssertEqual(store.activeLocalTestScenario, .patient)
        XCTAssertEqual(store.runtimeRole, .patient)
        XCTAssertEqual(store.currentEvent?.viewerRelationship, .patient)
        XCTAssertNil(store.assignment)

        store.applyLocalTestScenario(.responderGoToPatient)
        XCTAssertEqual(store.activeLocalTestScenario, .responderGoToPatient)
        XCTAssertEqual(store.runtimeRole, .responder)
        XCTAssertFalse(store.visibleEvents.contains { $0.viewerRelationship == .patient })
        XCTAssertEqual(store.assignment?.role, .goToPatient)
        XCTAssertNil(store.assignment?.route)

        store.applyLocalTestScenario(.responderFetchAed)
        XCTAssertEqual(store.activeLocalTestScenario, .responderFetchAed)
        XCTAssertEqual(store.runtimeRole, .responder)
        XCTAssertEqual(store.assignment?.role, .fetchAed)
        XCTAssertEqual(store.assignment?.route?.pathKinds, [.responder, .aed, .patient])

        store.applyLocalTestScenario(.responseRequest)
        XCTAssertEqual(store.runtimeRole, .neutral)
        XCTAssertNotNil(store.responseRequest)
        XCTAssertNil(store.assignment)

        store.applyLocalTestScenario(.neutral)
        XCTAssertEqual(store.runtimeRole, .neutral)
        XCTAssertTrue(store.visibleEvents.isEmpty)
        XCTAssertNil(store.responseRequest)

        store.endLocalTestScenario()
        XCTAssertNil(store.activeLocalTestScenario)
        XCTAssertEqual(store.connectionState, .disconnected)
    }

    func testLocalTestHostScenarioCannotConnectOrBootstrapBackend() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }
        store.applyLocalTestScenario(.patient)

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")

        XCTAssertFalse(connected)
        XCTAssertEqual(store.connectionState, .disconnected)
        XCTAssertTrue(store.lastError?.contains("本地测试场景") == true)
        let bootstrapCount = await api.bootstrapRequestCount()
        let responderUpdateCount = await api.responderPositionUpdates().count
        let patientUpdateCount = await api.patientUpdates().count
        let presenceUpdateCount = await api.presenceUpdateCount()
        XCTAssertEqual(bootstrapCount, 0)
        XCTAssertEqual(responderUpdateCount, 0)
        XCTAssertEqual(patientUpdateCount, 0)
        XCTAssertEqual(presenceUpdateCount, 0)
        XCTAssertEqual(stream.connectCount, 0)
        XCTAssertFalse(store.locationProvider.isContinuousUpdating)
    }

    func testOfflineFixtureAcceptsWithoutUploadingOrAcknowledgingRealReceipts() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let retained = PendingDeliveryReceipt(
            context: DeliveryReceiptQueueContext(
                serviceNamespace: "https://api.example.test/api/v2/",
                userID: "retained-user", deviceInstanceID: "retained-device"
            ),
            eventID: "retained-event", deliveryID: "retained-delivery",
            status: .viewed, occurredAt: Date(timeIntervalSince1970: 1_788_000_100)
        )
        let receipts = MemoryDeliveryReceiptQueueStore(records: [retained])
        let store = makeAcceptedStore(
            scenario: scenario, api: api, allowsLiveNetworking: false,
            deliveryReceiptQueueStore: receipts
        )
        defer { store.disconnect() }
        try await waitUntil { store.isAuthenticated && !store.isRestoringAuthentication }

        store.applyLocalTestScenario(.responseRequest)
        let request = try XCTUnwrap(store.responseRequest)
        XCTAssertEqual(store.deliveryStatus, .delivered)
        store.markResponseRequestViewed()
        XCTAssertEqual(store.deliveryStatus, .viewed)
        XCTAssertFalse(store.isAwaitingResponseViewReceipt)
        store.acceptResponseRequest()

        XCTAssertEqual(store.runtimeRole, .responder)
        XCTAssertEqual(store.assignment?.eventId, request.eventId)
        XCTAssertFalse(store.isSubmittingResponseDecision)
        XCTAssertEqual(try receipts.load(), [retained], "A fixture must neither append nor acknowledge real upload facts.")
        let receiptAttempts = await api.receiptAttemptRecords()
        let decisions = await api.responseDecisionAttemptRecords()
        let bootstraps = await api.bootstrapRequestCount()
        XCTAssertTrue(receiptAttempts.isEmpty)
        XCTAssertTrue(decisions.isEmpty)
        XCTAssertEqual(bootstraps, 0)
    }

    func testTestHostProductionEnvironmentCannotStartAnyLiveTransport() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let locationProvider = LocationProvider(manager: nil)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            allowsLiveNetworking: false
        ) { stream }
        store.applyPatientActivation(eventID: "testhost-offline-patient")

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")

        XCTAssertFalse(connected)
        XCTAssertEqual(store.connectionState, .disconnected)
        XCTAssertTrue(store.lastError?.contains("TestHost") == true)
        let bootstrapCount = await api.bootstrapRequestCount()
        let responderPositionCount = await api.responderPositionUpdates().count
        let patientPositionCount = await api.patientUpdates().count
        let presenceCount = await api.presenceUpdateCount()
        XCTAssertEqual(bootstrapCount, 0)
        XCTAssertEqual(responderPositionCount, 0)
        XCTAssertEqual(patientPositionCount, 0)
        XCTAssertEqual(presenceCount, 0)
        XCTAssertEqual(stream.connectCount, 0)
        XCTAssertFalse(locationProvider.isContinuousUpdating)
    }

    func testLocalTestHostScenarioCannotStartAfterLiveConnectionAttempt() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        XCTAssertTrue(store.hasAttemptedLiveConnectionInProcess)

        store.applyLocalTestScenario(.patient)

        XCTAssertNil(store.activeLocalTestScenario)
        XCTAssertEqual(store.runtimeRole, .neutral)
        XCTAssertTrue(store.visibleEvents.isEmpty)
        XCTAssertTrue(store.lastError?.contains("在途请求") == true)
        let bootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(bootstrapCount, 1)
        store.disconnect()
    }

    func testAuthenticatedBootstrapCarriesFourAgreementsAndNoCredentials() async throws {
        let scenario = try loadScenario()
        let acceptedAt = Date(timeIntervalSince1970: 1_788_000_000)
        let agreements = FakeAgreementStore(
            state: AgreementState(
                patientAcceptedAt: acceptedAt,
                responderAcceptedAt: acceptedAt,
                privacyPolicyAcceptedAt: acceptedAt,
                sensitivePersonalInformationAcceptedAt: acceptedAt,
                patientAcceptedVersion: "2.0",
                responderAcceptedVersion: "2.0",
                privacyPolicyAcceptedVersion: "2.0",
                sensitivePersonalInformationAcceptedVersion: "2.0"
            )
        )
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeStore(
            scenario: scenario,
            api: api,
            agreementStore: agreements,
            makeStream: { stream }
        )

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        let capturedRequest = await api.firstBootstrapRequest()
        let request = try XCTUnwrap(capturedRequest)
        XCTAssertEqual(request.deviceKind, .iPhone)
        XCTAssertEqual(Set(request.agreementAcceptances?.map(\.kind) ?? []), [
            .patient,
            .volunteerResponder,
            .privacyPolicy,
            .sensitivePersonalInformation
        ])
        XCTAssertNotNil(UUID(uuidString: request.deviceInstanceId))
        XCTAssertNotNil(UUID(uuidString: request.companionPairId ?? ""))
        XCTAssertEqual(request.capabilities?.notificationAuthorized, true)
        XCTAssertEqual(request.capabilities?.locationAuthorized, false)
        XCTAssertEqual(request.availableForResponse, false)

        let encoded = String(
            data: try JSONEncoder.contractEncoder().encode(request),
            encoding: .utf8
        ) ?? ""
        XCTAssertFalse(encoded.lowercased().contains("username"))
        XCTAssertFalse(encoded.lowercased().contains("password"))
    }

    func testRepeatedConnectTearsDownOldSessionAndWaitsForSocketReady() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        var streams: [FakeEventStream] = []
        let store = makeAcceptedStore(scenario: scenario, api: api) {
            let stream = FakeEventStream()
            streams.append(stream)
            return stream
        }

        let firstConnected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(firstConnected)
        XCTAssertEqual(store.connectionState, .connecting)
        let secondConnected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(secondConnected)
        XCTAssertEqual(streams.count, 2)
        XCTAssertEqual(streams[0].disconnectCount, 1)
        XCTAssertNil(streams[0].onEvent)

        streams[1].send(.connected)
        XCTAssertEqual(store.connectionState, .connected)
    }

    func testConnectAndLocationChangesPublishStrictResponderPositionThroughRest() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let firstObservedAt = Date(timeIntervalSince1970: 1_788_000_000)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: firstObservedAt,
            to: locationProvider
        )
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            await api.responderPositionUpdates().count == 1
        }
        // Bootstrap and Socket readiness may each force a valid restore Presence.
        try await waitUntil { await api.presenceUpdateCount() >= 1 }
        var updates = await api.responderPositionUpdates()
        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates[0].position.kind, .responder)
        XCTAssertEqual(updates[0].position.latitude, 22.198)
        XCTAssertEqual(updates[0].position.accuracyMeters, 9)
        XCTAssertEqual(updates[0].observedAt, firstObservedAt)
        XCTAssertNotNil(UUID(uuidString: updates[0].id))
        XCTAssertEqual(store.positionPublishingMode, .responder)
        XCTAssertTrue(locationProvider.isContinuousUpdating)
        let presence = await api.recordedPresenceUpdates()
        XCTAssertNotNil(UUID(uuidString: presence[0].presenceUpdateId))
        XCTAssertTrue(presence[0].capabilities.notificationAuthorized)
        XCTAssertFalse(presence[0].capabilities.locationAuthorized)

        let secondObservedAt = Date(timeIntervalSince1970: 1_788_000_050)
        publishLocation(
            latitude: 22.1985,
            longitude: 113.5435,
            accuracyMeters: 6,
            observedAt: secondObservedAt,
            to: locationProvider
        )
        try await Task.sleep(for: .milliseconds(100))
        let suppressedUpdates = await api.responderPositionUpdates()
        XCTAssertEqual(suppressedUpdates.count, 1, "Standby must suppress movement under 100 m before 120 s")
        let thirdObservedAt = secondObservedAt.addingTimeInterval(1)
        publishLocation(
            latitude: 22.1995,
            longitude: 113.5445,
            accuracyMeters: 6,
            observedAt: thirdObservedAt,
            to: locationProvider
        )
        try await waitUntil {
            await api.responderPositionUpdates().count == 2
        }
        updates = await api.responderPositionUpdates()
        XCTAssertEqual(updates[1].position.kind, .responder)
        XCTAssertEqual(updates[1].position.latitude, 22.1995)
        XCTAssertEqual(updates[1].observedAt, thirdObservedAt)
    }

    func testUnconfirmedPatientHintIsDiscardedByInitialRestSnapshot() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        store.applyPatientActivation(eventID: "patient-location-suppression")
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { await api.responderPositionUpdates().count == 1 }
        XCTAssertEqual(store.positionPublishingMode, .responder)
        XCTAssertNil(store.pendingPatientEventID)
        publishLocation(
            latitude: 22.199,
            longitude: 113.544,
            accuracyMeters: 7,
            observedAt: Date(timeIntervalSince1970: 1_788_000_050),
            to: locationProvider
        )
        try await waitUntil { await api.responderPositionUpdates().count == 2 }

        let responderUpdates = await api.responderPositionUpdates()
        let patientUpdates = await api.patientUpdates()
        XCTAssertEqual(responderUpdates.count, 2)
        XCTAssertTrue(patientUpdates.isEmpty)
        XCTAssertEqual(responderUpdates.last?.position.latitude, 22.199)
    }

    func testLiveRoleTransitionInvalidatesResponderModeBeforePublishingPatientSample() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )
        try await waitUntil { await api.responderPositionUpdates().count == 1 }

        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-live-patient",
                viewerRelationship: .patient,
                canPublishEventPosition: true,
                eventPositionParticipationStartedAt: Date(timeIntervalSince1970: 1_788_000_101)
            )
        ])
        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.199,
            longitude: 113.544,
            accuracyMeters: 7,
            observedAt: Date(timeIntervalSince1970: 1_788_000_101),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > eventBatchCount }
        for offset in 0..<5 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: Date(timeIntervalSince1970: 1_788_000_101 + TimeInterval(offset))
            ))
        }
        try await waitUntil { await api.eventPositionBatchRecords().count >= 1 }

        let responderUpdates = await api.responderPositionUpdates()
        let patientUpdates = await api.patientUpdates()
        let eventBatches = await api.eventPositionBatchRecords()
        XCTAssertEqual(store.positionPublishingMode, .patient(eventID: "event-live-patient"))
        XCTAssertEqual(responderUpdates.count, 1)
        XCTAssertTrue(patientUpdates.isEmpty)
        XCTAssertEqual(eventBatches.first?.eventID, "event-live-patient")
        XCTAssertEqual(eventBatches.first?.batch.records.first?.status, .fix)
    }

    func testPositionUploadRetriesLatestCoordinateAfterTransientFailure() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        await api.failNextPositionUpdates(1)
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )
        try await waitUntil { await api.responderPositionAttemptCount() == 1 }
        let latestObservedAt = Date(timeIntervalSince1970: 1_788_000_050)
        publishLocation(
            latitude: 22.199,
            longitude: 113.544,
            accuracyMeters: 6,
            observedAt: latestObservedAt,
            to: locationProvider
        )

        try await waitUntil { await api.responderPositionUpdates().count == 1 }
        let updates = await api.responderPositionUpdates()
        let attemptCount = await api.responderPositionAttemptCount()
        XCTAssertEqual(attemptCount, 2)
        XCTAssertEqual(updates[0].position.latitude, 22.199)
        XCTAssertEqual(updates[0].observedAt, latestObservedAt)
    }

    func testPositionRetryReusesStableUpdateIDWhenNoNewerSampleExists() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        await api.failNextPositionUpdates(1)
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )

        try await waitUntil { await api.responderPositionUpdates().count == 1 }
        let attempts = await api.responderPositionAttempts()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0].id, attempts[1].id)
        XCTAssertNotNil(UUID(uuidString: attempts[0].id))
    }

    func testLatestPositionUploadCoordinatorOwnsStableRetryIdentity() async throws {
        let api = FakeEmergencyAPIClient()
        await api.failNextPositionUpdates(1)
        let observedAt = Date(timeIntervalSince1970: 1_788_000_200)
        let coordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 9,
            observedAt: observedAt
        )
        var acknowledged: [PositionUpdateResult] = []
        var errors = 0
        var conflicts = 0
        let coordinator = LatestPositionUploadCoordinator(
            makeID: { "stable-latest-position-id" },
            apiClient: { api },
            isCurrent: { sessionGeneration, modeGeneration, mode in
                sessionGeneration == 7
                    && modeGeneration == 3
                    && mode == .responder
            },
            currentTier: { .standby },
            now: { observedAt.addingTimeInterval(1) },
            onAck: { result, _, _ in acknowledged.append(result) },
            onError: { _, _ in errors += 1 },
            onAuthoritativeConflict: { _ in conflicts += 1 }
        )

        coordinator.enqueue(
            coordinate,
            mode: .responder,
            sessionGeneration: 7,
            modeGeneration: 3
        )

        try await waitUntil { await api.responderPositionUpdates().count == 1 }
        let attempts = await api.responderPositionAttempts()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0].id, attempts[1].id)
        XCTAssertEqual(attempts[0].id, "stable-latest-position-id")
        XCTAssertEqual(attempts[1].observedAt, observedAt)
        XCTAssertEqual(acknowledged.count, 1)
        XCTAssertEqual(errors, 1)
        XCTAssertEqual(conflicts, 0)
    }

    func testSnapshotSelectsOnlyActiveNonterminalResponderAssignment() throws {
        let scenario = try loadScenario()
        let store = makeAcceptedStore(scenario: scenario)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-cross-event-revision",
            deliveryID: "delivery-cross-event-revision"
        )
        let factory = DemoAssignmentFactory()
        let newAssignment = try factory.makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 1,
            assignedRole: .goToPatient,
            responderFixtureIndex: 0,
            assignmentID: "assignment-new-revision-one",
            at: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        )
        let historicalAssignment = Assignment(
            id: "assignment-history-revision-99",
            eventId: "event-history",
            role: .goToPatient,
            status: .timedOut,
            revision: 99,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let history = makeEvent(
            scenario: scenario,
            eventID: "event-history",
            viewerRelationship: .responder,
            currentAssignment: historicalAssignment
        )
        let current = makeEvent(
            scenario: scenario,
            eventID: newAssignment.eventId,
            viewerRelationship: .responder,
            currentAssignment: newAssignment
        )

        store.applyServerSnapshot([history, current])

        XCTAssertEqual(store.assignment?.id, newAssignment.id)
        XCTAssertEqual(store.acceptedResponseEventID, newAssignment.eventId)
    }

    func testPatientResolutionPerformsFullVisibleEventReconciliation() async throws {
        let scenario = try loadScenario()
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-stale-responder",
            deliveryID: "delivery-stale-responder"
        )
        let assignment = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 1,
            assignedRole: .goToPatient,
            responderFixtureIndex: 0,
            assignmentID: "assignment-stale-responder",
            at: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        )
        let staleResponder = makeEvent(
            scenario: scenario,
            eventID: assignment.eventId,
            viewerRelationship: .responder,
            currentAssignment: assignment
        )
        var patient = makeEvent(
            scenario: scenario,
            eventID: "event-current-patient",
            viewerRelationship: .patient
        )
        let api = FakeEmergencyAPIClient(events: [staleResponder, patient])
        let locationProvider = LocationProvider(manager: nil)
        let observedAt = Date(timeIntervalSince1970: 1_788_000_100)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: observedAt,
            to: locationProvider
        )
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.runtimeRole == .patient }
        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.1981,
            longitude: 113.5431,
            accuracyMeters: 8,
            observedAt: observedAt.addingTimeInterval(1),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > eventBatchCount }
        for offset in 1...5 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: observedAt.addingTimeInterval(TimeInterval(offset))
            ))
        }
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }

        patient.state = .resolved
        patient.recruitmentState = .completed
        patient.resolvedAt = scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        await api.setEvents([patient])
        stream.send(.eventResolved(eventID: patient.id))

        try await waitUntil {
            store.runtimeRole == .neutral
                && store.assignment == nil
                && store.visibleEvents.map(\.id) == [patient.id]
        }
        try await waitUntil { await api.responderPositionUpdates().count == 1 }
        let patientUpdates = await api.patientUpdates()
        let eventBatches = await api.eventPositionBatchRecords()
        let responderUpdates = await api.responderPositionUpdates()
        let responderUpdate = try XCTUnwrap(responderUpdates.first)
        XCTAssertTrue(patientUpdates.isEmpty)
        XCTAssertEqual(eventBatches.first?.batch.records.count, 5)
        XCTAssertEqual(responderUpdate.observedAt, observedAt.addingTimeInterval(1))
        XCTAssertNotEqual(eventBatches.first?.batch.batchId, responderUpdate.id)
    }

    func testTerminalSocketQueuesImmediateRestoreWhileInitialRestoreIsInFlight() async throws {
        let scenario = try loadScenario()
        let staleActive = makeEvent(
            scenario: scenario,
            eventID: "event-terminal-overlap",
            viewerRelationship: .patient
        )
        var terminal = staleActive
        terminal.state = .resolved
        terminal.recruitmentState = .completed
        terminal.resolvedAt = scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        let api = FakeEmergencyAPIClient(events: [staleActive])
        await api.suspendNextListEventsResponse()
        let locationProvider = LocationProvider(manager: nil)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)

        stream.send(.connected)
        try await waitUntil { await api.hasSuspendedListEventsResponse() }
        await api.setEvents([terminal])
        stream.send(.eventResolved(eventID: staleActive.id))
        await api.resumeSuspendedListEventsResponse()

        var secondRestoreStartedWithoutBackoff = false
        for _ in 0..<100 {
            if await api.listEventsRequestCount() >= 2 {
                secondRestoreStartedWithoutBackoff = true
                break
            }
            try await Task<Never, Never>.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(
            secondRestoreStartedWithoutBackoff,
            "Terminal follow-up REST restore must not wait for the normal retry backoff."
        )
        try await waitUntil {
            store.runtimeRole == .neutral
                && store.positionPublishingMode == .responder
                && store.visibleEvents.first?.state == .resolved
                && store.visibleEvents.first?.recruitmentState == .completed
        }
        try await waitUntil { await api.responderPositionUpdates().count == 1 }
        XCTAssertNil(store.assignment)
        XCTAssertNil(store.responseRequest)
    }

    func testSocketDisconnectRebootstrapsAuthenticatedSessionBeforeReconnect() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        var streams: [FakeEventStream] = []
        let store = makeAcceptedStore(scenario: scenario, api: api) {
            let stream = FakeEventStream()
            streams.append(stream)
            return stream
        }

        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        let initialBootstrapCount = await api.bootstrapRequestCount()
        XCTAssertEqual(initialBootstrapCount, 1)
        streams[0].send(.disconnected("test token expiry"))

        try await waitUntil {
            let bootstrapCount = await api.bootstrapRequestCount()
            return streams.count == 2 && bootstrapCount == 2
        }
        streams[1].send(.connected)
        XCTAssertEqual(store.connectionState, .connected)
    }

    func testRecoveredConnectionClearsOnlyItsOwnFailure() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }
        await api.failNextBootstrapRequests(1)
        let failed = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertFalse(failed)
        XCTAssertNotNil(store.lastError)
        let recovered = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(recovered)
        stream.send(.connected)
        XCTAssertEqual(store.connectionState, .connected)
        XCTAssertNil(store.lastError)
    }

    func testRecoveredConnectionDoesNotDismissANewerErrorWithTheSameMessage() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }
        await api.failNextBootstrapRequests(1)
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertNotNil(store.lastError)
        store.reportAuthenticationError(APIClientError.invalidResponse)
        let newerError = store.lastError
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        stream.send(.connected)
        XCTAssertEqual(store.connectionState, .connected)
        XCTAssertEqual(store.lastError, newerError)
    }

    func testRecoveryDoesNotDependOnInternalTimelineAvailability() async throws {
        let scenario = try loadScenario()
        let patient = makeEvent(
            scenario: scenario,
            eventID: "event-recovery-without-audit",
            viewerRelationship: .patient
        )
        let api = FakeEmergencyAPIClient()
        await api.setEvents([patient])
        await api.setTimelineUnavailable(true)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.currentEvent?.id == patient.id }
        XCTAssertEqual(store.runtimeRole, .patient)
        let operations = await api.recordedOperations()
        XCTAssertTrue(operations.contains("events"))
        XCTAssertFalse(operations.contains { $0.hasPrefix("timeline:") })
    }

    func testReconnectRestoresEventSnapshotBeforeResumingPatientPosition() async throws {
        let scenario = try loadScenario()
        let patient = makeEvent(
            scenario: scenario,
            eventID: "event-restored-patient",
            viewerRelationship: .patient,
            eventPositionParticipationStartedAt: Date(timeIntervalSince1970: 1_788_000_101)
        )
        let api = FakeEmergencyAPIClient()
        let locationProvider = LocationProvider(manager: nil)
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_000),
            to: locationProvider
        )
        var streams: [FakeEventStream] = []
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider
        ) {
            let stream = FakeEventStream()
            streams.append(stream)
            return stream
        }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        streams[0].send(.connected)
        try await waitUntil { await api.responderPositionUpdates().count == 1 }

        await api.setEvents([patient])
        await api.suspendNextListEventsResponse()
        streams[0].send(.disconnected("test reconnect"))
        publishLocation(
            latitude: 22.199,
            longitude: 113.544,
            accuracyMeters: 6,
            observedAt: Date(timeIntervalSince1970: 1_788_000_050),
            to: locationProvider
        )
        try await waitUntil { streams.count == 2 }
        let patientUpdatesBeforeRestore = await api.patientUpdates()
        XCTAssertNil(store.positionPublishingMode)
        XCTAssertTrue(patientUpdatesBeforeRestore.isEmpty)

        try await waitUntil { await api.hasSuspendedListEventsResponse() }
        await api.resumeSuspendedListEventsResponse()
        try await waitUntil { store.positionPublishingMode == .patient(eventID: patient.id) }
        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.1995,
            longitude: 113.5445,
            accuracyMeters: 6,
            observedAt: Date(timeIntervalSince1970: 1_788_000_101),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > eventBatchCount }
        for offset in 0..<5 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: Date(timeIntervalSince1970: 1_788_000_101 + TimeInterval(offset))
            ))
        }
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        let restoredEventBatches = await api.eventPositionBatchRecords()
        let operations = await api.recordedOperations()
        XCTAssertEqual(store.positionPublishingMode, .patient(eventID: patient.id))
        XCTAssertEqual(
            restoredEventBatches.first?.batch.records.first?.fixObservedAt,
            Date(timeIntervalSince1970: 1_788_000_101)
        )
        let snapshotIndex = try XCTUnwrap(operations.lastIndex(of: "events"))
        XCTAssertFalse(operations.contains { $0.hasPrefix("timeline:") })
        let eventPositionIndex = try XCTUnwrap(
            operations.lastIndex(of: "event-position-batch:\(patient.id)")
        )
        XCTAssertLessThan(snapshotIndex, eventPositionIndex)
    }

    func testPatientActivationImmediatelyOverridesResponseAndAssignment() throws {
        let scenario = try loadScenario()
        let store = makeAcceptedStore(scenario: scenario)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-role",
            deliveryID: "delivery-role"
        )
        let assignment = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 1,
            assignedRole: .goToPatient,
            responderFixtureIndex: 0,
            assignmentID: "assignment-role",
            at: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        )
        var responderEvent = DemoScenarioEngine().makePatientEvent(
            scenario: scenario,
            viewerRelationship: .responder
        )
        responderEvent = EmergencyEvent(
            id: responderEvent.id,
            state: responderEvent.state,
            recruitmentState: responderEvent.recruitmentState,
            canPublishEventPosition: responderEvent.canPublishEventPosition,
            triggerSource: responderEvent.triggerSource,
            fallDetectedAt: responderEvent.fallDetectedAt,
            fallResolution: responderEvent.fallResolution,
            callFirstObservedAt: responderEvent.callFirstObservedAt,
            patientPosition: responderEvent.patientPosition,
            patientLocationCard: responderEvent.patientLocationCard,
            viewerRelationship: .responder,
            createdAt: responderEvent.createdAt,
            resolvedAt: nil,
            pendingResponseRequest: nil,
            currentAssignment: assignment
        )

        store.applyServerSnapshot([responderEvent])
        XCTAssertEqual(store.runtimeRole, .responder)
        store.receiveResponseRequest(request)
        XCTAssertNotNil(store.responseRequest)
        XCTAssertNotNil(store.assignment)
        XCTAssertNotNil(store.acceptedResponseEventID)

        store.applyPatientActivation(eventID: "patient-event-new")
        XCTAssertEqual(store.runtimeRole, .patient)
        XCTAssertNil(store.responseRequest)
        XCTAssertNil(store.assignment)
        XCTAssertNil(store.acceptedResponseEventID)

        store.applyServerSnapshot([responderEvent])
        XCTAssertEqual(store.runtimeRole, .patient)
        XCTAssertNil(store.responseRequest)
        XCTAssertNil(store.assignment)
        XCTAssertNil(store.acceptedResponseEventID)

        let patientEvent = EmergencyEvent(
            id: "patient-event-new",
            state: .active,
            recruitmentState: .recruiting,
            canPublishEventPosition: true,
            triggerSource: .watchFallHelpConfirmed,
            fallDetectedAt: scenario.watchObservation.fallDetectedAt,
            fallResolution: .confirmed,
            callFirstObservedAt: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt,
            patientPosition: scenario.patient.patientPosition,
            patientLocationCard: scenario.patient.patientLocationCard,
            viewerRelationship: .patient,
            createdAt: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt,
            resolvedAt: nil,
            pendingResponseRequest: nil,
            currentAssignment: nil
        )
        store.applyServerSnapshot([responderEvent, patientEvent])
        XCTAssertEqual(store.runtimeRole, .patient)
        XCTAssertNil(store.responseRequest)
        XCTAssertNil(store.assignment)
        XCTAssertNil(store.acceptedResponseEventID)
    }

    func testReceivingRequestDoesNotMakeUserResponderBeforeAcceptance() throws {
        let scenario = try loadScenario()
        let store = makeAcceptedStore(scenario: scenario)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-neutral",
            deliveryID: "delivery-neutral"
        )

        store.receiveResponseRequest(request)

        XCTAssertEqual(store.runtimeRole, .neutral)
        XCTAssertEqual(store.deliveryStatus, .delivered)
        XCTAssertNil(store.acceptedResponseEventID)
    }

    func testOfferExpiryClearsOnlyMatchingEventAndDelivery() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-expiry-match",
            deliveryID: "delivery-expiry-match"
        )
        store.receiveResponseRequest(request)
        XCTAssertNotNil(store.responseRequest)

        stream.send(
            .responseOfferExpired(
                ResponseOfferExpired(
                    eventId: "event-other",
                    deliveryId: request.deliveryId,
                    expiresAt: request.expiresAt,
                    reason: .offerExpired
                )
            )
        )
        XCTAssertNotNil(store.responseRequest)

        stream.send(
            .responseOfferExpired(
                ResponseOfferExpired(
                    eventId: request.eventId,
                    deliveryId: "delivery-other",
                    expiresAt: request.expiresAt,
                    reason: .offerExpired
                )
            )
        )
        XCTAssertNotNil(store.responseRequest)

        stream.send(
            .responseOfferExpired(
                ResponseOfferExpired(
                    eventId: request.eventId,
                    deliveryId: request.deliveryId,
                    expiresAt: request.expiresAt,
                    reason: .offerExpired
                )
            )
        )
        XCTAssertNil(store.responseRequest)
    }

    func testFailedRestReceiptRemainsPendingAndBlocksDecision() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        await api.failNextReceipt()
        let store = makeAcceptedStore(scenario: scenario, api: api)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-receipt-failure",
            deliveryID: "delivery-receipt-failure"
        )

        store.receiveResponseRequest(request)
        store.markResponseRequestViewed()
        store.acceptResponseRequest()

        XCTAssertTrue(store.isAwaitingResponseViewReceipt)
        XCTAssertFalse(store.isSubmittingResponseDecision)
        XCTAssertNil(store.acceptedResponseEventID)
        XCTAssertTrue(store.lastError?.contains("VIEWED 回执尚未由服务端确认") == true)
        try await waitUntil { await api.receiptAttemptRecords().count == 1 }
        let attempts = await api.receiptAttemptRecords()
        XCTAssertEqual(attempts.first?.status, .delivered)
        XCTAssertEqual(attempts.first?.eventID, request.eventId)
        XCTAssertEqual(attempts.first?.deliveryID, request.deliveryId)
        let decisions = await api.responseDecisionAttemptRecords()
        XCTAssertTrue(decisions.isEmpty)
    }

    func testResponseDecisionDoubleTapSubmitsOnlyOneAccept() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let (store, request) = try await makeResponseDecisionStore(scenario: scenario, api: api)
        defer {
            store.disconnect()
            Task { await api.releaseAllResponseDecisions() }
        }
        await api.suspendNextResponseDecision()

        store.acceptResponseRequest()
        XCTAssertTrue(store.isSubmittingResponseDecision)
        store.acceptResponseRequest()
        store.refuseResponseRequest()
        try await waitUntil { await api.isResponseDecisionSuspended(0) }

        let attempts = await api.responseDecisionAttemptRecords()
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(attempts.first?.eventID, request.eventId)
        XCTAssertEqual(attempts.first?.deliveryID, request.deliveryId)
        XCTAssertEqual(attempts.first?.accept, true)
        await api.releaseResponseDecision(0)
        try await waitUntil { !store.isSubmittingResponseDecision }
        XCTAssertEqual(store.deliveryStatus, .accepted)
        XCTAssertFalse(store.isAwaitingResponseViewReceipt)
        XCTAssertNil(store.assignment, "A successful accept must not invent a task before the server assigns one.")
    }

    func testResponseDecisionFailureReleasesBusyAndAllowsRetry() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let (store, _) = try await makeResponseDecisionStore(scenario: scenario, api: api)
        defer { store.disconnect() }
        await api.failNextResponseDecision()

        store.refuseResponseRequest()
        XCTAssertTrue(store.isSubmittingResponseDecision)
        try await waitUntil { !store.isSubmittingResponseDecision }
        XCTAssertEqual(store.deliveryStatus, .viewed)
        XCTAssertNotNil(store.lastError)

        store.clearError()
        store.refuseResponseRequest()
        store.refuseResponseRequest()
        try await waitUntil { !store.isSubmittingResponseDecision }
        let attempts = await api.responseDecisionAttemptRecords()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertTrue(attempts.allSatisfy { !$0.accept })
        XCTAssertEqual(store.deliveryStatus, .refused)
        XCTAssertFalse(store.isAwaitingResponseViewReceipt)
    }

    func testOldResponseDecisionCannotReleaseNewSessionSubmission() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let (store, request) = try await makeResponseDecisionStore(scenario: scenario, api: api)
        defer {
            store.disconnect()
            Task { await api.releaseAllResponseDecisions() }
        }
        await api.suspendNextResponseDecision()
        store.acceptResponseRequest()
        try await waitUntil { await api.isResponseDecisionSuspended(0) }

        store.disconnect()
        XCTAssertFalse(store.isSubmittingResponseDecision)
        let reconnected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(reconnected)
        try await waitUntil { store.responseRequest?.messageId == request.messageId }
        await api.suspendNextResponseDecision()
        store.refuseResponseRequest()
        try await waitUntil { await api.isResponseDecisionSuspended(1) }

        await api.releaseResponseDecision(0)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(store.isSubmittingResponseDecision, "The old session's completion must not unlock the new decision.")
        XCTAssertEqual(store.deliveryStatus, .viewed)
        XCTAssertNil(store.acceptedResponseEventID)

        await api.releaseResponseDecision(1)
        try await waitUntil { !store.isSubmittingResponseDecision }
        XCTAssertEqual(store.deliveryStatus, .refused)
    }

    func testReplacingOfferReleasesBusyAndIgnoresOldDecision() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let (store, request) = try await makeResponseDecisionStore(scenario: scenario, api: api)
        defer {
            store.disconnect()
            Task { await api.releaseAllResponseDecisions() }
        }
        await api.suspendNextResponseDecision()
        store.acceptResponseRequest()
        try await waitUntil { await api.isResponseDecisionSuspended(0) }
        let next = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-replacement",
            deliveryID: "delivery-replacement",
            occurredAt: request.occurredAt
        )

        store.receiveResponseRequest(next)
        XCTAssertFalse(store.isSubmittingResponseDecision)
        await api.releaseResponseDecision(0)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(store.responseRequest?.messageId, next.messageId)
        XCTAssertEqual(store.deliveryStatus, .delivered)
        XCTAssertNil(store.acceptedResponseEventID)
    }

    func testLocalOfferExpiryReleasesBusyAndIgnoresLateDecision() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let clock = ResponseDecisionTestClock(date: Date(timeIntervalSince1970: 1_788_000_100))
        let (store, request) = try await makeResponseDecisionStore(
            scenario: scenario, api: api, clock: clock
        )
        defer {
            store.disconnect()
            Task { await api.releaseAllResponseDecisions() }
        }
        await api.suspendNextResponseDecision()
        store.acceptResponseRequest()
        try await waitUntil { await api.isResponseDecisionSuspended(0) }
        store.expireResponseRequestIfNeeded()
        XCTAssertNotNil(store.responseRequest, "A valid invitation must remain actionable until its real deadline.")
        XCTAssertTrue(store.isSubmittingResponseDecision)
        await api.setEvents([])

        clock.date = request.expiresAt
        store.expireResponseRequestIfNeeded()
        XCTAssertNotNil(store.responseRequest, "Preserve the existing strictly-after-expiresAt rule.")
        clock.date = request.expiresAt.addingTimeInterval(0.001)
        store.expireResponseRequestIfNeeded()
        XCTAssertFalse(store.isSubmittingResponseDecision)
        XCTAssertFalse(store.isAwaitingResponseViewReceipt)
        XCTAssertNil(store.responseRequest)
        store.expireResponseRequestIfNeeded()
        await api.releaseResponseDecision(0)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertNil(store.acceptedResponseEventID)
        XCTAssertNil(store.assignment)
        let decisions = await api.responseDecisionAttemptRecords()
        XCTAssertEqual(decisions.count, 1, "Local expiry must not submit an automatic accept or refusal.")
        let receipts = await api.receiptAttemptRecords()
        XCTAssertEqual(receipts.map(\.status), [.delivered, .viewed])
    }

    func testPatientActivationReleasesBusyAndPreventsLateAcceptance() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let (store, _) = try await makeResponseDecisionStore(scenario: scenario, api: api)
        defer {
            store.disconnect()
            Task { await api.releaseAllResponseDecisions() }
        }
        await api.suspendNextResponseDecision()
        store.acceptResponseRequest()
        try await waitUntil { await api.isResponseDecisionSuspended(0) }

        store.applyPatientActivation(eventID: "patient-priority-event")
        XCTAssertEqual(store.runtimeRole, .patient)
        XCTAssertFalse(store.isSubmittingResponseDecision)
        await api.releaseResponseDecision(0)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(store.runtimeRole, .patient)
        XCTAssertNil(store.acceptedResponseEventID)
        XCTAssertNil(store.assignment)
    }

    func testDeliveryReceiptSurvivesAppStoreRestartAndDrainsFromSameProtectedQueue() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        await api.failNextReceipt()
        let receiptStore = MemoryDeliveryReceiptQueueStore()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-cross-process-receipt",
            deliveryID: "delivery-cross-process-receipt"
        )

        let first = makeAcceptedStore(
            scenario: scenario,
            api: api,
            authSessionStore: authStore,
            deliveryReceiptQueueStore: receiptStore
        )
        let firstConnected = await first.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(firstConnected)
        first.receiveResponseRequest(request)
        first.markResponseRequestViewed()
        // Receiving and viewing the offer produce two independent facts
        // (DELIVERED then VIEWED), so two receipts are durably queued.  The first
        // send fails; the failed fact stays queued behind the transport backoff.
        try await waitUntil { await api.receiptAttemptRecords().count == 1 }
        first.disconnect()
        // The durable queue is now the only carrier of the unconfirmed facts, so
        // any later attempt must come from a new process reading it back.
        let durableAfterFailure = try receiptStore.load()
        XCTAssertEqual(durableAfterFailure.count, 2)
        XCTAssertEqual(durableAfterFailure.map(\.status), [.delivered, .viewed])

        // A new AppStore models a process restart: the same authenticated
        // identity and durable queue are reconstructed before transport drain.
        let second = makeAcceptedStore(
            scenario: scenario,
            api: api,
            authSessionStore: authStore,
            deliveryReceiptQueueStore: receiptStore
        )
        defer { second.disconnect() }
        let secondConnected = await second.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(secondConnected)
        // The second process replays the failed fact and then sends the one
        // queued behind it, so the protected queue ends empty instead of stranding
        // an unconfirmed receipt.
        try await waitUntil {
            let attempts = await api.receiptAttemptRecords()
            return attempts.count >= 3 && (try? receiptStore.load().isEmpty) == true
        }
        let attempts = await api.receiptAttemptRecords()
        XCTAssertEqual(attempts.first?.status, .delivered, "第一次尝试必须是队首事实")
        XCTAssertEqual(attempts.last?.status, .viewed)
        XCTAssertTrue(attempts.allSatisfy { $0.deliveryID == request.deliveryId })
        XCTAssertTrue(try receiptStore.load().isEmpty)
    }

    /// App Store 5.1.1(i): the consent gate must be able to show what it asks the
    /// user to accept, and must fail closed when the document set is unavailable.
    func testConsentGateExposesReadableDocumentsWhenPresent() throws {
        let scenario = try loadScenario()
        let documents = try ResourceLoader.agreementDocuments(bundle: .main)
        let store = makeStore(scenario: scenario, agreementDocuments: documents)

        XCTAssertEqual(store.agreementDocuments.count, AgreementKind.allCases.count)
        for kind in AgreementKind.allCases {
            let document = try XCTUnwrap(store.agreementDocument(for: kind))
            XCTAssertEqual(document.kind, kind)
            XCTAssertTrue(document.isReadable, "\(kind.rawValue) 必须可读，否则同意门禁形同虚设")
        }
        // The privacy policy is the one document App Store also requires as a
        // hosted URL; until one is configured the app must not claim readiness.
        XCTAssertNil(store.hostedPrivacyPolicyURL)
    }

    func testConsentGateFailsClosedWithoutReadableDocuments() throws {
        let scenario = try loadScenario()
        let store = makeStore(scenario: scenario)
        XCTAssertTrue(store.agreementDocuments.isEmpty)
        XCTAssertNil(store.agreementDocument(for: .privacyPolicy))
        XCTAssertNil(store.hostedPrivacyPolicyURL)
    }

    /// App Store guideline 5.1.1(v): deleting the account must be reachable in
    /// the app, must be decided by the server, and must clear the local identity.
    func testAccountDeletionAsksTheServerAndClearsEveryLocalIdentityFact() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            authSessionStore: authStore
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertNotNil(store.authSession)

        store.deleteAccount()
        try await waitUntil { !store.isAuthenticated }

        // The erasure was requested from the server, not simulated locally.
        let attempts = await api.recordedAccountDeletions()
        XCTAssertEqual(attempts, 1, "删除账号必须由服务端裁定，不能在本地伪装成功")
        XCTAssertFalse(store.isDeletingAccount)
        XCTAssertNil(store.authSession, "删除后本机不得保留登录身份")
        XCTAssertNil(authStore.load(), "删除后 Keychain 登录凭据必须清除")
        XCTAssertFalse(store.agreementState.isComplete, "删除后协议同意状态必须清除")
        XCTAssertTrue(
            store.lastError?.contains("账号已注销") == true,
            "删除成功必须给出明确反馈，而不是静默返回登录页"
        )
    }

    /// A failed deletion must leave the user signed in and able to retry: clearing
    /// local credentials first would strand an account they can no longer reach.
    func testFailedAccountDeletionKeepsTheSessionAndReportsTheFailure() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            authSessionStore: authStore
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        await api.failAccountDeletion(with: APIClientError.unexpectedStatus(503))

        store.deleteAccount()
        try await waitUntil { store.lastError != nil && !store.isDeletingAccount }

        // The failure wording follows the product decision: this is a LOGICAL
        // closure (注销), not a physical deletion (删除).
        XCTAssertTrue(store.lastError?.contains("账号注销失败") == true)
        XCTAssertTrue(store.isAuthenticated, "注销失败必须保持登录，允许用户重试")
        XCTAssertNotNil(authStore.load(), "注销失败不得清除本机登录凭据")
    }

    func testPermanentlyRejectedReceiptIsIsolatedAndDoesNotBlockLaterReceipts() async throws {
        let api = FakeEmergencyAPIClient()
        await api.rejectReceiptPermanently(deliveryID: "delivery-rejected")
        let queueStore = MemoryDeliveryReceiptQueueStore()
        let context = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let errors = ReceiptErrorLog()
        let coordinator = DeliveryReceiptUploadCoordinator(
            store: queueStore,
            apiClient: { api },
            context: { context },
            onError: { errors.append($0) }
        )
        coordinator.startDrain()

        XCTAssertTrue(coordinator.enqueue(
            eventID: "event-1",
            deliveryID: "delivery-rejected",
            status: .delivered,
            occurredAt: Date(timeIntervalSince1970: 600)
        ))
        XCTAssertTrue(coordinator.enqueue(
            eventID: "event-1",
            deliveryID: "delivery-following",
            status: .viewed,
            occurredAt: Date(timeIntervalSince1970: 601)
        ))

        // The rejected head is attempted once and isolated; the receipt queued
        // behind it must still be sent instead of stalling forever.
        try await waitUntil {
            await api.receiptAttemptRecords().contains { $0.deliveryID == "delivery-following" }
        }
        let attempts = await api.receiptAttemptRecords()
        XCTAssertEqual(attempts.first?.deliveryID, "delivery-rejected")
        XCTAssertEqual(
            attempts.filter { $0.deliveryID == "delivery-rejected" }.count,
            1,
            "a permanent rejection must not be retried"
        )
        let isolated = coordinator.isolatedReceipts()
        XCTAssertEqual(isolated.map(\.deliveryID), ["delivery-rejected"])
        XCTAssertTrue(isolated.first?.blockedReason?.contains("HTTP 403") == true)
        XCTAssertFalse(coordinator.hasPending(deliveryID: "delivery-rejected"))

        // The isolated fact stays persisted for reconciliation, while the
        // acknowledged one is removed from the queue entirely.
        let remaining = try queueStore.load()
        XCTAssertEqual(remaining.map(\.deliveryID), ["delivery-rejected"])
        XCTAssertEqual(remaining.first?.blockedReason?.isEmpty, false)
        XCTAssertTrue(errors.messages.contains { $0.contains("已隔离保留待对账") })
    }

    func testProductionStateNeverFallsBackToDemoLocationOrResponderPosition() throws {
        let store = makeAcceptedStore(scenario: try loadScenario())

        XCTAssertNil(store.activeLocationCard)
        XCTAssertNil(store.responderPosition)
    }

    func testSocketV2EnvelopeRejectsMalformedMessagesAndUsesBoundedDeduplication() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token",
            messageIDCapacity: 2
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }

        stream.handleIncomingEvent(
            name: "event:patient-activated",
            data: [patientActivatedPayload(messageID: "message-1")]
        )
        stream.handleIncomingEvent(
            name: "event:patient-activated",
            data: [patientActivatedPayload(messageID: "message-1")]
        )

        var badVersion = patientActivatedPayload(messageID: "message-bad")
        badVersion["schemaVersion"] = "1.0"
        stream.handleIncomingEvent(name: "event:patient-activated", data: [badVersion])

        var missingOccurredAt = patientActivatedPayload(messageID: "message-missing-date")
        missingOccurredAt.removeValue(forKey: "occurredAt")
        stream.handleIncomingEvent(name: "event:patient-activated", data: [missingOccurredAt])

        // Invalid messages are not cached, while valid IDs are retained only up to capacity.
        stream.handleIncomingEvent(
            name: "event:patient-activated",
            data: [patientActivatedPayload(messageID: "message-bad")]
        )
        stream.handleIncomingEvent(
            name: "event:patient-activated",
            data: [patientActivatedPayload(messageID: "message-2")]
        )
        stream.handleIncomingEvent(
            name: "event:patient-activated",
            data: [patientActivatedPayload(messageID: "message-1")]
        )

        let activations = received.compactMap { event -> String? in
            guard case let .patientActivated(eventID) = event else { return nil }
            return eventID
        }
        let protocolErrors = received.compactMap { event -> String? in
            guard case let .protocolError(message) = event else { return nil }
            return message
        }
        XCTAssertEqual(activations.count, 4)
        XCTAssertEqual(protocolErrors.count, 2)
        XCTAssertTrue(protocolErrors.allSatisfy { $0.contains("v2 契约") })
    }

    func testSocketPositionAndCoordinationHintsDecodeBeforeRestReconciliation() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token"
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }
        let envelope: [String: Any] = [
            "schemaVersion": "2.0",
            "messageId": "message-p-position",
            "eventId": "event-socket-1",
            "occurredAt": "2026-08-31T01:02:04Z"
        ]
        var patientPositionEnvelope = envelope
        patientPositionEnvelope["coordinationRevision"] = 4
        stream.handleIncomingEvent(
            name: "event:patient-position-updated",
            data: [patientPositionEnvelope]
        )

        let coordination: [String: Any] = [
            "revision": 4,
            "nearbyCandidateCount": 2,
            "pendingOfferCount": 1,
            "acceptedResponderCount": 3,
            "goToPatientCount": 2,
            "fetchAedCount": 1,
            "enRouteCount": 2,
            "arrivedAtAedCount": 0,
            "arrivedAtPatientCount": 0,
            "aedAcquiredCount": 0,
            "completedAssignmentCount": 0
        ]
        var coordinationEnvelope = envelope
        coordinationEnvelope["messageId"] = "message-coordination"
        coordinationEnvelope["coordination"] = coordination
        stream.handleIncomingEvent(name: "event:coordination-updated", data: [coordinationEnvelope])

        var decisionEnvelope = envelope
        decisionEnvelope["messageId"] = "message-decision"
        decisionEnvelope["decision"] = "ACCEPT"
        decisionEnvelope["coordination"] = coordination
        stream.handleIncomingEvent(name: "response:decision-recorded", data: [decisionEnvelope])

        XCTAssertEqual(received.count, 3)
        if case let .patientPositionUpdated(eventID, revision) = received[0] {
            XCTAssertEqual(eventID, "event-socket-1")
            XCTAssertEqual(revision, 4)
        } else {
            XCTFail("Expected patient position hint")
        }
        if case let .coordinationUpdated(eventID, coordination) = received[1] {
            XCTAssertEqual(eventID, "event-socket-1")
            XCTAssertEqual(coordination.revision, 4)
            XCTAssertEqual(coordination.acceptedResponderCount, 3)
        } else {
            XCTFail("Expected coordination hint")
        }
        if case let .responseDecisionRecorded(eventID, decision, coordination) = received[2] {
            XCTAssertEqual(eventID, "event-socket-1")
            XCTAssertEqual(decision, .accept)
            XCTAssertEqual(coordination.revision, 4)
        } else {
            XCTFail("Expected response decision hint")
        }
    }

    func testSocketTerminalEventsRequireCanonicalStatePairs() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token"
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }
        let base: [String: Any] = [
            "schemaVersion": "2.0",
            "eventId": "event-socket-1",
            "occurredAt": "2026-08-31T01:02:04Z"
        ]
        var falseAlarm = base
        falseAlarm["messageId"] = "message-terminal-false"
        falseAlarm["state"] = "CANCELLED_CONFIRMED_FALSE_ALARM"
        falseAlarm["recruitmentState"] = "STOPPED"
        stream.handleIncomingEvent(name: "event:false-alarm-confirmed", data: [falseAlarm])

        var resolved = base
        resolved["messageId"] = "message-terminal-resolved"
        resolved["state"] = "RESOLVED"
        resolved["recruitmentState"] = "COMPLETED"
        stream.handleIncomingEvent(name: "event:resolved", data: [resolved])

        var unconfirmed = base
        unconfirmed["messageId"] = "message-terminal-unconfirmed"
        unconfirmed["state"] = "CLOSED_UNCONFIRMED_NO_RESPONSE"
        unconfirmed["recruitmentState"] = "STOPPED"
        stream.handleIncomingEvent(
            name: "event:closed-unconfirmed-no-response",
            data: [unconfirmed]
        )

        var invalid = base
        invalid["messageId"] = "message-terminal-invalid"
        invalid["state"] = "RESOLVED"
        invalid["recruitmentState"] = "STOPPED"
        stream.handleIncomingEvent(name: "event:resolved", data: [invalid])

        XCTAssertEqual(received.count, 4)
        if case .falseAlarmConfirmed = received[0] {} else {
            XCTFail("Expected canonical false-alarm terminal event")
        }
        if case .eventResolved = received[1] {} else {
            XCTFail("Expected canonical resolved terminal event")
        }
        if case .eventClosedUnconfirmedNoResponse = received[2] {} else {
            XCTFail("Expected canonical unconfirmed-close terminal event")
        }
        if case .protocolError = received[3] {} else {
            XCTFail("Expected invalid state-pair protocol error")
        }
    }

    func testSocketStatusConfirmationRequestStrictlyParsesHint() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token"
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }
        stream.handleIncomingEvent(
            name: "event:status-confirmation-requested",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-status-confirmation",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:32:04Z",
                "confirmationId": "confirmation-1",
                "prompt": "STILL_IN_PROGRESS",
                "responseDeadlineAt": "2026-08-31T01:37:04Z"
            ]]
        )
        stream.handleIncomingEvent(
            name: "event:status-confirmation-requested",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-status-confirmation-invalid",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:32:04Z",
                "confirmationId": "confirmation-2",
                "prompt": "UNKNOWN",
                "responseDeadlineAt": "2026-08-31T01:37:04Z"
            ]]
        )

        XCTAssertEqual(received.count, 2)
        guard case let .statusConfirmationRequested(eventID, hint) = received[0] else {
            return XCTFail("Expected status-confirmation hint")
        }
        XCTAssertEqual(eventID, "event-socket-1")
        XCTAssertEqual(hint.confirmationId, "confirmation-1")
        XCTAssertEqual(hint.prompt, .stillInProgress)
        if case .protocolError = received[1] {} else {
            XCTFail("Expected invalid status-confirmation prompt to fail")
        }
    }

    func testPatientCanSubmitContinueForRestStatusConfirmation() async throws {
        let scenario = try loadScenario()
        let eventID = "event-status-confirmation"
        let confirmation = StatusConfirmation(
            confirmationId: "confirmation-status-1",
            prompt: .stillInProgress,
            sentAt: Date(timeIntervalSince1970: 1_788_000_090),
            responseDeadlineAt: Date(timeIntervalSince1970: 1_788_000_390)
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .patient,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: Date(timeIntervalSince1970: 1_788_000_000),
            statusConfirmation: confirmation
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.currentEvent?.statusConfirmation == confirmation }

        stream.send(.statusConfirmationRequested(
            eventID: eventID,
            hint: StatusConfirmationHint(
                confirmationId: confirmation.confirmationId,
                prompt: confirmation.prompt,
                responseDeadlineAt: confirmation.responseDeadlineAt
            )
        ))
        try await waitUntil {
            await api.requestedEventIDs().contains(eventID)
        }

        store.continueCurrentStatusConfirmation()
        try await waitUntil {
            let attempts = await api.recordedStatusConfirmationAttempts()
            return attempts.count == 1 && !store.isSubmittingStatusConfirmation
        }
        let attempts = await api.recordedStatusConfirmationAttempts()
        let attempt = try XCTUnwrap(attempts.first)
        XCTAssertEqual(attempt.eventID, eventID)
        XCTAssertEqual(attempt.confirmationID, confirmation.confirmationId)
        XCTAssertEqual(store.lastStatusConfirmationResult?.response, .continueRescue)
    }

    func testStaleStatusConfirmationResponseCannotUpdateAfterDisconnect() async throws {
        let scenario = try loadScenario()
        let eventID = "event-status-confirmation-stale"
        let confirmation = StatusConfirmation(
            confirmationId: "confirmation-status-stale",
            prompt: .stillInProgress,
            sentAt: Date(timeIntervalSince1970: 1_788_000_090),
            responseDeadlineAt: Date(timeIntervalSince1970: 1_788_000_390)
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .patient,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: Date(timeIntervalSince1970: 1_788_000_000),
            statusConfirmation: confirmation
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.currentEvent?.statusConfirmation == confirmation }

        await api.suspendNextStatusConfirmationResponse()
        store.continueCurrentStatusConfirmation()
        try await waitUntil { await api.isStatusConfirmationSuspended() }

        store.disconnect()
        await api.resumeStatusConfirmationResponse()
        for _ in 0..<8 { await Task.yield() }

        XCTAssertFalse(store.isSubmittingStatusConfirmation)
        XCTAssertNil(store.lastStatusConfirmationResult)
    }

    func testSocketResponseRequestUsesOnlyCoarseAllowlistedFields() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token"
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }
        var payload: [String: Any] = [
            "schemaVersion": "2.0",
            "messageId": "message-pending-delivery",
            "eventId": "event-socket-1",
            "deliveryId": "delivery-socket-1",
            "deliveryStatus": "SENT",
            "occurredAt": "2026-08-31T01:02:04Z",
            "eventType": "FALL_ASSISTANCE",
            "positioningTier": "SEARCH_RING",
            "distanceRange": "DISTANCE_0_500M",
            "etaRange": "ETA_0_5_MIN",
            "currentRecruitmentRadiusMeters": 1_000,
            "expiresAt": "2026-08-31T01:02:34Z"
        ]
        stream.handleIncomingEvent(name: "response:requested", data: [payload])
        payload["messageId"] = "message-sensitive-delivery"
        payload["patientPosition"] = [
            "kind": "P",
            "latitude": 22.1987,
            "longitude": 113.5439,
            "accuracyMeters": 12
        ]
        stream.handleIncomingEvent(name: "response:requested", data: [payload])

        XCTAssertEqual(received.count, 2)
        if case let .responseRequested(request) = received[0] {
            XCTAssertEqual(request.deliveryStatus, .sent)
            XCTAssertEqual(request.eventType, .fallAssistance)
            XCTAssertEqual(request.positioningTier, .searchRing)
            XCTAssertEqual(request.distanceRange, .zeroTo500Meters)
            XCTAssertEqual(request.etaRange, .zeroTo5Minutes)
            XCTAssertEqual(request.currentRecruitmentRadiusMeters, 1_000)
        } else {
            XCTFail("Expected pending response request")
        }
        if case let .protocolError(message) = received[1] {
            XCTAssertTrue(message.contains("patientPosition"))
        } else {
            XCTFail("Expected sensitive pending-offer fields to be rejected")
        }
    }

    func testSocketOfferExpiredClearsThroughTypedEventWithoutPatientData() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token"
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }
        stream.handleIncomingEvent(
            name: "response:offer-expired",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-offer-expired",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:02:35Z",
                "deliveryId": "delivery-socket-1",
                "expiresAt": "2026-08-31T01:02:34Z",
                "reason": "OFFER_EXPIRED"
            ]]
        )

        guard case let .responseOfferExpired(expired) = received.first else {
            return XCTFail("Expected response:offer-expired")
        }
        XCTAssertEqual(expired.eventId, "event-socket-1")
        XCTAssertEqual(expired.deliveryId, "delivery-socket-1")
        XCTAssertEqual(expired.reason, .offerExpired)
    }

    func testSocketStrictlyParsesAssignmentAndAedPayloads() {
        let stream = SocketIOEventStream(
            serverURL: URL(string: "http://127.0.0.1:8787")!,
            bearerToken: "test-token"
        )
        var received: [RealtimeEvent] = []
        stream.onEvent = { received.append($0) }

        let assignment = validFetchAedAssignmentPayload()
        stream.handleIncomingEvent(
            name: "assignment:created",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-assignment-valid",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:02:04Z",
                "assignment": assignment
            ]]
        )

        var flatAssignment: [String: Any] = [
            "schemaVersion": "2.0",
            "messageId": "message-assignment-flat",
            "eventId": "event-socket-1",
            "occurredAt": "2026-08-31T01:02:04Z"
        ]
        assignment.forEach { flatAssignment[$0.key] = $0.value }
        stream.handleIncomingEvent(name: "assignment:created", data: [flatAssignment])

        var missingRoute = assignment
        missingRoute.removeValue(forKey: "route")
        stream.handleIncomingEvent(
            name: "assignment:updated",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-assignment-no-route",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:02:05Z",
                "assignment": missingRoute
            ]]
        )

        stream.handleIncomingEvent(
            name: "aed:acquired",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-aed-valid",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:06:01Z",
                "receiptId": "receipt-socket-1",
                "assignmentId": "assignment-socket-1",
                "aedId": "aed-socket-1",
                "acquiredAt": "2026-08-31T01:06:00Z"
            ]]
        )
        stream.handleIncomingEvent(
            name: "aed:acquired",
            data: [[
                "schemaVersion": "2.0",
                "messageId": "message-aed-invalid",
                "eventId": "event-socket-1",
                "occurredAt": "2026-08-31T01:06:01Z",
                "receiptId": "receipt-socket-2",
                "aedId": "aed-socket-1",
                "acquiredAt": "2026-08-31T01:06:00Z"
            ]]
        )

        let assignments = received.compactMap { event -> Assignment? in
            guard case let .assignmentCreated(assignment) = event else { return nil }
            return assignment
        }
        let receipts = received.compactMap { event -> AedAcquiredReceipt? in
            guard case let .aedAcquired(receipt) = event else { return nil }
            return receipt
        }
        let errors = received.filter {
            if case .protocolError = $0 { return true }
            return false
        }
        XCTAssertEqual(assignments.count, 1)
        XCTAssertEqual(assignments.first?.route?.pathKinds, [.responder, .aed, .patient])
        XCTAssertEqual(receipts.count, 1)
        XCTAssertEqual(receipts.first?.assignmentId, "assignment-socket-1")
        XCTAssertEqual(errors.count, 3)
    }

    func testSocketStateHintReconcilesThroughRestAndRestTruthWins() async throws {
        let scenario = try loadScenario()
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-reconcile",
            deliveryID: "delivery-reconcile"
        )
        let baseAssignment = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 1,
            assignedRole: .goToPatient,
            responderFixtureIndex: 0,
            assignmentID: "assignment-reconcile",
            at: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        )
        let socketAssignment = Assignment(
            id: baseAssignment.id,
            eventId: baseAssignment.eventId,
            role: baseAssignment.role,
            status: .enRoute,
            revision: 99,
            route: baseAssignment.route,
            aedAcquiredReceipt: nil
        )
        let restAssignment = Assignment(
            id: baseAssignment.id,
            eventId: baseAssignment.eventId,
            role: baseAssignment.role,
            status: .assigned,
            revision: 1,
            route: baseAssignment.route,
            aedAcquiredReceipt: nil
        )
        let restEvent = makeEvent(
            scenario: scenario,
            viewerRelationship: .responder,
            currentAssignment: restAssignment
        )
        let api = FakeEmergencyAPIClient(events: [restEvent])
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        store.applyServerSnapshot([restEvent])

        stream.send(.assignmentUpdated(socketAssignment))
        XCTAssertEqual(store.assignment?.status, .enRoute)

        try await waitUntil {
            let requestedEventIDs = await api.requestedEventIDs()
            return store.assignment == restAssignment
                && requestedEventIDs.contains(restEvent.id)
        }
    }

    func testEverySocketStateMutationSchedulesRestReconciliation() async throws {
        let scenario = try loadScenario()
        let event = makeEvent(scenario: scenario, viewerRelationship: .patient)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-reconcile-all",
            deliveryID: "delivery-reconcile-all"
        )
        let assignment = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 1,
            assignedRole: .goToPatient,
            responderFixtureIndex: 0,
            assignmentID: "assignment-reconcile-all",
            at: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        )
        let receipt = AedAcquiredReceipt(
            receiptId: "receipt-reconcile-all",
            eventId: event.id,
            assignmentId: assignment.id,
            aedId: "aed-reconcile-all",
            acquiredAt: scenario.watchObservation.callFirstObservedAt ?? scenario.watchObservation.fallDetectedAt
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let stream = FakeEventStream()
        let store = makeAcceptedStore(scenario: scenario, api: api) { stream }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            let listRequestCount = await api.listEventsRequestCount()
            return store.connectionState == .connected
                && listRequestCount >= 1
                && store.runtimeRole == .patient
        }

        stream.send(.patientActivated(eventID: event.id))
        stream.send(.patientPositionUpdated(eventID: event.id, coordinationRevision: 1))
        stream.send(.coordinationUpdated(eventID: event.id, coordination: .empty))
        stream.send(
            .responseDecisionRecorded(
                eventID: event.id,
                decision: .accept,
                coordination: .empty
            )
        )
        stream.send(.responseRequested(request))
        stream.send(.falseAlarmConfirmed(eventID: event.id))
        stream.send(.eventResolved(eventID: event.id))
        stream.send(.assignmentCreated(assignment))
        stream.send(.assignmentUpdated(assignment))
        stream.send(.aedAcquired(receipt))
        stream.send(
            .aedUnavailable(
                assignmentID: assignment.id,
                eventID: event.id,
                aedID: "aed-reconcile-all"
            )
        )
        stream.send(.assignmentTimedOut(assignmentID: assignment.id, eventID: event.id))

        try await waitUntil {
            let requestedEventIDs = await api.requestedEventIDs()
            let listRequestCount = await api.listEventsRequestCount()
            return requestedEventIDs.count >= 10 && listRequestCount >= 2
        }
        // A terminal Socket hint is monotonic locally; a stale ACTIVE REST
        // fixture cannot reopen it. This test verifies reconciliation was
        // scheduled for every hint, not terminal-state rollback.
        XCTAssertEqual(store.runtimeRole, .neutral)
        XCTAssertNil(store.responseRequest)
        XCTAssertNil(store.assignment)
    }

    func testEventParticipantCapturesNoNewFixWithoutCopyingOldCoordinate() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }

        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-no-new-fix",
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])
        let slot = Date(timeIntervalSince1970: 1_788_000_101)
        for offset in 0..<5 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: slot.addingTimeInterval(TimeInterval(offset))
            ))
        }
        let state = try queue.load()
        let record = try XCTUnwrap(state.pendingBatches.last?.batch.records.first)
        XCTAssertEqual(record.status, .noNewFix)
        XCTAssertNil(record.position)
    }

    func testSecondaryPatientProjectionWithCanPublishFalseNeverStartsEventPositionSampling() async throws {
        let scenario = try loadScenario()
        let event = makeEvent(
            scenario: scenario,
            eventID: "event-secondary-read-only",
            viewerRelationship: .patient,
            canPublishEventPosition: false
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.runtimeRole == .patient }

        XCTAssertFalse(event.canPublishEventPosition)
        XCTAssertNil(store.positionPublishingMode)
        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_101),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > eventBatchCount }
        XCTAssertFalse(
            store.captureEventPositionSlot(at: Date(timeIntervalSince1970: 1_788_000_102))
        )
        let eventBatches = await api.eventPositionBatchRecords()
        let patientUpdates = await api.patientUpdates()
        let responderUpdates = await api.responderPositionUpdates()
        XCTAssertTrue(eventBatches.isEmpty)
        XCTAssertTrue(patientUpdates.isEmpty)
        XCTAssertTrue(responderUpdates.isEmpty)
    }

    func testEventParticipantFlushesFiveSecondBatchAndAcknowledgementRemovesIt() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-five-second-batch",
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])

        let start = Date(timeIntervalSince1970: 1_788_000_101)
        for offset in 0..<5 {
            XCTAssertTrue(
                store.captureEventPositionSlot(at: start.addingTimeInterval(TimeInterval(offset)))
            )
        }
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        let sentRecords = await api.eventPositionBatchRecords()
        let sent = try XCTUnwrap(sentRecords.first)
        XCTAssertEqual(sent.batch.records.count, 5)
        try await waitUntil { (try? queue.load().pendingBatches.isEmpty) == true }
    }

    func testEventPositionBatchFailureRetainsBatchUntilLaterACK() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        await api.failNextEventPositionBatches(1)
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-batch-retry",
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])

        let start = Date(timeIntervalSince1970: 1_788_000_101)
        for offset in 0..<5 {
            XCTAssertTrue(
                store.captureEventPositionSlot(at: start.addingTimeInterval(TimeInterval(offset)))
            )
        }
        try await waitUntil {
            await api.eventPositionBatchAttemptRecords().count == 1
                && store.lastError?.contains("上报失败") == true
        }
        XCTAssertFalse((try queue.load().pendingBatches).isEmpty)
        let batches = await api.eventPositionBatchRecords()
        XCTAssertTrue(batches.isEmpty)
        XCTAssertTrue(store.lastError?.contains("上报失败") == true)
    }

    func testEventParticipantSendsEarlyAfterTenMetersAndDoesNotUseStandbyEndpoint() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-early-batch",
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])

        let firstEventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_101.1),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > firstEventBatchCount }
        XCTAssertTrue(store.captureEventPositionSlot(at: Date(timeIntervalSince1970: 1_788_000_101)))
        let secondEventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.54312,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_102.1),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > secondEventBatchCount }
        XCTAssertTrue(store.captureEventPositionSlot(at: Date(timeIntervalSince1970: 1_788_000_102)))

        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        let sentRecords = await api.eventPositionBatchRecords()
        let sent = try XCTUnwrap(sentRecords.first)
        XCTAssertEqual(sent.eventID, "event-early-batch")
        XCTAssertEqual(sent.batch.records.count, 2)
        let responderUpdates = await api.responderPositionUpdates()
        let patientUpdates = await api.patientUpdates()
        XCTAssertTrue(responderUpdates.isEmpty)
        XCTAssertTrue(patientUpdates.isEmpty)
    }

    func testEventSamplingContinuesOfflineAndKeepsBatchForReconnect() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-offline-capture",
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])
        stream.send(.disconnected("offline"))

        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_101),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > eventBatchCount }
        for offset in 0..<5 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: Date(timeIntervalSince1970: 1_788_000_101 + TimeInterval(offset))
            ))
        }
        XCTAssertTrue((try queue.load().pendingBatches).count == 1)
        let batches = await api.eventPositionBatchRecords()
        XCTAssertTrue(batches.isEmpty)
    }

    func testTerminalEventDrainsLateBatchWithoutChangingStandbyMode() async throws {
        let scenario = try loadScenario()
        let eventID = "event-terminal-late"
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let record = try EventPositionRecord.noNewFix(
            recordID: "late-record",
            slotAt: utcSecondStart(now.addingTimeInterval(-10)),
            gapReason: .noFix
        )
        let batch = try EventPositionBatch(
            eventId: eventID,
            batchId: "late-batch",
            records: [record]
        )
        let persisted = try PersistedEventPositionBatch(
            serviceNamespace: "http://127.0.0.1:8787/api/v2/",
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            windowStartedAt: now.addingTimeInterval(-10),
            batch: batch
        )
        var terminal = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .patient
        )
        terminal.state = .resolved
        terminal.recruitmentState = .completed
        let api = FakeEmergencyAPIClient(events: [terminal])
        let queue = MemoryEventPositionQueueStore(
            state: EventPositionQueueState(
                pendingBatches: [persisted],
                activeContextKey: "http://127.0.0.1:8787/api/v2/|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)",
                activeGeneration: 1,
                generationsByContext: [
                    "http://127.0.0.1:8787/api/v2/|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)": 1
                ]
            )
        )
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        XCTAssertEqual(store.positionPublishingMode, .responder)
        XCTAssertTrue((try queue.load().pendingBatches).isEmpty)
    }

    func testEventPositionPersistenceFailureDoesNotClaimQueuedOrSend() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-persistence-failure",
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])
        queue.setFailSave(true)

        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: Date(timeIntervalSince1970: 1_788_000_101),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > eventBatchCount }
        XCTAssertFalse(
            store.captureEventPositionSlot(at: Date(timeIntervalSince1970: 1_788_000_102))
        )
        XCTAssertTrue((try queue.load().pendingBatches).isEmpty)
        let batches = await api.eventPositionBatchRecords()
        XCTAssertTrue(batches.isEmpty)
        XCTAssertTrue(store.lastError?.contains("保存失败") == true)
    }

    func testEventPositionGroupsBatchCallbackBySecondAndKeepsLatestFixPerSlot() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        let eventID = "event-slot-grouping"
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])

        let start = Date(timeIntervalSince1970: 1_788_000_101)
        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocations([
            (22.1980, 113.5430, 8, start.addingTimeInterval(0.10)),
            (22.1988, 113.5438, 7, start.addingTimeInterval(0.80)),
            // Keep the next-second fix below the independent 10 m early-send
            // threshold; this test isolates callback grouping and same-slot
            // latest-fix selection. Movement batching has its own test.
            (22.19881, 113.54381, 7, start.addingTimeInterval(1.20))
        ], to: locationProvider)
        try await waitUntil {
            store.locationBatchConsumptionCount > eventBatchCount
                && (try? queue.load().openDraftsByContext.values
                    .flatMap(\.candidates).count) == 2
        }
        for offset in 0..<5 {
            XCTAssertTrue(store.captureEventPositionSlot(at: start.addingTimeInterval(TimeInterval(offset))))
        }

        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        let sentBatches = await api.eventPositionBatchRecords()
        let sent = try XCTUnwrap(sentBatches.first?.batch)
        XCTAssertEqual(sent.records.count, 5)
        XCTAssertEqual(sent.records.map(\.slotAt), (0..<5).map {
            start.addingTimeInterval(TimeInterval($0))
        })
        let firstSlot = try XCTUnwrap(sent.records.first)
        XCTAssertEqual(firstSlot.status, .fix)
        XCTAssertEqual(firstSlot.fixObservedAt, start.addingTimeInterval(0.80))
        XCTAssertEqual(firstSlot.slotAt, start)
        let secondSlot = try XCTUnwrap(sent.records[1])
        XCTAssertEqual(secondSlot.status, .fix)
        XCTAssertEqual(secondSlot.fixObservedAt, start.addingTimeInterval(1.20))
        XCTAssertTrue(sent.records.dropFirst(2).allSatisfy { record in
            record.status == .noNewFix && record.gapReason == .noFix && record.position == nil
        })
    }

    func testEventPositionLateFixCannotOverwriteFinalizedSlot() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let locationProvider = LocationProvider(manager: nil)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        let eventID = "event-finalized-late-fix"
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])
        let start = Date(timeIntervalSince1970: 1_788_000_101)
        let firstEventBatchCount = store.locationBatchConsumptionCount
        publishLocations([
            (22.1980, 113.5430, 8, start.addingTimeInterval(0.20))
        ], to: locationProvider)
        try await waitUntil { store.locationBatchConsumptionCount > firstEventBatchCount }
        for offset in 0..<5 {
            XCTAssertTrue(store.captureEventPositionSlot(at: start.addingTimeInterval(TimeInterval(offset))))
        }
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        XCTAssertEqual(store.eventPositionLateFixDiscardCount, 0)

        let secondEventBatchCount = store.locationBatchConsumptionCount
        publishLocations([
            (22.2100, 113.5550, 5, start.addingTimeInterval(0.90))
        ], to: locationProvider)
        try await waitUntil {
            store.locationBatchConsumptionCount > secondEventBatchCount
                && store.eventPositionLateFixDiscardCount == 1
        }
        let attempts = await api.eventPositionBatchAttempts()
        XCTAssertEqual(attempts.count, 1)
    }

    func testRestoredContextFillsMissingSlotsAsAppNotRunningAfterHistoricalFixGrace() async throws {
        let scenario = try loadScenario()
        let eventID = "event-restart-gap"
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let finalized = Date(timeIntervalSince1970: 1_788_000_095)
        let queue = MemoryEventPositionQueueStore(
            state: EventPositionQueueState(
                activeContextKey: key,
                activeGeneration: 1,
                generationsByContext: [key: 1],
                lastFinalizedSlotAtByContext: [key: finalized]
            )
        )
        let locationProvider = LocationProvider(manager: nil)
        let store = makeAcceptedStore(
            scenario: scenario,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: true
            )
        ])
        let recoveredSlot = Date(timeIntervalSince1970: 1_788_000_098)
        let eventBatchCount = store.locationBatchConsumptionCount
        publishLocations([
            (22.1980, 113.5430, 8, recoveredSlot.addingTimeInterval(0.60))
        ], to: locationProvider)
        try await waitUntil {
            store.locationBatchConsumptionCount > eventBatchCount
                && (try? queue.load().openDraftsByContext[key]?.candidates
                    .contains(where: { $0.slotAt == recoveredSlot })) == true
        }
        XCTAssertTrue(
            store.completeRecoveredEventPositionSlots(
                at: Date(timeIntervalSince1970: 1_788_000_100), maximumSlots: 2
            )
        )
        XCTAssertEqual(try queue.load().pendingBatches.flatMap { $0.batch.records }.count, 2)
        XCTAssertTrue(store.completeRecoveredEventPositionSlots(
            at: Date(timeIntervalSince1970: 1_788_000_100), maximumSlots: 2
        ))
        let pending = try queue.load().pendingBatches
        let records = pending.flatMap { $0.batch.records }
        XCTAssertEqual(records.count, 4)
        XCTAssertEqual(records.filter { $0.status == .fix }.count, 1)
        XCTAssertEqual(records.first(where: { $0.slotAt == recoveredSlot })?.fixObservedAt,
                       recoveredSlot.addingTimeInterval(0.60))
        XCTAssertEqual(
            records.filter { $0.status == .noNewFix }.map(\.gapReason),
            [.appNotRunning, .appNotRunning, .appNotRunning]
        )
    }

    func testFractionalParticipationStartSkipsPartialFirstSecond() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100.25)
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            now: now,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-fractional-start",
                viewerRelationship: .patient,
                canPublishEventPosition: true,
                eventPositionParticipationStartedAt: now
            )
        ])

        XCTAssertFalse(store.captureEventPositionSlot(at: utcSecondStart(now)))
        XCTAssertTrue(store.captureEventPositionSlot(at: utcSecondCeiling(now)))
    }

    func testDelayedRestProjectionStartsAtAuthorityAndRetainsCompletedSlots() async throws {
        let scenario = try loadScenario()
        let authorityStart = Date(timeIntervalSince1970: 1_788_000_100)
        let now = authorityStart.addingTimeInterval(2.4)
        let queue = MemoryEventPositionQueueStore()
        let locationProvider = LocationProvider(manager: nil)
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue,
            now: now,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.positionPublishingMode == .responder }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: "event-delayed-rest-start",
                viewerRelationship: .patient,
                canPublishEventPosition: true,
                eventPositionParticipationStartedAt: authorityStart
            )
        ])

        let consumed = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: authorityStart.addingTimeInterval(0.6),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > consumed }
        XCTAssertFalse(store.captureEventPositionSlot(at: authorityStart))
        XCTAssertFalse(store.captureEventPositionSlot(at: authorityStart.addingTimeInterval(1)))
        XCTAssertTrue(store.completeRecoveredEventPositionSlots(
            at: now.addingTimeInterval(5)
        ))
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }

        let batches = await api.eventPositionBatchRecords()
        let records = try XCTUnwrap(batches.first?.batch.records)
        XCTAssertEqual(records.map(\.slotAt), [
            authorityStart,
            authorityStart.addingTimeInterval(1)
        ])
        XCTAssertEqual(records[0].status, .fix)
        XCTAssertEqual(records[0].fixObservedAt, authorityStart.addingTimeInterval(0.6))
        XCTAssertEqual(records[1].status, .noNewFix)
        XCTAssertEqual(records[1].gapReason, .appNotRunning)

        for offset in 2..<7 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: authorityStart.addingTimeInterval(TimeInterval(offset))
            ))
        }
        try await waitUntil { await api.eventPositionBatchRecords().count == 2 }
        let allBatches = await api.eventPositionBatchRecords()
        XCTAssertTrue(allBatches[1].batch.records.allSatisfy {
            $0.status == .noNewFix && $0.gapReason == .noFix
        })
    }

    func testRestoredContextCannotPersistNewFixBeforeActiveRestAuthority() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-stale-restored-context"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let slot = Date(timeIntervalSince1970: 1_788_000_095)
        let draft = try EventPositionOpenDraft(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            openSlots: [slot],
            clockedSlots: [slot],
            candidates: []
        )
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            openDraftsByContext: [key: draft]
        ))
        let locationProvider = LocationProvider(manager: nil)
        let store = makeAcceptedStore(
            scenario: scenario,
            locationProvider: locationProvider,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }

        let firstEventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: slot.addingTimeInterval(1.6),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > firstEventBatchCount }
        XCTAssertTrue(try XCTUnwrap(queue.load().openDraftsByContext[key]).candidates.isEmpty)

        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: false,
                state: .resolved,
                eventPositionParticipationStartedAt: slot.addingTimeInterval(-10),
                eventPositionParticipationEndedAt: slot.addingTimeInterval(1)
            )
        ])
        let secondEventBatchCount = store.locationBatchConsumptionCount
        publishLocation(
            latitude: 22.199,
            longitude: 113.544,
            accuracyMeters: 7,
            observedAt: slot.addingTimeInterval(0.8),
            to: locationProvider
        )
        try await waitUntil { store.locationBatchConsumptionCount > secondEventBatchCount }
        XCTAssertTrue(try queue.load().openDraftsByContext[key]?.candidates.isEmpty ?? true)
    }

    func testAuthoritativeEndRegroupsPendingLegalRecordsAndQuarantinesSuffix() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-pending-window-split"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_102)
        let fixPosition = try PatientPosition(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8
        )
        let originalRecords = try (0..<5).map { offset in
            if offset == 2 {
                return try EventPositionRecord.fix(
                    recordID: "original-record-\(offset)",
                    slotAt: firstSlot.addingTimeInterval(TimeInterval(offset)),
                    fixObservedAt: firstSlot.addingTimeInterval(TimeInterval(offset) + 0.4),
                    position: .patient(fixPosition)
                )
            }
            return try EventPositionRecord.noNewFix(
                recordID: "original-record-\(offset)",
                slotAt: firstSlot.addingTimeInterval(TimeInterval(offset)),
                gapReason: .noFix
            )
        }
        let original = try PersistedEventPositionBatch(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            windowStartedAt: firstSlot,
            batch: try EventPositionBatch(
                eventId: eventID,
                batchId: "original-mixed-batch",
                records: originalRecords
            )
        )
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            pendingBatches: [original],
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            lastFinalizedSlotAtByContext: [key: firstSlot.addingTimeInterval(4)]
        ))
        let store = makeAcceptedStore(
            scenario: scenario,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }
        let startedAt = firstSlot.addingTimeInterval(1)
        let endedAt = firstSlot.addingTimeInterval(4)
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: false,
                state: .resolved,
                eventPositionParticipationStartedAt: startedAt,
                eventPositionParticipationEndedAt: endedAt
            )
        ])

        let state = try queue.load()
        let regrouped = try XCTUnwrap(state.pendingBatches.first)
        XCTAssertNotEqual(regrouped.batch.batchId, original.batch.batchId)
        XCTAssertEqual(regrouped.batch.records, Array(originalRecords[1...3]))
        XCTAssertEqual(regrouped.batch.records[1].status, .fix)
        XCTAssertEqual(regrouped.batch.records[1].position, originalRecords[2].position)
        XCTAssertNil(regrouped.blockedReason)
        XCTAssertEqual(state.quarantinedEvidence.map(\.record), [
            originalRecords[0], originalRecords[4]
        ])
        XCTAssertEqual(state.quarantinedEvidence.first?.originalBatchId, original.batch.batchId)
        XCTAssertEqual(state.quarantinedEvidence.map(\.reason), [
            .beforeParticipationStart, .participationEnded
        ])
        let retainedIDs = regrouped.batch.records.map(\.recordId)
            + state.quarantinedEvidence.compactMap { $0.record?.recordId }
        XCTAssertEqual(Set(retainedIDs), Set(originalRecords.map(\.recordId)))
        XCTAssertEqual(retainedIDs.count, originalRecords.count)
    }

    func testActiveStartOnlyProjectionQuarantinesLegacyFloorSlotInPendingAndOpenDraft() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-start-only-lower-bound"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let floorSlot = Date(timeIntervalSince1970: 1_788_000_100)
        let records = try (0..<2).map { offset in
            try EventPositionRecord.noNewFix(
                recordID: "legacy-floor-\(offset)",
                slotAt: floorSlot.addingTimeInterval(TimeInterval(offset)),
                gapReason: .noFix
            )
        }
        let pending = try PersistedEventPositionBatch(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            windowStartedAt: floorSlot,
            batch: try EventPositionBatch(
                eventId: eventID,
                batchId: "legacy-floor-batch",
                records: records
            )
        )
        let coordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: floorSlot.addingTimeInterval(0.8)
        )
        let draft = try EventPositionOpenDraft(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            openSlots: [floorSlot],
            clockedSlots: [],
            candidates: [EventPositionSlotCandidate(slotAt: floorSlot, coordinate: coordinate)]
        )
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            pendingBatches: [pending],
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            lastFinalizedSlotAtByContext: [key: floorSlot.addingTimeInterval(1)],
            openDraftsByContext: [key: draft]
        ))
        let store = makeAcceptedStore(
            scenario: scenario,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: true,
                eventPositionParticipationStartedAt: floorSlot.addingTimeInterval(0.5)
            )
        ])

        let state = try queue.load()
        XCTAssertEqual(state.pendingBatches.first?.batch.records, [records[1]])
        XCTAssertNil(state.openDraftsByContext[key])
        XCTAssertEqual(state.quarantinedEvidence.count, 2)
        XCTAssertTrue(state.quarantinedEvidence.allSatisfy {
            $0.slotAt == floorSlot && $0.reason == .beforeParticipationStart
        })
    }

    func testAuthoritativeEndClocksAndSealsValidUnclockedFinalFix() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-final-unclocked-fix"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let slot = Date(timeIntervalSince1970: 1_788_000_105)
        let coordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: slot.addingTimeInterval(0.2)
        )
        let draft = try EventPositionOpenDraft(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            openSlots: [slot],
            clockedSlots: [],
            candidates: [EventPositionSlotCandidate(slotAt: slot, coordinate: coordinate)]
        )
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            openDraftsByContext: [key: draft]
        ))
        let store = makeAcceptedStore(
            scenario: scenario,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: false,
                state: .resolved,
                eventPositionParticipationStartedAt: slot.addingTimeInterval(-10),
                eventPositionParticipationEndedAt: slot.addingTimeInterval(0.5)
            )
        ])

        let state = try queue.load()
        let record = try XCTUnwrap(state.pendingBatches.first?.batch.records.first)
        XCTAssertEqual(record.status, .fix)
        XCTAssertEqual(record.recordId.isEmpty, false)
        XCTAssertEqual(record.slotAt, slot)
        XCTAssertEqual(record.fixObservedAt, coordinate.observedAt)
        XCTAssertNil(state.openDraftsByContext[key])
    }

    func testUnconfirmedCloseSocketHintPausesWithoutSealingUntilRestWindowArrives() async throws {
        let scenario = try loadScenario()
        let eventID = "event-terminal-hint-window"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_101)
        let active = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .patient,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: firstSlot.addingTimeInterval(-1)
        )
        let api = FakeEmergencyAPIClient(events: [active])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { await api.listEventsRequestCount() >= 1 }
        store.applyServerSnapshot([active])
        for offset in 0..<3 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: firstSlot.addingTimeInterval(TimeInterval(offset))
            ))
        }

        let terminal = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .patient,
            canPublishEventPosition: false,
            state: .closedUnconfirmedNoResponse,
            eventPositionParticipationStartedAt: firstSlot.addingTimeInterval(-1),
            eventPositionParticipationEndedAt: firstSlot.addingTimeInterval(1.5)
        )
        await api.setEvents([terminal])
        await api.suspendNextListEventsResponse()
        stream.send(.eventClosedUnconfirmedNoResponse(eventID: eventID))
        try await waitUntil { await api.hasSuspendedListEventsResponse() }

        let paused = try queue.load()
        XCTAssertTrue(paused.pendingBatches.isEmpty)
        XCTAssertEqual(paused.openDraftsByContext.values.first?.clockedSlots.count, 3)
        XCTAssertNil(store.positionPublishingMode)
        XCTAssertFalse(store.captureEventPositionSlot(
            at: firstSlot.addingTimeInterval(3)
        ))
        let batchesBeforeRest = await api.eventPositionBatchRecords()
        XCTAssertTrue(batchesBeforeRest.isEmpty)

        await api.resumeSuspendedListEventsResponse()
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }
        let reconciled = try queue.load()
        let sentRecords = await api.eventPositionBatchRecords()
        let sent = try XCTUnwrap(sentRecords.first)
        XCTAssertEqual(sent.batch.records.map(\.slotAt), [
            firstSlot,
            firstSlot.addingTimeInterval(1)
        ])
        XCTAssertEqual(reconciled.quarantinedEvidence.first?.slotAt,
                       firstSlot.addingTimeInterval(2))
    }

    func testAssignmentTimeoutHintAlsoWaitsForNeutralRestWindowBeforeSealing() async throws {
        let scenario = try loadScenario()
        let eventID = "event-timeout-hint-window"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_101)
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-timeout-window",
            deliveryID: "delivery-timeout-window"
        )
        let assignment = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 1,
            assignedRole: .goToPatient,
            responderFixtureIndex: 0,
            assignmentID: "assignment-timeout-window",
            at: firstSlot.addingTimeInterval(-1)
        )
        let active = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: Assignment(
                id: assignment.id,
                eventId: eventID,
                role: assignment.role,
                status: assignment.status,
                revision: assignment.revision,
                route: assignment.route,
                aedAcquiredReceipt: assignment.aedAcquiredReceipt
            ),
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: firstSlot.addingTimeInterval(-1)
        )
        let api = FakeEmergencyAPIClient(events: [active])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { await api.listEventsRequestCount() >= 1 }
        store.applyServerSnapshot([active])
        for offset in 0..<3 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: firstSlot.addingTimeInterval(TimeInterval(offset))
            ))
        }

        await api.setEvents([])
        stream.send(.assignmentTimedOut(
            assignmentID: assignment.id,
            eventID: eventID
        ))
        await Task.yield()
        XCTAssertEqual(
            store.assignment?.status,
            assignment.status,
            "Socket 超时提示只能触发 REST 对账，不能先把本地任务投影改成 TIMED_OUT"
        )
        let paused = try queue.load()
        XCTAssertTrue(paused.pendingBatches.isEmpty)
        XCTAssertEqual(paused.openDraftsByContext.values.first?.clockedSlots.count, 3)
        XCTAssertNil(store.positionPublishingMode)
        XCTAssertFalse(store.captureEventPositionSlot(
            at: firstSlot.addingTimeInterval(3)
        ))
        let batchesBeforeRest = await api.eventPositionBatchRecords()
        XCTAssertTrue(batchesBeforeRest.isEmpty)

        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .neutral,
                canPublishEventPosition: false,
                state: .active,
                eventPositionParticipationStartedAt: firstSlot.addingTimeInterval(-1),
                eventPositionParticipationEndedAt: firstSlot.addingTimeInterval(1.5)
            )
        ])
        let reconciled = try queue.load()
        XCTAssertEqual(reconciled.pendingBatches.first?.batch.records.map(\.slotAt), [
            firstSlot,
            firstSlot.addingTimeInterval(1)
        ])
        XCTAssertEqual(reconciled.quarantinedEvidence.first?.slotAt,
                       firstSlot.addingTimeInterval(2))
    }

    func testTerminalAssignmentUpdatedPausesCurrentResponderDraftUntilRest() async throws {
        let scenario = try loadScenario()
        let eventID = "event-assignment-update-window"
        let slot = Date(timeIntervalSince1970: 1_788_000_101)
        let assignment = Assignment(
            id: "assignment-update-window",
            eventId: eventID,
            role: .goToPatient,
            status: .assigned,
            revision: 1,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let active = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: assignment,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: slot
        )
        let api = FakeEmergencyAPIClient(events: [active])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.positionPublishingMode == .responderEvent(eventID: eventID)
        }
        XCTAssertTrue(store.captureEventPositionSlot(at: slot))
        await api.setEvents([])
        var cancelled = assignment
        cancelled.status = .cancelled
        stream.send(.assignmentUpdated(cancelled))

        XCTAssertEqual(store.assignment?.status, .cancelled)
        XCTAssertNil(store.positionPublishingMode)
        XCTAssertFalse(store.captureEventPositionSlot(at: slot.addingTimeInterval(1)))
        XCTAssertTrue(try queue.load().pendingBatches.isEmpty)
        XCTAssertEqual(try queue.load().openDraftsByContext.values.first?.clockedSlots, [slot])
    }

    func testStaleTerminalAssignmentUpdateDoesNotPauseNewerActiveRevision() async throws {
        let scenario = try loadScenario()
        let eventID = "event-stale-terminal-assignment"
        let slot = Date(timeIntervalSince1970: 1_788_000_101)
        let activeAssignment = Assignment(
            id: "assignment-stale-terminal",
            eventId: eventID,
            role: .goToPatient,
            status: .enRoute,
            revision: 2,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: activeAssignment,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: slot
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.positionPublishingMode == .responderEvent(eventID: eventID)
                && store.assignment?.revision == 2
        }
        XCTAssertTrue(store.captureEventPositionSlot(at: slot))
        await api.setEvents([])
        var staleTerminal = activeAssignment
        staleTerminal.status = .cancelled
        // Keep revision 1 by constructing the stale payload explicitly.
        staleTerminal = Assignment(
            id: staleTerminal.id,
            eventId: staleTerminal.eventId,
            role: staleTerminal.role,
            status: staleTerminal.status,
            revision: 1,
            route: staleTerminal.route,
            aedAcquiredReceipt: staleTerminal.aedAcquiredReceipt
        )
        stream.send(.assignmentUpdated(staleTerminal))

        XCTAssertEqual(store.assignment, activeAssignment)
        XCTAssertEqual(store.positionPublishingMode, .responderEvent(eventID: eventID))
        XCTAssertTrue(store.captureEventPositionSlot(at: slot.addingTimeInterval(1)))
        XCTAssertEqual(
            try queue.load().openDraftsByContext.values.first?.clockedSlots,
            [slot, slot.addingTimeInterval(1)]
        )
    }

    func testOlderDifferentAssignmentCreatedAndUpdatedCannotOverrideReplacementOrPause() async throws {
        let scenario = try loadScenario()
        let eventID = "event-replacement-ordering"
        let slot = Date(timeIntervalSince1970: 1_788_000_101)
        let replacement = Assignment(
            id: "assignment-replacement-new",
            eventId: eventID,
            role: .goToPatient,
            status: .enRoute,
            revision: 5,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: replacement,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: slot
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.assignment == replacement
                && store.positionPublishingMode == .responderEvent(eventID: eventID)
        }
        XCTAssertTrue(store.captureEventPositionSlot(at: slot))
        await api.setEvents([])

        let oldCreated = Assignment(
            id: "assignment-old-aed",
            eventId: eventID,
            role: .goToPatient,
            status: .assigned,
            revision: 3,
            route: nil,
            aedAcquiredReceipt: nil
        )
        stream.send(.assignmentCreated(oldCreated))
        var lateUnavailable = oldCreated
        lateUnavailable.status = .aedUnavailable
        stream.send(.assignmentUpdated(lateUnavailable))
        var lateCancelled = oldCreated
        lateCancelled.status = .cancelled
        stream.send(.assignmentUpdated(lateCancelled))

        XCTAssertEqual(store.assignment, replacement)
        XCTAssertEqual(store.positionPublishingMode, .responderEvent(eventID: eventID))
        XCTAssertTrue(store.captureEventPositionSlot(at: slot.addingTimeInterval(1)))
        XCTAssertEqual(
            try queue.load().openDraftsByContext.values.first?.clockedSlots,
            [slot, slot.addingTimeInterval(1)]
        )
    }

    func testDelayedAedUnavailableHTTPCompletionCannotOverwriteSocketReplacement() async throws {
        let scenario = try loadScenario()
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-aed-http-order",
            deliveryID: "delivery-aed-http-order"
        )
        let generated = try DemoAssignmentFactory().makeAssignment(
            request: request,
            scenario: scenario,
            acceptedCount: 3,
            assignedRole: .fetchAed,
            responderFixtureIndex: 0,
            assignmentID: "assignment-old-aed-http",
            at: Date(timeIntervalSince1970: 1_788_000_100)
        )
        let oldAssignment = Assignment(
            id: generated.id,
            eventId: generated.eventId,
            role: generated.role,
            status: generated.status,
            revision: 3,
            route: generated.route,
            aedAcquiredReceipt: nil
        )
        let slot = Date(timeIntervalSince1970: 1_788_000_101)
        let oldEvent = makeEvent(
            scenario: scenario,
            eventID: oldAssignment.eventId,
            viewerRelationship: .responder,
            currentAssignment: oldAssignment,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: slot
        )
        let api = FakeEmergencyAPIClient(events: [oldEvent])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.assignment == oldAssignment
                && store.positionPublishingMode == .responderEvent(
                    eventID: oldAssignment.eventId
                )
        }
        XCTAssertTrue(store.captureEventPositionSlot(at: slot))

        await api.suspendNextAedUnavailableReportUntilResumed()
        store.reportAssignedAedUnavailable()
        try await waitUntil { await api.hasSuspendedAedUnavailableReport() }

        let replacement = Assignment(
            id: "assignment-replacement-after-aed",
            eventId: oldAssignment.eventId,
            role: .goToPatient,
            status: .assigned,
            revision: 5,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let replacementEvent = makeEvent(
            scenario: scenario,
            eventID: oldAssignment.eventId,
            viewerRelationship: .responder,
            currentAssignment: replacement,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: slot
        )
        await api.setEvents([replacementEvent])
        let eventRequestsBeforeReplacement = await api.requestedEventIDs().count
        stream.send(.assignmentCreated(replacement))
        XCTAssertEqual(store.assignment, replacement)

        await api.resumeSuspendedAedUnavailableReport()
        try await waitUntil {
            let completed = await api.completedAedUnavailableReportCount()
            let eventRequestCount = await api.requestedEventIDs().count
            return completed == 1
                && eventRequestCount >= eventRequestsBeforeReplacement + 2
                && store.assignment == replacement
        }

        XCTAssertEqual(store.assignment, replacement)
        XCTAssertNotEqual(store.assignment?.status, .aedUnavailable)
        XCTAssertEqual(
            store.positionPublishingMode,
            .responderEvent(eventID: oldAssignment.eventId)
        )
        XCTAssertTrue(store.captureEventPositionSlot(at: slot.addingTimeInterval(1)))
        XCTAssertEqual(
            try queue.load().openDraftsByContext.values.first?.clockedSlots,
            [slot, slot.addingTimeInterval(1)]
        )
    }

    func testPatientPriorityRestSnapshotClosesMissingResponderContextAndStartsNewPatientStream() async throws {
        let scenario = try loadScenario()
        let oldEventID = "event-old-responder-priority"
        let newEventID = "event-new-patient-priority"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_100)
        let assignment = Assignment(
            id: "assignment-old-responder-priority",
            eventId: oldEventID,
            role: .goToPatient,
            status: .assigned,
            revision: 1,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let oldResponder = makeEvent(
            scenario: scenario,
            eventID: oldEventID,
            viewerRelationship: .responder,
            currentAssignment: assignment,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: firstSlot,
            createdAt: firstSlot.addingTimeInterval(-30)
        )
        let priorityAt = firstSlot.addingTimeInterval(2.5)
        let newPatient = makeEvent(
            scenario: scenario,
            eventID: newEventID,
            viewerRelationship: .patient,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: priorityAt,
            createdAt: priorityAt
        )
        let api = FakeEmergencyAPIClient(events: [oldResponder])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.positionPublishingMode == .responderEvent(eventID: oldEventID)
        }
        for offset in 0..<4 {
            XCTAssertTrue(store.captureEventPositionSlot(
                at: firstSlot.addingTimeInterval(TimeInterval(offset))
            ))
        }

        await api.setEvents([newPatient])
        stream.send(.patientActivated(eventID: newEventID))
        try await waitUntil {
            store.positionPublishingMode == .patient(eventID: newEventID)
                && (try? queue.load().quarantinedEvidence.count) == 1
        }
        try await waitUntil { await api.eventPositionBatchRecords().count == 1 }

        let sentRecords = await api.eventPositionBatchRecords()
        let sent = try XCTUnwrap(sentRecords.first)
        XCTAssertEqual(sent.eventID, oldEventID)
        XCTAssertEqual(sent.batch.records.map(\.slotAt), [
            firstSlot,
            firstSlot.addingTimeInterval(1),
            firstSlot.addingTimeInterval(2)
        ])
        XCTAssertEqual(try queue.load().quarantinedEvidence.first?.slotAt,
                       firstSlot.addingTimeInterval(3))
        XCTAssertFalse(store.captureEventPositionSlot(at: utcSecondStart(priorityAt)))
        XCTAssertTrue(store.captureEventPositionSlot(at: utcSecondCeiling(priorityAt)))
    }

    func testPatientPriorityReadOnlyPhoneClosesOldResponderButNeverStartsPatientPublishing() async throws {
        let scenario = try loadScenario()
        let oldEventID = "event-old-responder-secondary"
        let newEventID = "event-new-patient-secondary"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_100)
        let oldResponder = makeEvent(
            scenario: scenario,
            eventID: oldEventID,
            viewerRelationship: .responder,
            currentAssignment: Assignment(
                id: "assignment-old-responder-secondary",
                eventId: oldEventID,
                role: .goToPatient,
                status: .assigned,
                revision: 1,
                route: nil,
                aedAcquiredReceipt: nil
            ),
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: firstSlot
        )
        let priorityAt = firstSlot.addingTimeInterval(1.5)
        let readOnlyPatient = makeEvent(
            scenario: scenario,
            eventID: newEventID,
            viewerRelationship: .patient,
            canPublishEventPosition: false,
            eventPositionParticipationStartedAt: nil,
            createdAt: priorityAt
        )
        let api = FakeEmergencyAPIClient(events: [oldResponder])
        let queue = MemoryEventPositionQueueStore()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.positionPublishingMode == .responderEvent(eventID: oldEventID)
        }
        XCTAssertTrue(store.captureEventPositionSlot(at: firstSlot))
        XCTAssertTrue(store.captureEventPositionSlot(at: firstSlot.addingTimeInterval(1)))

        await api.setEvents([readOnlyPatient])
        stream.send(.patientActivated(eventID: newEventID))
        try await waitUntil {
            let sentCount = await api.eventPositionBatchRecords().count
            return store.runtimeRole == .patient
                && store.positionPublishingMode == nil
                && sentCount == 1
        }
        let sentRecords = await api.eventPositionBatchRecords()
        XCTAssertEqual(sentRecords.first?.batch.records.count, 2)
        XCTAssertFalse(store.captureEventPositionSlot(at: utcSecondCeiling(priorityAt)))
    }

    func testAuthoritativeEndSealsOpenLegalPrefixAndQuarantinesInvalidDraftFacts() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-open-window-split"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_102)
        let lateCoordinate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: firstSlot.addingTimeInterval(3.8)
        )
        let draft = try EventPositionOpenDraft(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            openSlots: (0..<5).map { firstSlot.addingTimeInterval(TimeInterval($0)) },
            clockedSlots: (0..<5).map { firstSlot.addingTimeInterval(TimeInterval($0)) },
            candidates: [EventPositionSlotCandidate(
                slotAt: firstSlot.addingTimeInterval(3),
                coordinate: lateCoordinate
            )]
        )
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            openDraftsByContext: [key: draft]
        ))
        let store = makeAcceptedStore(
            scenario: scenario,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: false,
                state: .resolved,
                eventPositionParticipationStartedAt: firstSlot,
                eventPositionParticipationEndedAt: firstSlot.addingTimeInterval(3.5)
            )
        ])

        let state = try queue.load()
        let sealed = try XCTUnwrap(state.pendingBatches.first)
        XCTAssertEqual(sealed.batch.records.map(\.slotAt), Array(draft.openSlots.prefix(4)))
        XCTAssertTrue(sealed.batch.records.allSatisfy { $0.status == .noNewFix })
        XCTAssertNil(state.openDraftsByContext[key])
        XCTAssertEqual(Set(state.quarantinedEvidence.map(\.slotAt)), [
            firstSlot.addingTimeInterval(3),
            firstSlot.addingTimeInterval(4)
        ])
        XCTAssertTrue(state.quarantinedEvidence.contains {
            $0.slotAt == firstSlot.addingTimeInterval(3)
                && $0.reason == .fixOutsideParticipationWindow
                && $0.coordinate == lateCoordinate
        })
    }

    func testPermanentRejectedBatchDoesNotBlockFollowingLegalBatch() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-permanent-rejection-drain"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_101)
        func pending(_ batchID: String, _ slot: Date) throws -> PersistedEventPositionBatch {
            let record = try EventPositionRecord.noNewFix(
                recordID: "record-\(batchID)",
                slotAt: slot,
                gapReason: .noFix
            )
            return try PersistedEventPositionBatch(
                serviceNamespace: namespace,
                userId: "user-1",
                deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
                eventId: eventID,
                role: .patient,
                generation: 1,
                windowStartedAt: slot,
                batch: try EventPositionBatch(
                    eventId: eventID,
                    batchId: batchID,
                    records: [record]
                )
            )
        }
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            pendingBatches: [
                try pending("batch-permanent", firstSlot),
                try pending("batch-good", firstSlot.addingTimeInterval(1))
            ],
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            lastFinalizedSlotAtByContext: [key: firstSlot.addingTimeInterval(1)]
        ))
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .patient,
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: firstSlot.addingTimeInterval(-10)
        )
        let api = FakeEmergencyAPIClient(events: [event])
        await api.rejectNextEventPositionBatch(status: 422)
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            eventPositionQueueStore: queue,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { await api.eventPositionBatchAttemptRecords().count == 2 }

        let attempts = await api.eventPositionBatchAttemptRecords()
        XCTAssertEqual(attempts.map(\.batchID), ["batch-permanent", "batch-good"])
        let successful = await api.eventPositionBatchRecords()
        XCTAssertEqual(successful.map(\.batchID), ["batch-good"])
        let remaining = try queue.load().pendingBatches
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining.first?.batch.batchId, "batch-permanent")
        XCTAssertNotNil(remaining.first?.blockedReason)
    }

    func testRecoveryKeepsExistingClockedGapsAsNoFixAndMarksOnlyDowntimeSlots() async throws {
        let scenario = try loadScenario()
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let eventID = "event-recovery-gap-classification"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|P|\(eventID)"
        let firstSlot = Date(timeIntervalSince1970: 1_788_000_096)
        let draft = try EventPositionOpenDraft(
            serviceNamespace: namespace,
            userId: "user-1",
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            eventId: eventID,
            role: .patient,
            generation: 1,
            openSlots: [firstSlot, firstSlot.addingTimeInterval(1)],
            clockedSlots: [firstSlot, firstSlot.addingTimeInterval(1)],
            candidates: []
        )
        let queue = MemoryEventPositionQueueStore(state: EventPositionQueueState(
            activeContextKey: key,
            activeGeneration: 1,
            generationsByContext: [key: 1],
            lastFinalizedSlotAtByContext: [key: firstSlot.addingTimeInterval(-1)],
            openDraftsByContext: [key: draft]
        ))
        let store = makeAcceptedStore(
            scenario: scenario,
            eventPositionQueueStore: queue
        )
        try await waitUntil { store.isAuthenticated }
        store.applyServerSnapshot([
            makeEvent(
                scenario: scenario,
                eventID: eventID,
                viewerRelationship: .patient,
                canPublishEventPosition: true,
                eventPositionParticipationStartedAt: firstSlot.addingTimeInterval(-10)
            )
        ])
        // Simulate the post-restart scheduler reaching the first newly
        // completed slot before the five-second recovery grace finishes.  It
        // must not backfill the intervening downtime as ordinary NO_FIX.
        XCTAssertTrue(store.captureEventPositionSlot(
            at: firstSlot.addingTimeInterval(4)
        ))
        XCTAssertTrue(store.completeRecoveredEventPositionSlots(
            at: firstSlot.addingTimeInterval(4)
        ))

        let records = try queue.load().pendingBatches.flatMap { $0.batch.records }
        XCTAssertEqual(records.map(\.slotAt), (0..<4).map {
            firstSlot.addingTimeInterval(TimeInterval($0))
        })
        XCTAssertEqual(records.map(\.gapReason), [
            .noFix, .noFix, .appNotRunning, .appNotRunning
        ])
    }

    func testSoleResponderExitDoesNotCallRESTUntilThirdConfirmationAndClearsStaleSnapshot() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let eventID = "event-appstore-sole-exit"
        let assignment = Assignment(
            id: "assignment-appstore-sole-exit",
            eventId: eventID,
            role: .goToPatient,
            status: .assigned,
            revision: 1,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: assignment,
            coordination: responderCoordination(1),
            canPublishEventPosition: false
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            now: now,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.canExitCurrentEvent && store.assignment == assignment
        }

        store.requestExitCurrentEvent()
        let firstPrompt = try XCTUnwrap(store.exitConfirmationPrompt)
        XCTAssertEqual(firstPrompt.confirmationIndex, 1)
        XCTAssertEqual(firstPrompt.requiredConfirmationCount, 3)
        XCTAssertTrue(firstPrompt.requiresSoleResponderConfirmation)
        store.confirmExitCurrentEvent(prompt: firstPrompt)
        XCTAssertEqual(store.exitConfirmationPrompt?.confirmationIndex, 2)
        var attempts = await api.exitAttemptRecords()
        XCTAssertTrue(attempts.isEmpty)
        XCTAssertEqual(store.assignment, assignment)

        let secondPrompt = try XCTUnwrap(store.exitConfirmationPrompt)
        store.confirmExitCurrentEvent(prompt: secondPrompt)
        XCTAssertEqual(store.exitConfirmationPrompt?.confirmationIndex, 3)
        attempts = await api.exitAttemptRecords()
        XCTAssertTrue(attempts.isEmpty)
        XCTAssertEqual(store.assignment, assignment)

        let thirdPrompt = try XCTUnwrap(store.exitConfirmationPrompt)
        store.confirmExitCurrentEvent(prompt: thirdPrompt)
        try await waitUntil {
            store.lastExitResult != nil && store.assignment == nil
                && store.visibleEvents.allSatisfy { $0.id != eventID }
        }
        attempts = await api.exitAttemptRecords()
        XCTAssertEqual(attempts.count, 1)
        XCTAssertTrue(attempts[0].soleResponderConfirmed == true)
        XCTAssertEqual(store.lastExitResult?.exitId, attempts[0].exitID)
        XCTAssertFalse(store.isSubmittingExit)
        XCTAssertFalse(store.exitRetryAvailable)
        XCTAssertNil(store.exitConfirmationPrompt)

        // A late REST snapshot for the old active event cannot restore the
        // exited responder projection after the local tombstone is recorded.
        store.applyServerSnapshot([event])
        XCTAssertTrue(store.visibleEvents.allSatisfy { $0.id != eventID })
        XCTAssertNil(store.assignment)
    }

    func testExitNetworkFailureRetriesTheExactSameDeclarationAndACKClearsTask() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let eventID = "event-appstore-exit-retry"
        let assignment = Assignment(
            id: "assignment-appstore-exit-retry",
            eventId: eventID,
            role: .goToPatient,
            status: .assigned,
            revision: 1,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: assignment,
            coordination: responderCoordination(2),
            canPublishEventPosition: false
        )
        let api = FakeEmergencyAPIClient(events: [event])
        await api.failNextExitRequest()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            now: now,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.canExitCurrentEvent && store.assignment == assignment }

        store.requestExitCurrentEvent()
        let prompt = try XCTUnwrap(store.exitConfirmationPrompt)
        XCTAssertFalse(prompt.requiresSoleResponderConfirmation)
        for _ in 0..<3 {
            let step = try XCTUnwrap(store.exitConfirmationPrompt)
            store.confirmExitCurrentEvent(prompt: step)
        }
        try await waitUntil {
            store.exitRetryAvailable && !store.isSubmittingExit
        }
        XCTAssertNil(store.lastExitResult)
        XCTAssertEqual(store.assignment, assignment)
        let recordedAttempts = await api.exitAttemptRecords()
        let firstAttempt = try XCTUnwrap(recordedAttempts.first)

        store.retryExitCurrentEvent()
        try await waitUntil {
            store.lastExitResult != nil && store.assignment == nil
        }
        let attempts = await api.exitAttemptRecords()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0], attempts[1])
        XCTAssertEqual(attempts[1], firstAttempt)
        XCTAssertTrue(attempts[1].soleResponderConfirmed == false || attempts[1].soleResponderConfirmed == nil)
        XCTAssertFalse(store.exitRetryAvailable)
        XCTAssertFalse(store.isSubmittingExit)
    }

    func testBackendSoleResponder409ReopensThreeConfirmationsWithoutAutomaticRetry() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let eventID = "event-appstore-exit-race"
        let assignment = Assignment(
            id: "assignment-appstore-exit-race",
            eventId: eventID,
            role: .goToPatient,
            status: .assigned,
            revision: 1,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: assignment,
            coordination: responderCoordination(2),
            canPublishEventPosition: false
        )
        let api = FakeEmergencyAPIClient(events: [event])
        await api.rejectNextExitAsSoleResponder()
        let stream = FakeEventStream()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            now: now,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil { store.canExitCurrentEvent && store.assignment == assignment }

        store.requestExitCurrentEvent()
        let ordinaryPrompt = try XCTUnwrap(store.exitConfirmationPrompt)
        XCTAssertFalse(ordinaryPrompt.requiresSoleResponderConfirmation)
        for _ in 0..<3 {
            let step = try XCTUnwrap(store.exitConfirmationPrompt)
            store.confirmExitCurrentEvent(prompt: step)
        }
        try await waitUntil {
            store.exitConfirmationPrompt?.requiresSoleResponderConfirmation == true
                && store.exitConfirmationPrompt?.confirmationIndex == 1
        }
        let firstAttemptCount = await api.exitAttemptRecords().count
        XCTAssertEqual(firstAttemptCount, 1)
        XCTAssertFalse(store.isSubmittingExit)
        XCTAssertFalse(store.exitRetryAvailable)
        XCTAssertEqual(store.assignment, assignment)

        let forcedFirst = try XCTUnwrap(store.exitConfirmationPrompt)
        store.confirmExitCurrentEvent(prompt: forcedFirst)
        try await waitUntil { store.exitConfirmationPrompt?.confirmationIndex == 2 }
        let secondAttemptCount = await api.exitAttemptRecords().count
        XCTAssertEqual(secondAttemptCount, 1)
        let forcedSecond = try XCTUnwrap(store.exitConfirmationPrompt)
        store.confirmExitCurrentEvent(prompt: forcedSecond)
        try await waitUntil { store.exitConfirmationPrompt?.confirmationIndex == 3 }
        let thirdAttemptCount = await api.exitAttemptRecords().count
        XCTAssertEqual(thirdAttemptCount, 1)
        let forcedThird = try XCTUnwrap(store.exitConfirmationPrompt)
        store.confirmExitCurrentEvent(prompt: forcedThird)
        try await waitUntil { store.lastExitResult != nil && store.assignment == nil }

        let attempts = await api.exitAttemptRecords()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertNil(attempts[0].soleResponderConfirmed)
        XCTAssertTrue(attempts[1].soleResponderConfirmed == true)
    }

    func testExitACKAtWindowBoundaryRecoversAfterTemporaryQueueSaveFailure() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let eventID = "event-appstore-exit-queue-recovery"
        let assignment = Assignment(
            id: "assignment-appstore-exit-queue-recovery",
            eventId: eventID,
            role: .goToPatient,
            status: .assigned,
            revision: 1,
            route: nil,
            aedAcquiredReceipt: nil
        )
        let event = makeEvent(
            scenario: scenario,
            eventID: eventID,
            viewerRelationship: .responder,
            currentAssignment: assignment,
            coordination: responderCoordination(2),
            canPublishEventPosition: true,
            eventPositionParticipationStartedAt: now
        )
        let api = FakeEmergencyAPIClient(events: [event])
        let stream = FakeEventStream()
        let queue = MemoryEventPositionQueueStore()
        let store = makeAcceptedStore(
            scenario: scenario,
            api: api,
            locationProvider: LocationProvider(manager: nil),
            eventPositionQueueStore: queue,
            now: now,
            makeStream: { stream }
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        stream.send(.connected)
        try await waitUntil {
            store.canExitCurrentEvent
                && store.positionPublishingMode == .responderEvent(eventID: eventID)
        }
        XCTAssertTrue(store.captureEventPositionSlot(at: now))
        let namespace = "http://127.0.0.1:8787/api/v2/"
        let key = "\(namespace)|user-1|REDACTED-SUPPLEMENT-ID-93f236895c7b|R|\(eventID)"
        XCTAssertNotNil(try queue.load().openDraftsByContext[key])

        queue.setFailSave(true)
        store.requestExitCurrentEvent()
        let prompt = try XCTUnwrap(store.exitConfirmationPrompt)
        for _ in 0..<3 {
            let step = try XCTUnwrap(store.exitConfirmationPrompt)
            store.confirmExitCurrentEvent(prompt: step)
        }
        try await waitUntil { store.lastExitResult != nil && store.assignment == nil }
        XCTAssertTrue(store.lastError?.contains("安全队列") == true)
        XCTAssertNotNil(try queue.load().openDraftsByContext[key])

        queue.setFailSave(false)
        // Switching to a fresh local snapshot invokes the existing drain path;
        // it must retry the exact ACK.exitedAt boundary before dropping the
        // open draft.
        store.applyServerSnapshot([])
        // KNOWN GAP: the ACK.exitedAt window is applied to the in-memory context
        // only, so when the protected queue cannot be written the authoritative
        // end is never recorded durably.  The recovery path then windows the
        // sealed batches and the persisted open draft (see
        // EventPositionWindowReconciliationCoordinator.reconcilePersistedOpenDraft)
        // but has no end time to replay, so this assertion still fails.  Fixing it
        // needs the ACK end to be persisted independently of the reconciliation
        // result; that is not done here.
        let reconciled = await waitUntil({
            let state = try? queue.load()
            return state?.openDraftsByContext[key] == nil
                && state?.authoritativeEndedAtByContext[key] == now
        }, iterations: 300)
        if !reconciled {
            let state = try? queue.load()
            let drafts = state?.openDraftsByContext.keys.sorted().description ?? "nil"
            let ended = state?.authoritativeEndedAtByContext.description ?? "nil"
            XCTFail(
                "退出 ACK 的权威时间窗必须收束并记录持久化开放草稿："
                    + "drafts=\(drafts) ended=\(ended) retry=\(store.exitRetryAvailable) "
                    + "err=\(String(describing: store.lastError))"
            )
            return
        }
        XCTAssertFalse(store.exitRetryAvailable)
        XCTAssertFalse(store.isSubmittingExit)
    }

    func testClientRouteScheduleFollowsSceneAndAuthoritativeTaskLifecycle() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let stream = FakeEventStream()
        let eventID = "scheduled-client-routes"
        let initial = Assignment(id: "scheduled-task", eventId: eventID, role: .fetchAed,
                                 status: .assigned, revision: 1, route: nil, aedAcquiredReceipt: nil)
        let event = makeEvent(scenario: scenario, eventID: eventID, viewerRelationship: .responder,
                              currentAssignment: initial, coordination: responderCoordination(2))
        await api.setEvents([event])
        let store = makeAcceptedStore(scenario: scenario, api: api,
                                      clientRouteCalculator: ClientRouteTestCalculator(calculate: { _ in
            XCTFail("A missing route context must never invoke MapKit")
            return []
        }), makeStream: { stream })
        defer { store.disconnect() }
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        try await waitUntil { store.assignment?.id == initial.id }
        XCTAssertFalse(store.isClientRouteRefreshScheduled)

        store.setSceneActive(true)
        XCTAssertTrue(store.isClientRouteRefreshScheduled, "A restored REST session must not wait for Socket readiness")
        // Repeated snapshots/scene notifications retain the same business timer.
        store.applyServerSnapshot([event])
        store.setSceneActive(true)
        XCTAssertTrue(store.isClientRouteRefreshScheduled)
        XCTAssertEqual(store.assignment, initial)
        store.setSceneActive(false)
        XCTAssertFalse(store.isClientRouteRefreshScheduled)
        XCTAssertEqual(store.assignment, initial)
        store.setSceneActive(true)
        XCTAssertTrue(store.isClientRouteRefreshScheduled)

        stream.send(.disconnected("temporary socket loss"))
        XCTAssertTrue(store.isClientRouteRefreshScheduled, "Socket hints must not stop REST route refreshes")
        stream.send(.connected)
        XCTAssertTrue(store.isClientRouteRefreshScheduled)

        let acquired = Assignment(id: initial.id, eventId: eventID, role: .fetchAed,
                                  status: .aedAcquired, revision: 2, route: nil, aedAcquiredReceipt: nil)
        store.applyServerSnapshot([makeEvent(scenario: scenario, eventID: eventID,
            viewerRelationship: .responder, currentAssignment: acquired, coordination: responderCoordination(2))])
        XCTAssertFalse(store.isClientRouteRefreshScheduled)
        store.setSceneActive(false)
        store.setSceneActive(true)
        XCTAssertFalse(store.isClientRouteRefreshScheduled)
        XCTAssertEqual(store.assignment, acquired)
        store.disconnect()
        XCTAssertFalse(store.isClientRouteRefreshScheduled)
    }

    func testAcquiringAedWhileCalculatingDiscardsOldResultAndProgressMessage() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let eventID = "client-routes-acquired"
        let initial = Assignment(id: "acquired-task", eventId: eventID, role: .fetchAed,
                                 status: .enRoute, revision: 1, route: nil, aedAcquiredReceipt: nil)
        let event = makeEvent(scenario: scenario, eventID: eventID, viewerRelationship: .responder,
                              currentAssignment: initial, coordination: responderCoordination(2))
        let responder = try ResponderPosition(latitude: 22.198, longitude: 113.543, accuracyMeters: 5)
        let context = ClientAedRouteContext(calculationId: UUID().uuidString, expiresAt: now.addingTimeInterval(60),
            responder: responder, patient: try XCTUnwrap(event.patientPosition), aeds: [], eligibleCandidateCount: 0)
        await api.setEvents([event])
        await api.configureClientRoutes(context: context, confirmed: event)
        var pending: CheckedContinuation<[ClientAedRouteDistance], Error>?
        let store = makeAcceptedStore(scenario: scenario, api: api, now: now,
                                      clientRouteCalculator: ClientRouteTestCalculator(calculate: { _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        }))
        defer {
            pending?.resume(throwing: CancellationError())
            store.disconnect()
        }
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        try await waitUntil { store.assignment?.id == initial.id }
        store.refreshClientAedRoutesForCurrentEvent()
        try await waitUntil { pending != nil }
        XCTAssertNotNil(store.aedRouteCalculationMessage)

        let acquired = Assignment(id: initial.id, eventId: eventID, role: .fetchAed,
                                  status: .aedAcquired, revision: 2, route: nil, aedAcquiredReceipt: nil)
        store.applyServerSnapshot([makeEvent(scenario: scenario, eventID: eventID,
            viewerRelationship: .responder, currentAssignment: acquired, coordination: responderCoordination(2))])
        XCTAssertNil(store.aedRouteCalculationMessage)
        pending?.resume(returning: [])
        pending = nil
        for _ in 0..<20 { await Task.yield() }
        let submissions = await api.clientRouteSubmissions()
        XCTAssertTrue(submissions.isEmpty)
        XCTAssertEqual(store.assignment, acquired)
        XCTAssertNil(store.aedRouteCalculationMessage)
    }

    func testClientMapKitCalculationOnlyAppliesTheServerConfirmedAssignment() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let eventID = "client-routes-event"
        let initial = Assignment(id: "task", eventId: eventID, role: .goToPatient, status: .assigned,
                                 revision: 1, route: nil, aedAcquiredReceipt: nil)
        let original = makeEvent(scenario: scenario, eventID: eventID, viewerRelationship: .responder,
                                 currentAssignment: initial, coordination: responderCoordination(2))
        let aed = try XCTUnwrap(scenario.aeds.first)
        let responder = try ResponderPosition(latitude: 22.198, longitude: 113.543, accuracyMeters: 5)
        let patient = try XCTUnwrap(original.patientPosition)
        let context = ClientAedRouteContext(calculationId: UUID().uuidString, expiresAt: now.addingTimeInterval(60),
            responder: responder, patient: patient, aeds: [aed], eligibleCandidateCount: 1)
        let route = AedRoute(aedId: aed.id, responderPosition: responder, aedPosition: aed.aedPosition,
                             patientPosition: patient, distanceMeters: 420, distanceSource: "CLIENT_MAPKIT")
        let confirmedAssignment = Assignment(id: "task", eventId: eventID, role: .fetchAed, status: .assigned,
                                             revision: 2, route: route, aedAcquiredReceipt: nil)
        let confirmed = makeEvent(scenario: scenario, eventID: eventID, viewerRelationship: .responder,
                                  currentAssignment: confirmedAssignment, coordination: responderCoordination(2))
        await api.setEvents([original])
        await api.configureClientRoutes(context: context, confirmed: confirmed)
        let store = makeAcceptedStore(scenario: scenario, api: api, now: now, clientRouteCalculator: ClientRouteTestCalculator(calculate: { input in
            XCTAssertEqual(input.calculationId, context.calculationId)
            return [.init(aedId: aed.id, toAedMeters: 200, toPatientMeters: 220)]
        }))
        defer { store.disconnect() }
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        try await waitUntil { store.assignment?.revision == 1 }
        store.refreshClientAedRoutesForCurrentEvent()
        try await waitUntil { store.assignment?.revision == 2 }
        XCTAssertEqual(store.assignment?.route?.distanceSource, "CLIENT_MAPKIT")
        XCTAssertEqual(store.assignment?.role, .fetchAed)
        let submissions = await api.clientRouteSubmissions()
        XCTAssertEqual(submissions.count, 1)
        store.refreshClientAedRoutesForCurrentEvent()
        let retried = await api.clientRouteSubmissions()
        XCTAssertEqual(retried.count, 1, "reconciliation must not cause a route-request loop")
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () async -> Bool
    ) async throws {
        if await waitUntil(condition, iterations: 300) { return }
        XCTFail("等待异步 REST 对账超时。")
    }

    /// Same bounded wait, but reports the outcome instead of failing directly so
    /// a caller can attach its own diagnostics to the failure.
    private func waitUntil(
        _ condition: @escaping @MainActor () async -> Bool,
        iterations: Int
    ) async -> Bool {
        for _ in 0..<iterations {
            if await condition() { return true }
            try? await Task<Never, Never>.sleep(for: .milliseconds(10))
        }
        return false
    }

    private func makeEvent(
        scenario: DemoScenario,
        eventID: String? = nil,
        viewerRelationship: ViewerRelationship,
        currentAssignment: Assignment? = nil,
        coordination: CoordinationSummary? = nil,
        canPublishEventPosition: Bool? = nil,
        state: EventState? = nil,
        eventPositionParticipationStartedAt: Date? = nil,
        eventPositionParticipationEndedAt: Date? = nil,
        statusConfirmation: StatusConfirmation? = nil,
        createdAt: Date? = nil,
        pendingResponseRequest: ResponseRequest? = nil
    ) -> EmergencyEvent {
        let base = DemoScenarioEngine().makePatientEvent(
            scenario: scenario,
            viewerRelationship: viewerRelationship
        )
        return EmergencyEvent(
            id: eventID ?? base.id,
            state: state ?? base.state,
            recruitmentState: base.recruitmentState,
            canPublishEventPosition: canPublishEventPosition ?? base.canPublishEventPosition,
            triggerSource: base.triggerSource,
            fallDetectedAt: base.fallDetectedAt,
            fallResolution: base.fallResolution,
            callFirstObservedAt: base.callFirstObservedAt,
            patientPosition: base.patientPosition,
            patientLocationCard: base.patientLocationCard,
            viewerRelationship: viewerRelationship,
            coordination: coordination ?? base.coordination,
            createdAt: createdAt ?? base.createdAt,
            resolvedAt: base.resolvedAt,
            eventPositionParticipationStartedAt: eventPositionParticipationStartedAt,
            eventPositionParticipationEndedAt: eventPositionParticipationEndedAt,
            pendingResponseRequest: pendingResponseRequest,
            statusConfirmation: statusConfirmation,
            currentAssignment: currentAssignment
        )
    }

    private func responderCoordination(_ acceptedResponderCount: Int) -> CoordinationSummary {
        CoordinationSummary(
            revision: 1,
            nearbyCandidateCount: 0,
            pendingOfferCount: 0,
            acceptedResponderCount: acceptedResponderCount,
            goToPatientCount: acceptedResponderCount,
            fetchAedCount: 0,
            enRouteCount: 0,
            arrivedAtAedCount: 0,
            arrivedAtPatientCount: 0,
            aedAcquiredCount: 0,
            completedAssignmentCount: 0
        )
    }

    private func makeResponseDecisionStore(
        scenario: DemoScenario,
        api: FakeEmergencyAPIClient,
        clock: ResponseDecisionTestClock? = nil,
        stream: FakeEventStream = FakeEventStream()
    ) async throws -> (AppStore, ResponseRequest) {
        let request = DemoScenarioEngine().makeResponseRequest(
            scenario: scenario,
            messageID: "message-decision",
            deliveryID: "delivery-decision",
            occurredAt: clock?.date ?? Date(timeIntervalSince1970: 1_788_000_100)
        )
        await api.setEvents([makeEvent(
            scenario: scenario, viewerRelationship: .neutral,
            pendingResponseRequest: request
        )])
        let receipts = MemoryDeliveryReceiptQueueStore()
        let store = makeAcceptedStore(
            scenario: scenario, api: api, deliveryReceiptQueueStore: receipts,
            clock: clock,
            makeStream: { stream }
        )
        XCTAssertFalse(store.isAwaitingResponseViewReceipt)
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        try await waitUntil { store.responseRequest?.messageId == request.messageId }
        XCTAssertTrue(store.isAwaitingResponseViewReceipt)
        store.markResponseRequestViewed()
        XCTAssertTrue(store.isAwaitingResponseViewReceipt)
        try await waitUntil {
            store.deliveryStatus == .viewed && (try? receipts.load().isEmpty) == true
        }
        XCTAssertFalse(store.isAwaitingResponseViewReceipt)
        return (store, request)
    }

    private func makeAcceptedStore(
        scenario: DemoScenario,
        api: FakeEmergencyAPIClient = FakeEmergencyAPIClient(),
        locationProvider: LocationProvider = LocationProvider(manager: nil),
        allowsLiveNetworking: Bool = true,
        companionConnectivity: FakeCompanionConnectivityActivator = FakeCompanionConnectivityActivator(),
        notificationPermissions: FakeNotificationPermissions = FakeNotificationPermissions(granted: true),
        authSessionStore: TestAuthSessionStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession),
        eventPositionQueueStore: EventPositionQueuePersisting = MemoryEventPositionQueueStore(),
        deliveryReceiptQueueStore: DeliveryReceiptQueuePersisting = MemoryDeliveryReceiptQueueStore(),
        now: Date = Date(timeIntervalSince1970: 1_788_000_100),
        automaticallyConnectOnReady: Bool = false,
        clientRouteCalculator: ClientRouteTestCalculator? = nil,
        clock: ResponseDecisionTestClock? = nil,
        makeStream: @escaping () -> FakeEventStream = { FakeEventStream() }
    ) -> AppStore {
        return makeStore(
            scenario: scenario,
            api: api,
            locationProvider: locationProvider,
            agreementStore: FakeAgreementStore(
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
            ),
            notificationPermissions: notificationPermissions,
            allowsLiveNetworking: allowsLiveNetworking,
            companionConnectivity: companionConnectivity,
            authSessionStore: authSessionStore,
            eventPositionQueueStore: eventPositionQueueStore,
            deliveryReceiptQueueStore: deliveryReceiptQueueStore,
            now: now,
            automaticallyConnectOnReady: automaticallyConnectOnReady,
            clientRouteCalculator: clientRouteCalculator,
            clock: clock,
            makeStream: makeStream
        )
    }

    /// G02 — the three agreement states a real user can be in, and what the account
    /// controls do in each.
    ///
    /// The requirement is that a user who has NOT agreed, has agreed PARTIALLY, or
    /// holds a STALE version must still be able to manage the account they already
    /// created — log out, and close it — and that a server refusal is reported
    /// instead of being swallowed.  These are the states an audit found reachable
    /// only through a screen that offered "go to iOS Settings" and nothing else.
    func testPartialAgreementKeepsAccountControlsReachableAndBusinessClosed() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        // Two of the four agreements: signed in, identified, but not permitted to
        // participate in business.
        let partial = FakeAgreementStore(state: AgreementState(
            patientAcceptedAt: now,
            responderAcceptedAt: now,
            privacyPolicyAcceptedAt: nil,
            sensitivePersonalInformationAcceptedAt: nil,
            patientAcceptedVersion: "2.0",
            responderAcceptedVersion: "2.0",
            privacyPolicyAcceptedVersion: nil,
            sensitivePersonalInformationAcceptedVersion: nil
        ))
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let store = makeStore(
            scenario: scenario, api: api, agreementStore: partial,
            authSessionStore: authStore, now: now
        )
        // No `connect`: the business gate refuses a partially agreed account, which
        // is exactly the point — the account exists and its controls must still work.
        XCTAssertTrue(store.isAuthenticated, "a partially agreed account is still signed in")
        XCTAssertFalse(store.isBusinessAccessReady,
                       "business must stay closed until every agreement is current")
        XCTAssertFalse(store.isOnboardingComplete)

        // Logging out works from here, and it takes the pending permissions with it.
        await store.logout()
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(authStore.load(), "退出登录必须清除本机凭据")
        XCTAssertFalse(store.isBusinessAccessReady)
    }

    func testAStaleAgreementVersionIsTreatedAsIncompleteRatherThanAccepted() async throws {
        let scenario = try loadScenario()
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        // Every agreement accepted, but at an older version than the app now ships.
        let stale = FakeAgreementStore(state: AgreementState(
            patientAcceptedAt: now, responderAcceptedAt: now,
            privacyPolicyAcceptedAt: now, sensitivePersonalInformationAcceptedAt: now,
            patientAcceptedVersion: "1.0", responderAcceptedVersion: "1.0",
            privacyPolicyAcceptedVersion: "1.0", sensitivePersonalInformationAcceptedVersion: "1.0"
        ))
        let store = makeStore(scenario: scenario, agreementStore: stale, now: now)
        XCTAssertFalse(store.isOnboardingComplete,
                       "旧版本的同意不能算作已同意当前正文")
        XCTAssertFalse(store.isBusinessAccessReady)
        XCTAssertTrue(store.isAuthenticated,
                      "但账号仍然存在，用户必须还能退出登录与注销")
    }

    func testARefusedAccountClosureIsReportedAndKeepsTheSessionForRetry() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let store = makeAcceptedStore(scenario: scenario, api: api, authSessionStore: authStore)
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        // The server refuses with a conflict: something changed underneath the user.
        await api.failAccountDeletion(with: APIClientError.rejected(ProblemDetails(
            type: "about:blank", title: "Conflict", status: 409,
            detail: "服务器拒绝了本次注销"
        )))
        store.deleteAccount()
        try await waitUntil { store.lastError != nil && !store.isDeletingAccount }
        XCTAssertTrue(store.lastError?.contains("账号注销失败") == true)
        XCTAssertTrue(store.isAuthenticated, "被拒绝的注销必须保持登录，允许用户处理后重试")
        XCTAssertNotNil(authStore.load(), "被拒绝的注销不得清除本机凭据")
        // A successful retry then closes it, which is the point of keeping the session.
        await api.allowAccountDeletion()
        store.deleteAccount()
        try await waitUntil { !store.isDeletingAccount && !store.isAuthenticated }
        XCTAssertNil(authStore.load())
        XCTAssertTrue(store.lastError?.contains("已注销") == true)
    }

    /// 通过用户发现患者 —— the additional trigger, from the app's side.
    ///
    /// It must use the server's case (the returned event), never a locally invented
    /// one, and it must refuse to report without a usable position: a case with no
    /// location would recruit responders to nowhere.
    func testReportingAFoundPatientUsesTheReturnedCaseAndTheCurrentPosition() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        // A provider with a fixed coordinate, so the report has a position to send.
        let locationProvider = LocationProvider(manager: nil)
        XCTAssertTrue(locationProvider.applyTestCoordinate(
            DeviceCoordinate(
                latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12,
                observedAt: Date(timeIntervalSince1970: 1_788_000_100)
            ),
            now: Date(timeIntervalSince1970: 1_788_000_100)
        ))
        let store = makeStore(
            scenario: scenario, api: api, locationProvider: locationProvider,
            agreementStore: FakeAgreementStore(state: AgreementState(
                patientAcceptedAt: Date(timeIntervalSince1970: 1_788_000_100),
                responderAcceptedAt: Date(timeIntervalSince1970: 1_788_000_100),
                privacyPolicyAcceptedAt: Date(timeIntervalSince1970: 1_788_000_100),
                sensitivePersonalInformationAcceptedAt: Date(timeIntervalSince1970: 1_788_000_100),
                patientAcceptedVersion: "2.0", responderAcceptedVersion: "2.0",
                privacyPolicyAcceptedVersion: "2.0",
                sensitivePersonalInformationAcceptedVersion: "2.0"
            )),
            authSessionStore: authStore
        )
        let connected = await store.connect(baseURL: "http://127.0.0.1:8787")
        XCTAssertTrue(connected)
        XCTAssertTrue(store.canReportFoundPatient, "有权限且已定位时才允许上报")

        // The server owns the case: the app adopts the event it returns.
        let returned = DemoScenarioEngine().makePatientEvent(
            scenario: scenario, eventID: "REDACTED-SUPPLEMENT-ID-ceda2d1223b2"
        )
        await api.succeedFoundPatient(with: returned)
        let reported = await store.reportFoundPatient(
            eventID: "REDACTED-SUPPLEMENT-ID-ceda2d1223b2"
        )
        XCTAssertEqual(reported?.id, returned.id)
        let attempts = await api.recordedFoundPatientAttempts()
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(attempts[0].eventID, returned.id)
        XCTAssertEqual(attempts[0].position.latitude, 22.1987)
        XCTAssertEqual(attempts[0].position.kind, .patient)
        XCTAssertTrue(store.visibleEvents.contains { $0.id == returned.id },
                      "服务器返回的事件必须进入应用状态，而不是本地伪造一个")
    }

    func testReportingAFoundPatientWithoutAPositionIsRefusedLocallyAndNeverSent() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let store = makeAcceptedStore(scenario: scenario, api: api, authSessionStore: authStore)
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        // The injected provider has no fix: nothing may be sent.
        XCTAssertFalse(store.canReportFoundPatient)
        let reported = await store.reportFoundPatient(
            eventID: "REDACTED-SUPPLEMENT-ID-9a7d8aa2b234"
        )
        XCTAssertNil(reported)
        XCTAssertEqual(store.lastError?.contains("定位"), true)
        let attempts = await api.recordedFoundPatientAttempts()
        XCTAssertEqual(attempts.count, 0, "没有位置就不允许上报")
    }

    func testAFailedReportIsReportedAndDoesNotCreateALocalCase() async throws {
        let scenario = try loadScenario()
        let api = FakeEmergencyAPIClient()
        let authStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession)
        let locationProvider = LocationProvider(manager: nil)
        XCTAssertTrue(locationProvider.applyTestCoordinate(
            DeviceCoordinate(
                latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12,
                observedAt: Date(timeIntervalSince1970: 1_788_000_100)
            ),
            now: Date(timeIntervalSince1970: 1_788_000_100)
        ))
        let store = makeAcceptedStore(
            scenario: scenario, api: api, locationProvider: locationProvider,
            authSessionStore: authStore
        )
        _ = await store.connect(baseURL: "http://127.0.0.1:8787")
        await api.failFoundPatient(with: APIClientError.rejected(ProblemDetails(
            type: "about:blank", title: "Forbidden", status: 403, detail: "协议已过期"
        )))
        let before = store.visibleEvents.count
        let reported = await store.reportFoundPatient(
            eventID: "REDACTED-SUPPLEMENT-ID-b51ff8f80b25"
        )
        XCTAssertNil(reported)
        XCTAssertEqual(store.lastError?.contains("上报失败"), true)
        XCTAssertEqual(store.visibleEvents.count, before, "失败不得凭空产生一个事件")
    }

    /// A person-reported case is not a fall, so the trigger must say so.
    func testAReportedPatientTriggerIsNotPresentedAsFallDetection() throws {
        XCTAssertEqual(TriggerSource.userReportedPatient.rawValue, "USER_REPORTED_PATIENT")
        XCTAssertFalse(TriggerSource.userReportedPatient.isWatchFallDetection)
        XCTAssertTrue(TriggerSource.watchFallHelpConfirmed.isWatchFallDetection)
        XCTAssertFalse(TriggerSource.simulatedTest.isWatchFallDetection)
        // It must decode from the server, because the patient projection carries it.
        let decoded = try JSONDecoder.contractDecoder().decode(
            TriggerSource.self,
            from: Data(#""USER_REPORTED_PATIENT""#.utf8)
        )
        XCTAssertEqual(decoded, .userReportedPatient)
    }

    private func makeStore(
        scenario: DemoScenario,
        api: FakeEmergencyAPIClient = FakeEmergencyAPIClient(),
        locationProvider: LocationProvider = LocationProvider(manager: nil),
        agreementStore: FakeAgreementStore = FakeAgreementStore(state: AgreementState()),
        agreementDocuments: AgreementDocuments? = nil,
        notificationPermissions: FakeNotificationPermissions = FakeNotificationPermissions(granted: true),
        requestLocation: @escaping () -> Void = {},
        allowsLiveNetworking: Bool = true,
        companionConnectivity: FakeCompanionConnectivityActivator = FakeCompanionConnectivityActivator(),
        authSessionStore: TestAuthSessionStore = TestAuthSessionStore(session: TestAuthSessionStore.fixtureSession),
        authClient: TestAuthClient = TestAuthClient(),
        eventPositionQueueStore: EventPositionQueuePersisting = MemoryEventPositionQueueStore(),
        deliveryReceiptQueueStore: DeliveryReceiptQueuePersisting = MemoryDeliveryReceiptQueueStore(),
        now: Date = Date(timeIntervalSince1970: 1_788_000_100),
        automaticallyConnectOnReady: Bool = false,
        clientRouteCalculator: ClientRouteTestCalculator? = nil,
        clock: ResponseDecisionTestClock? = nil,
        makeStream: @escaping () -> FakeEventStream = { FakeEventStream() }
    ) -> AppStore {
        AppStore(
            environment: AppEnvironment(
                locationProvider: locationProvider,
                requestInitialLocationAccess: requestLocation,
                notificationPermissions: notificationPermissions,
                companionConnectivity: companionConnectivity,
                authSessionStore: authSessionStore,
                agreementStore: agreementStore,
                eventPositionQueueStore: eventPositionQueueStore,
                deliveryReceiptQueueStore: deliveryReceiptQueueStore,
                locationSpeaker: FakeLocationSpeaker(),
                safeDialer: FakeSafeDialer(),
                demoScenarioEngine: DemoScenarioEngine(),
                demoAssignmentFactory: DemoAssignmentFactory(),
                safetyPolicy: .fallback,
                demoScenario: scenario,
                agreementVersions: scenario.agreementVersions,
                agreementDocuments: agreementDocuments,
                deviceInstanceID: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
                companionPairID: "REDACTED-SUPPLEMENT-ID-c491e0abab48",
                configuredServiceBaseURL: "http://127.0.0.1:8787",
                allowsLiveNetworking: allowsLiveNetworking,
                makeAuthClient: { _, _ in authClient },
                makeAPIClient: { _, _, _ in api },
                makeEventStream: { _, _ in makeStream() },
                makeID: { UUID().uuidString },
                now: { clock?.date ?? now },
                automaticallyConnectOnReady: automaticallyConnectOnReady,
                clientRouteCalculator: clientRouteCalculator?.calculate
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
                Bundle.main.url(forResource: "demo-scenario", withExtension: "json")
            )
        return try JSONDecoder.contractDecoder().decode(
            DemoScenario.self,
            from: Data(contentsOf: url)
        )
    }

    private func publishLocation(
        latitude: Double,
        longitude: Double,
        accuracyMeters: Double,
        observedAt: Date,
        to provider: LocationProvider
    ) {
        let location = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            altitude: 0,
            horizontalAccuracy: accuracyMeters,
            verticalAccuracy: 10,
            timestamp: observedAt
        )
        provider.locationManager(CLLocationManager(), didUpdateLocations: [location])
    }

    private func publishLocations(
        _ values: [(latitude: Double, longitude: Double, accuracyMeters: Double, observedAt: Date)],
        to provider: LocationProvider
    ) {
        let locations = values.map { value in
            CLLocation(
                coordinate: CLLocationCoordinate2D(
                    latitude: value.latitude,
                    longitude: value.longitude
                ),
                altitude: 0,
                horizontalAccuracy: value.accuracyMeters,
                verticalAccuracy: 10,
                timestamp: value.observedAt
            )
        }
        provider.locationManager(CLLocationManager(), didUpdateLocations: locations)
    }
}

private func patientActivatedPayload(messageID: String) -> [String: Any] {
    [
        "schemaVersion": "2.0",
        "messageId": messageID,
        "eventId": "event-socket-1",
        "occurredAt": "2026-08-31T01:02:04Z",
        "state": "ACTIVE",
        "recruitmentState": "RECRUITING"
    ]
}

private func validFetchAedAssignmentPayload() -> [String: Any] {
    [
        "id": "assignment-socket-1",
        "eventId": "event-socket-1",
        "role": "FETCH_AED",
        "status": "ASSIGNED",
        "revision": 1,
        "route": [
            "aedId": "aed-socket-1",
            "path": [
                [
                    "kind": "R",
                    "latitude": 22.1980,
                    "longitude": 113.5430,
                    "accuracyMeters": 10
                ],
                [
                    "kind": "A",
                    "latitude": 22.1983,
                    "longitude": 113.5434,
                    "accuracyMeters": 5
                ],
                [
                    "kind": "P",
                    "latitude": 22.1987,
                    "longitude": 113.5439,
                    "accuracyMeters": 12
                ]
            ],
            "distanceMeters": 180,
            "distanceSource": "AMAP_WALKING"
        ]
    ]
}

private final class FakeAgreementStore: @unchecked Sendable, AgreementPersisting {
    private var state: AgreementState

    init(state: AgreementState) {
        self.state = state
    }

    func load() -> AgreementState { state }
    func save(_ state: AgreementState) { self.state = state }
}

@MainActor
private final class FakeNotificationPermissions: NotificationPermissionRequesting {
    var granted: Bool
    private(set) var requestCount = 0

    init(granted: Bool) {
        self.granted = granted
    }

    var cachedAuthorizationGranted: Bool { granted }

    func requestAuthorization() async throws -> Bool {
        requestCount += 1
        return granted
    }

    func currentAuthorizationGranted() async -> Bool { granted }
}

@MainActor
private final class FakeCompanionConnectivityActivator: CompanionConnectivityActivating,
    CompanionLinkTransferring {
    private(set) var activationCount = 0
    private(set) var deactivationCount = 0
    private(set) var state = CompanionConnectivityState(
        activationState: .notActivated,
        watchReachable: false
    )
    private(set) var sentEnvelopes: [CompanionLinkEnvelope] = []
    var onStateChange: ((CompanionConnectivityState) -> Void)?
    var onSendFailure: (() -> Void)?

    func activate() {
        activationCount += 1
    }

    func deactivate() {
        deactivationCount += 1
    }

    @discardableResult
    func sendCompanionLink(_ envelope: CompanionLinkEnvelope) -> Bool {
        guard state.activationState == .activated, state.watchReachable else { return false }
        sentEnvelopes.append(envelope)
        return true
    }

    func setState(_ state: CompanionConnectivityState) {
        self.state = state
        onStateChange?(state)
    }
}

private actor FakeEmergencyAPIClient: EmergencyAPIClient, PushAPIClient,
    CompanionLinkTicketRequesting,
    SessionLogoutClient {
    private var pushTokens: [PushTokenRequest] = []
    private var pushRoutes: [String] = []
    func registerPushToken(_ registration: PushTokenRequest) async throws -> PushRegistrationStatus {
        pushTokens.append(registration)
        return PushRegistrationStatus(providerConfigured: true)
    }
    func notificationRoute(messageID: String) async throws -> PushNotificationRoute {
        pushRoutes.append(messageID)
        return PushNotificationRoute(messageId: messageID, eventId: nil, actionable: false)
    }
    func recordedPushTokens() -> [PushTokenRequest] { pushTokens }
    func recordedPushRoutes() -> [String] { pushRoutes }
    struct PositionUpdate: Sendable {
        let id: String
        let position: ResponderPosition
        let observedAt: Date
    }

    struct PatientPositionRecord: Sendable {
        let eventID: String
        let update: PatientPositionUpdate
    }

    struct EventPositionBatchRecord: Sendable {
        let eventID: String
        let batchID: String
        let batch: EventPositionBatch
    }

    struct ReceiptAttempt: Sendable {
        let eventID: String
        let deliveryID: String
        let status: DeliveryStatus
    }

    struct ResponseDecisionAttempt: Sendable {
        let eventID: String
        let deliveryID: String
        let accept: Bool
    }

    struct StatusConfirmationAttempt: Sendable {
        let eventID: String
        let confirmationID: String
        let respondedAt: Date
    }

    struct AedUnavailableAttempt: Sendable {
        let eventID: String
        let assignmentID: String
        let aedID: String
    }

    struct FoundPatientAttempt: Sendable {
        let eventID: String
        let observedAt: Date
        let position: PatientPosition
    }

    struct ExitAttempt: Equatable, Sendable {
        let eventID: String
        let exitID: String
        let exitedAt: Date
        let reason: String?
        let soleResponderConfirmed: Bool?
    }

    private(set) var bootstrapRequests: [DeviceSessionBootstrapRequest] = []
    private var remainingBootstrapFailures = 0
    struct ResolutionAttempt: Equatable, Sendable {
        let eventID: String
        let resolutionID: String
        let actor: ResolutionActor
        let resolvedAt: Date
    }
    private var resolutionAttempts: [ResolutionAttempt] = []
    private var failResolution = false
    private var suspendResolution = false
    private var resolutionContinuation: CheckedContinuation<Void, Never>?
    func failNextResolution() { failResolution = true }
    func suspendNextResolution() { suspendResolution = true }
    func isResolutionSuspended() -> Bool { resolutionContinuation != nil }
    func releaseResolution() { resolutionContinuation?.resume(); resolutionContinuation = nil }
    func resolutionAttemptRecords() -> [ResolutionAttempt] { resolutionAttempts }
    private var suspendBootstrap = false
    private var bootstrapContinuation: CheckedContinuation<Void, Never>?
    private var eventRequests: [String] = []
    private var listRequests = 0
    private var positionUpdates: [PositionUpdate] = []
    private var positionAttempts: [PositionUpdate] = []
    private var patientPositionUpdates: [PatientPositionRecord] = []
    private var patientPositionAttempts: [PatientPositionRecord] = []
    private var eventPositionBatches: [EventPositionBatchRecord] = []
    private var eventPositionAttempts: [EventPositionBatchRecord] = []
    private var presenceUpdates: [DevicePresenceUpdate] = []
    private var operations: [String] = []
    private var timelineUnavailable = false

    func setTimelineUnavailable(_ value: Bool) { timelineUnavailable = value }
    private var remainingPositionFailures = 0
    private var remainingEventPositionFailures = 0
    private var queuedEventPositionRejections: [Int] = []
    private var eventPositionFailureStatuses: [Int] = []
    private var remainingReceiptFailures = 0
    private var permanentlyRejectedReceipts: [String: Int] = [:]
    private var deletedAccounts: [String] = []
    private var deleteAttempts = 0
    private var accountDeletionFailure: Error?
    private var receiptAttempts: [ReceiptAttempt] = []
    private var responseDecisionAttempts: [ResponseDecisionAttempt] = []
    private var remainingResponseDecisionFailures = 0
    private var shouldSuspendNextResponseDecision = false
    private var responseDecisionContinuations: [Int: CheckedContinuation<Void, Never>] = [:]
    private var statusConfirmationAttempts: [StatusConfirmationAttempt] = []
    private var suspendNextStatusConfirmation = false
    private var statusConfirmationContinuation: CheckedContinuation<StatusConfirmationResult, Never>?
    private var aedUnavailableAttempts: [AedUnavailableAttempt] = []
    private var exitAttempts: [ExitAttempt] = []
    private var remainingExitFailures = 0
    private var remainingSoleResponderRejections = 0
    private var suspendNextAedUnavailableReport = false
    private var suspendedAedUnavailableContinuation: CheckedContinuation<Void, Never>?
    private var completedAedUnavailableReports = 0
    private var companionLinkTicketCount = 0
    private var logoutOperations: [String] = []
    private var events: [EmergencyEvent]
    private var routeContext: ClientAedRouteContext?
    private var confirmedRouteEvent: EmergencyEvent?
    private var submittedClientRoutes: [[ClientAedRouteDistance]] = []
    func configureClientRoutes(context: ClientAedRouteContext, confirmed: EmergencyEvent) {
        routeContext = context
        confirmedRouteEvent = confirmed
    }
    func clientAedRouteContext(eventID: String) async throws -> ClientAedRouteContext? { routeContext }
    func submitClientAedRoutes(eventID: String, calculationID: String,
                              routes: [ClientAedRouteDistance]) async throws -> EmergencyEvent {
        guard calculationID == routeContext?.calculationId, let confirmed = confirmedRouteEvent else {
            throw APIClientError.invalidResponse
        }
        submittedClientRoutes.append(routes)
        events = [confirmed]
        return confirmed
    }
    func clientRouteSubmissions() -> [[ClientAedRouteDistance]] { submittedClientRoutes }

    private var suspendNextListEvents = false
    private var suspendedListEventsSnapshot: [EmergencyEvent]?
    private var suspendedListEventsContinuation: CheckedContinuation<[EmergencyEvent], Never>?
    let timelines: [String: [TimelineEntry]]

    init(events: [EmergencyEvent] = [], timelines: [String: [TimelineEntry]] = [:]) {
        self.events = events
        self.timelines = timelines
    }

    func bootstrapSession(request: DeviceSessionBootstrapRequest) async throws -> SessionBootstrapResponse {
        bootstrapRequests.append(request)
        if remainingBootstrapFailures > 0 {
            remainingBootstrapFailures -= 1
            throw URLError(.notConnectedToInternet)
        }
        if suspendBootstrap {
            suspendBootstrap = false
            await withCheckedContinuation { bootstrapContinuation = $0 }
        }
        return try JSONDecoder.contractDecoder().decode(
            SessionBootstrapResponse.self,
            from: Data(
                #"{"sessionId":"REDACTED-SUPPLEMENT-ID-81ecc6937557","sessionToken":"test-token","expiresAt":"2026-09-01T00:00:00Z","scopes":["events:read"]}"#.utf8
            )
        )
    }

    func firstBootstrapRequest() -> DeviceSessionBootstrapRequest? {
        bootstrapRequests.first
    }

    func bootstrapRequestCount() -> Int {
        bootstrapRequests.count
    }

    func failNextBootstrapRequests(_ count: Int) { remainingBootstrapFailures = count }
    func suspendNextBootstrapRequest() { suspendBootstrap = true }
    func isBootstrapSuspended() -> Bool { bootstrapContinuation != nil }
    func releaseBootstrapRequest() {
        bootstrapContinuation?.resume()
        bootstrapContinuation = nil
    }

    func listEvents() async throws -> [EmergencyEvent] {
        listRequests += 1
        operations.append("events")
        let snapshot = events
        guard suspendNextListEvents else { return snapshot }
        suspendNextListEvents = false
        suspendedListEventsSnapshot = snapshot
        return await withCheckedContinuation { continuation in
            suspendedListEventsContinuation = continuation
        }
    }
    func event(id: String) async throws -> EmergencyEvent {
        eventRequests.append(id)
        guard let event = events.first(where: { $0.id == id }) else {
            throw APIClientError.invalidResponse
        }
        return event
    }
    func requestedEventIDs() -> [String] { eventRequests }
    func listEventsRequestCount() -> Int { listRequests }
    func setEvents(_ events: [EmergencyEvent]) { self.events = events }
    func exitEvent(
        eventID: String,
        exitID: String,
        exitedAt: Date,
        reason: String?,
        soleResponderConfirmed: Bool?
    ) async throws -> ParticipantExitResult {
        exitAttempts.append(ExitAttempt(
            eventID: eventID,
            exitID: exitID,
            exitedAt: exitedAt,
            reason: reason,
            soleResponderConfirmed: soleResponderConfirmed
        ))
        if remainingSoleResponderRejections > 0 {
            remainingSoleResponderRejections -= 1
            throw APIClientError.rejected(ProblemDetails(
                type: ProblemDetails.soleResponderConfirmationRequiredType,
                title: "Sole responder confirmation required",
                status: 409,
                detail: "你是当前任务唯一一名响应者，确定要退出吗。"
            ))
        }
        if remainingExitFailures > 0 {
            remainingExitFailures -= 1
            throw APIClientError.unexpectedStatus(503)
        }
        return ParticipantExitResult(
            exitId: exitID,
            eventId: eventID,
            exitedAt: exitedAt,
            idempotent: false
        )
    }
    func exitAttemptRecords() -> [ExitAttempt] { exitAttempts }
    func failNextExitRequest() { remainingExitFailures += 1 }
    func rejectNextExitAsSoleResponder() { remainingSoleResponderRejections += 1 }
    func suspendNextListEventsResponse() {
        suspendNextListEvents = true
    }
    func hasSuspendedListEventsResponse() -> Bool {
        suspendedListEventsContinuation != nil
    }
    func resumeSuspendedListEventsResponse() {
        guard let continuation = suspendedListEventsContinuation else { return }
        let snapshot = suspendedListEventsSnapshot ?? []
        suspendedListEventsContinuation = nil
        suspendedListEventsSnapshot = nil
        continuation.resume(returning: snapshot)
    }
    func failNextReceipt() {
        remainingReceiptFailures += 1
    }
    /// Makes one delivery's receipt a server-permanent rejection, as an exited
    /// responder's replayed receipt would be.
    func rejectReceiptPermanently(deliveryID: String, status: Int = 403) {
        permanentlyRejectedReceipts[deliveryID] = status
    }
    func receiptAttemptRecords() -> [ReceiptAttempt] { receiptAttempts }
    func submitEnd(eventID: String, request: EventEndRequest) async throws -> EmergencyEvent {
        var event = try await resolveEvent(eventID: eventID, resolutionID: request.resolutionId,
            actor: request.actor, resolvedAt: request.endedAt)
        if request.reason == .falseAlarm {
            event.state = .cancelledConfirmedFalseAlarm
            event.recruitmentState = .stopped
            if let index = events.firstIndex(where: { $0.id == eventID }) { events[index] = event }
        }
        return event
    }
    func confirmFalseAlarm(eventID: String) async throws -> EmergencyEvent {
        try await event(id: eventID)
    }
    func resolveEvent(
        eventID: String,
        resolutionID: String,
        actor: ResolutionActor,
        resolvedAt: Date
    ) async throws -> EmergencyEvent {
        resolutionAttempts.append(ResolutionAttempt(eventID: eventID, resolutionID: resolutionID, actor: actor, resolvedAt: resolvedAt))
        if failResolution {
            failResolution = false
            throw URLError(.notConnectedToInternet)
        }
        var terminal = try await event(id: eventID)
        terminal.state = .resolved
        terminal.recruitmentState = .completed
        terminal.resolvedAt = resolvedAt
        if suspendResolution {
            suspendResolution = false
            await withCheckedContinuation { resolutionContinuation = $0 }
        }
        if let index = events.firstIndex(where: { $0.id == eventID }) { events[index] = terminal }
        return terminal
    }
    func continueStatusConfirmation(
        eventID: String,
        confirmationID: String,
        respondedAt: Date
    ) async throws -> StatusConfirmationResult {
        statusConfirmationAttempts.append(StatusConfirmationAttempt(
            eventID: eventID,
            confirmationID: confirmationID,
            respondedAt: respondedAt
        ))
        let result = StatusConfirmationResult(
            confirmationId: confirmationID,
            response: .continueRescue,
            respondedAt: respondedAt,
            nextCheckAt: respondedAt.addingTimeInterval(30 * 60),
            idempotent: false
        )
        if suspendNextStatusConfirmation {
            suspendNextStatusConfirmation = false
            return await withCheckedContinuation { continuation in
                statusConfirmationContinuation = continuation
            }
        }
        return result
    }
    func recordedStatusConfirmationAttempts() -> [StatusConfirmationAttempt] {
        statusConfirmationAttempts
    }
    func suspendNextStatusConfirmationResponse() {
        suspendNextStatusConfirmation = true
    }
    func isStatusConfirmationSuspended() -> Bool {
        statusConfirmationContinuation != nil
    }
    func resumeStatusConfirmationResponse() {
        statusConfirmationContinuation?.resume(returning: StatusConfirmationResult(
            confirmationId: "confirmation-status-stale",
            response: .continueRescue,
            respondedAt: Date(timeIntervalSince1970: 1_788_000_100),
            nextCheckAt: Date(timeIntervalSince1970: 1_788_000_100 + 30 * 60),
            idempotent: false
        ))
        statusConfirmationContinuation = nil
    }
    func sendReceipt(
        eventID: String,
        deliveryID: String,
        status: DeliveryStatus,
        occurredAt: Date
    ) async throws {
        _ = occurredAt
        receiptAttempts.append(
            ReceiptAttempt(eventID: eventID, deliveryID: deliveryID, status: status)
        )
        if let rejectionStatus = permanentlyRejectedReceipts[deliveryID] {
            throw APIClientError.rejected(ProblemDetails(
                type: "https://aedresponse.invalid/problems/\(rejectionStatus)",
                title: "Forbidden",
                status: rejectionStatus,
                detail: "An exited responder has no event communication permission"
            ))
        }
        if remainingReceiptFailures > 0 {
            remainingReceiptFailures -= 1
            throw TestReceiptError.network
        }
    }
    func respond(
        eventID: String,
        deliveryID: String,
        accept: Bool,
        decidedAt: Date
    ) async throws -> RespondResult {
        let index = responseDecisionAttempts.count
        responseDecisionAttempts.append(ResponseDecisionAttempt(
            eventID: eventID, deliveryID: deliveryID, accept: accept
        ))
        let shouldFail = remainingResponseDecisionFailures > 0
        if shouldFail { remainingResponseDecisionFailures -= 1 }
        if shouldSuspendNextResponseDecision {
            shouldSuspendNextResponseDecision = false
            await withCheckedContinuation { responseDecisionContinuations[index] = $0 }
        }
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return RespondResult(decision: accept ? .accept : .refuse, assignment: nil)
    }
    func responseDecisionAttemptRecords() -> [ResponseDecisionAttempt] { responseDecisionAttempts }
    func failNextResponseDecision() { remainingResponseDecisionFailures += 1 }
    func suspendNextResponseDecision() { shouldSuspendNextResponseDecision = true }
    func isResponseDecisionSuspended(_ index: Int) -> Bool { responseDecisionContinuations[index] != nil }
    func releaseResponseDecision(_ index: Int) {
        responseDecisionContinuations.removeValue(forKey: index)?.resume()
    }
    func releaseAllResponseDecisions() {
        let continuations = Array(responseDecisionContinuations.values)
        responseDecisionContinuations.removeAll()
        continuations.forEach { $0.resume() }
    }
    func reportAedUnavailable(
        reportID: String,
        eventID: String,
        assignmentID: String,
        aedID: String,
        reportedAt: Date,
        reason: String
    ) async throws {
        _ = reportID
        _ = reportedAt
        _ = reason
        aedUnavailableAttempts.append(AedUnavailableAttempt(
            eventID: eventID,
            assignmentID: assignmentID,
            aedID: aedID
        ))
        if suspendNextAedUnavailableReport {
            suspendNextAedUnavailableReport = false
            await withCheckedContinuation { continuation in
                suspendedAedUnavailableContinuation = continuation
            }
        }
        completedAedUnavailableReports += 1
    }
    func reportAedAcquired(_ receipt: AedAcquiredReceipt) async throws -> AedAcquiredReceipt {
        receipt
    }
    func updateAssignmentStatus(
        eventID: String,
        assignmentID: String,
        status: AssignmentStatus,
        occurredAt: Date
    ) async throws -> Assignment {
        throw APIClientError.invalidResponse
    }
    func timeline(eventID: String) async throws -> [TimelineEntry] {
        operations.append("timeline:\(eventID)")
        if timelineUnavailable { throw APIClientError.invalidResponse }
        return timelines[eventID] ?? []
    }
    func fetchPresence() async throws -> DevicePresence {
        makePresence(update: presenceUpdates.last)
    }
    func updatePresence(_ update: DevicePresenceUpdate) async throws -> DevicePresence {
        presenceUpdates.append(update)
        return makePresence(update: update)
    }
    func updateResponderPosition(
        _ request: ResponderPositionUpdate
    ) async throws -> PositionUpdateResult {
        operations.append("responder-position")
        let update = PositionUpdate(
            id: request.positionUpdateId,
            position: request.responderPosition,
            observedAt: request.observedAt
        )
        positionAttempts.append(update)
        if remainingPositionFailures > 0 {
            remainingPositionFailures -= 1
            throw APIClientError.invalidResponse
        }
        positionUpdates.append(update)
        return positionResult(id: request.positionUpdateId, observedAt: request.observedAt)
    }
    func updatePatientPosition(
        eventID: String,
        update: PatientPositionUpdate
    ) async throws -> PositionUpdateResult {
        operations.append("patient-position:\(eventID)")
        let record = PatientPositionRecord(eventID: eventID, update: update)
        patientPositionAttempts.append(record)
        if remainingPositionFailures > 0 {
            remainingPositionFailures -= 1
            throw APIClientError.invalidResponse
        }
        patientPositionUpdates.append(record)
        return positionResult(id: update.positionUpdateId, observedAt: update.observedAt)
    }
    func sendEventPositionBatch(
        eventID: String,
        batchID: String,
        batch: EventPositionBatch
    ) async throws -> EventPositionBatchAck {
        operations.append("event-position-batch:\(eventID)")
        let record = EventPositionBatchRecord(eventID: eventID, batchID: batchID, batch: batch)
        eventPositionAttempts.append(record)
        guard batch.eventId == eventID, batch.batchId == batchID else {
            throw EventPositionBatchValidationError.responseMismatch
        }
        if remainingEventPositionFailures > 0 {
            remainingEventPositionFailures -= 1
            throw APIClientError.unexpectedStatus(503)
        }
        if !queuedEventPositionRejections.isEmpty {
            throw APIClientError.unexpectedStatus(queuedEventPositionRejections.removeFirst())
        }
        if !eventPositionFailureStatuses.isEmpty {
            throw APIClientError.unexpectedStatus(eventPositionFailureStatuses.removeFirst())
        }
        eventPositionBatches.append(record)
        return EventPositionBatchAck(
            schemaVersion: "2.0",
            eventId: eventID,
            batchId: batchID,
            acceptedRecordCount: batch.records.count,
            idempotent: false,
            acknowledgedAt: Date(timeIntervalSince1970: 1_788_000_100),
            records: batch.records.map {
                EventPositionRecordAck(
                    recordId: $0.recordId,
                    persisted: true,
                    appliedToLatest: $0.status == .fix,
                    ignoredAsStale: false,
                    serverReceivedAt: Date(timeIntervalSince1970: 1_788_000_100)
                )
            }
        )
    }
    func responderPositionUpdates() -> [PositionUpdate] { positionUpdates }
    func responderPositionAttempts() -> [PositionUpdate] { positionAttempts }
    func responderPositionAttemptCount() -> Int { positionAttempts.count }
    func patientUpdates() -> [PatientPositionRecord] { patientPositionUpdates }
    func patientAttempts() -> [PatientPositionRecord] { patientPositionAttempts }
    func eventPositionBatchRecords() -> [EventPositionBatchRecord] { eventPositionBatches }
    func eventPositionBatchAttempts() -> [EventPositionBatchRecord] { eventPositionAttempts }
    func eventPositionBatchAttemptRecords() -> [EventPositionBatchRecord] { eventPositionAttempts }
    func recordedPresenceUpdates() -> [DevicePresenceUpdate] { presenceUpdates }
    func presenceUpdateCount() -> Int { presenceUpdates.count }
    func recordedOperations() -> [String] { operations }
    func failNextPositionUpdates(_ count: Int) { remainingPositionFailures = count }
    func failNextEventPositionBatches(_ count: Int) { remainingEventPositionFailures = count }
    func rejectNextEventPositionBatch(status: Int) {
        queuedEventPositionRejections.append(status)
    }
    func suspendNextAedUnavailableReportUntilResumed() {
        suspendNextAedUnavailableReport = true
    }
    func hasSuspendedAedUnavailableReport() -> Bool {
        suspendedAedUnavailableContinuation != nil
    }
    func resumeSuspendedAedUnavailableReport() {
        guard let continuation = suspendedAedUnavailableContinuation else { return }
        suspendedAedUnavailableContinuation = nil
        continuation.resume()
    }
    func completedAedUnavailableReportCount() -> Int {
        completedAedUnavailableReports
    }
    func recordedAedUnavailableAttempts() -> [AedUnavailableAttempt] {
        aedUnavailableAttempts
    }
    func failNextEventPositionBatchPermanently(status: Int = 422) {
        eventPositionFailureStatuses.append(status)
    }
    func fetchAeds() async throws -> [Aed] { [] }
    func estimateRoute(
        responderPosition: ResponderPosition,
        patientPosition: PatientPosition,
        at: Date
    ) async throws -> AedRoute {
        throw APIClientError.invalidResponse
    }

    func requestCompanionLinkTicket(
        companionPairID: String
    ) async throws -> CompanionLinkTicket {
        companionLinkTicketCount += 1
        return CompanionLinkTicket(
            companionLinkTicket: "ticket-\(companionLinkTicketCount)-abcdefghijklmnopqrstuvwxyz",
            companionPairId: companionPairID,
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
        )
    }

    func companionLinkTicketRequestCount() -> Int {
        companionLinkTicketCount
    }

    func revokeDeviceSession() async throws {
        logoutOperations.append("device")
    }

    func revokeAccountSession() async throws {
        logoutOperations.append("account")
    }

    /// Account deletion double.  `deletedAccounts` records every committed
    /// erasure so a test can assert the client actually asked the server instead
    /// of only clearing local state.
    func deleteAccount() async throws -> AccountDeletionReceipt {
        deleteAttempts += 1
        if let accountDeletionFailure {
            throw accountDeletionFailure
        }
        deletedAccounts.append("account")
        let at = Date(timeIntervalSince1970: 1_788_000_100)
        return AccountDeletionReceipt(
            requestId: "deletion:user-1",
            status: "REQUESTED",
            requestedAt: at,
            erasureStartedAt: at
        )
    }

    /// Report-a-found-patient: records the attempt and returns the configured event.
    private var foundPatientEvent: EmergencyEvent?
    private var foundPatientFailure: Error?
    private(set) var foundPatientAttempts: [FoundPatientAttempt] = []

    func succeedFoundPatient(with event: EmergencyEvent) {
        foundPatientEvent = event
        foundPatientFailure = nil
    }

    func failFoundPatient(with error: Error) {
        foundPatientFailure = error
    }

    func recordedFoundPatientAttempts() -> [FoundPatientAttempt] { foundPatientAttempts }

    func reportFoundPatient(
        eventID: String, observedAt: Date, patientPosition: PatientPosition
    ) async throws -> EmergencyEvent {
        foundPatientAttempts.append(FoundPatientAttempt(
            eventID: eventID, observedAt: observedAt, position: patientPosition
        ))
        if let foundPatientFailure { throw foundPatientFailure }
        guard let foundPatientEvent else { throw APIClientError.unsupportedOperation("found-patient") }
        return foundPatientEvent
    }

    func failAccountDeletion(with error: Error) {
        accountDeletionFailure = error
    }

    /// Clears an injected failure, so a test can show that a retry succeeds.
    func allowAccountDeletion() {
        accountDeletionFailure = nil
    }

    func recordedAccountDeletions() -> Int { deleteAttempts }

    func recordedLogoutOperations() -> [String] {
        logoutOperations
    }

    private func makePresence(update: DevicePresenceUpdate?) -> DevicePresence {
        DevicePresence(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-93f236895c7b",
            deviceKind: "IPHONE",
            lastSeenAt: update?.occurredAt ?? Date(timeIntervalSince1970: 1_788_000_100),
            lastPresenceUpdateId: update?.presenceUpdateId,
            lastPresenceOccurredAt: update?.occurredAt,
            availableForResponse: update?.availableForResponse ?? false,
            capabilities: update?.capabilities ?? DeviceCapabilities(
                notificationAuthorized: false,
                locationAuthorized: false
            ),
            position: nil,
            // No coordinate at all is UNAVAILABLE, never FRESH or STALE.
            freshness: .unavailable,
            ageSeconds: nil,
            currentEventId: nil,
            currentAssignmentId: nil
        )
    }

    private func positionResult(id: String, observedAt: Date) -> PositionUpdateResult {
        PositionUpdateResult(
            positionUpdateId: id,
            applied: true,
            idempotent: false,
            ignoredAsStale: false,
            positionObservedAt: observedAt,
            serverReceivedAt: observedAt.addingTimeInterval(0.1)
        )
    }
}

private enum TestReceiptError: Error {
    case network
}

@MainActor
private final class ReceiptErrorLog {
    private(set) var messages: [String] = []
    func append(_ message: String) { messages.append(message) }
}

@MainActor
private final class FakeEventStream: EventStreamClient {
    var onEvent: ((RealtimeEvent) -> Void)?
    private(set) var connectCount = 0
    private(set) var disconnectCount = 0

    func connect() { connectCount += 1 }
    func disconnect() { disconnectCount += 1 }
    func send(_ event: RealtimeEvent) { onEvent?(event) }
}

@MainActor
private final class FakeLocationSpeaker: LocationCardSpeaking {
    func speak(_ card: PatientLocationCard) {}
    func stop() {}
}

@MainActor
private struct FakeSafeDialer: SafeDialing {
    func open(policy: SafetyPolicy) async throws {}
}
