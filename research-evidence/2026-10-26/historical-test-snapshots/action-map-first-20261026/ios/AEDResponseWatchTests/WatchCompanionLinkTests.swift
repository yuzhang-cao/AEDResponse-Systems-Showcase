import CryptoKit
import Foundation
import Security
import XCTest
@testable import AEDResponseWatchLogic

final class WatchCompanionLinkTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_000_100)
    private let pairID = "REDACTED-SUPPLEMENT-ID-e2b400c8ac28"

    @MainActor
    func testBackgroundOnlyClickSurvivesReporterRestartAndDeliversWithoutSecondGesture() async throws {
        let defaults = try makeSuite(), state = SimulationMemoryState(), outbox = SimulationMemoryOutbox()
        let config = WatchConfigurationStore(defaults: defaults)
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let peer = RelayPhoneDouble(pair: pairID)
        let context = WatchSimulationContext(runId: UUID().uuidString, expiresAt: Date().addingTimeInterval(600))
        await peer.setSimulation(context)
        let transport = BackgroundTransportDouble(disk: RelayMailboxMemory())
        let relay = WatchRelayReporter(direct: direct, phone: transport, configuration: config,
            persistence: MemoryRelayStore(), directBackupEnabled: false)
        for _ in 0..<5 { _ = await relay.refreshPhoneLink(); try await transport.deliver(to: peer) }
        let link = await relay.refreshPhoneLink()
        XCTAssertTrue(link.backgroundReady)
        XCTAssertFalse(link.connected)
        let original = WatchControlledSimulationReporter(relay: relay, store: state)
        do { _ = try await original.prepareFall(); XCTFail("The context must queue") }
        catch { guard case CompanionRPCError.queued = error else { throw error } }
        let click = try XCTUnwrap(state.loadIntent())
        XCTAssertEqual(click.state, .pending)
        XCTAssertNil(try state.load())
        let restarted = WatchControlledSimulationReporter(relay: relay, store: state)
        let coordinator = FallEmergencyCoordinator(eventState: UserDefaultsFallEventStateStore(defaults: defaults,
            key: "background-synthetic-fall", makeEventID: { context.runId }), outbox: outbox,
            reporter: restarted, positionProvider: SimulationPositionProvider())
        try await transport.deliver(to: peer)
        let submitted = try await restarted.resumePendingFall(to: coordinator)
        XCTAssertEqual(submitted, .queuedForRetry(eventID: context.runId, fallDetectedAt: click.detectedAt))
        XCTAssertEqual(try state.loadIntent()?.state, .submitted)
        let facts = try outbox.pending(now: Date())
        XCTAssertEqual(facts.count, 1)
        XCTAssertEqual(facts.first?.fallDetectedAt, click.detectedAt)
        try await transport.deliver(to: peer)
        _ = await coordinator.retryPending(at: Date().addingTimeInterval(60))
        XCTAssertTrue(try outbox.pending(now: Date()).isEmpty)
        let resumedAgain = try await restarted.resumePendingFall(to: coordinator)
        XCTAssertNil(resumedAgain)
        let observations = await peer.simulationObservations
        XCTAssertEqual(observations.count, 1)
    }

    func testPreparationPreservesClickAndExpiresInsteadOfRetimingIt() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let peer = RelayPhoneDouble(pair: pairID)
        let relay = WatchRelayReporter(direct: direct, phone: peer, configuration: config,
            persistence: MemoryRelayStore(), directBackupEnabled: false)
        _ = await relay.refreshPhoneLink()
        let state = SimulationMemoryState()
        let sourceValue = await relay.observationSourceBinding()
        let source = try XCTUnwrap(sourceValue)
        let click = Date().addingTimeInterval(-FallEmergencyCoordinator.triggerRetryWindow - 1)
        try state.saveIntent(WatchSimulationIntent(relaySource: source, detectedAt: click))
        let reporter = WatchControlledSimulationReporter(relay: relay, store: state)
        await XCTAssertThrowsErrorAsync(try await reporter.prepareFall()) { error in
            XCTAssertTrue(error is WatchSimulationPreparationError)
        }
        XCTAssertEqual(try state.loadIntent()?.state, .expired)
        XCTAssertEqual(try state.loadIntent()?.detectedAt.timeIntervalSince1970 ?? 0, click.timeIntervalSince1970, accuracy: 0.002)
        XCTAssertNil(try state.load())
    }

    @MainActor
    func testOneClickControlledFallUsesRealCoordinatorWithoutHelpUIAndOnlyMarkedCompanionMethod() async throws {
        let defaults = try makeSuite()
        let config = WatchConfigurationStore(defaults: defaults)
        let http = RecordingWatchTransport(responses: [])
        let direct = WatchAPIReporter(configurationStore: config, transport: http,
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let context = WatchSimulationContext(runId: UUID().uuidString, expiresAt: Date().addingTimeInterval(600))
        await phone.setSimulation(context)
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config,
            persistence: MemoryRelayStore(), directBackupEnabled: false)
        _ = await relay.refreshPhoneLink()
        let state = SimulationMemoryState()
        let reporter = WatchControlledSimulationReporter(relay: relay, store: state)
        let fallDate = try await reporter.prepareFall()
        let persisted = try XCTUnwrap(state.load())
        XCTAssertEqual(fallDate, persisted.fallDetectedAt, "Use canonical persisted timestamp precision")
        let outbox = SimulationMemoryOutbox()
        let coordinator = FallEmergencyCoordinator(eventState: UserDefaultsFallEventStateStore(defaults: defaults,
            key: "synthetic-fall", makeEventID: { context.runId }), outbox: outbox, reporter: reporter,
            positionProvider: SimulationPositionProvider())
        let result = await WatchSimulationInput.submit(
            fall: FallDetectionSignal(detectedAt: fallDate, resolution: .confirmed),
            to: coordinator, answeredAt: Date())
        XCTAssertEqual(result, .reported(eventID: context.runId, fallDetectedAt: fallDate))
        XCTAssertTrue(try outbox.pending(now: Date()).isEmpty)
        let marked = await phone.simulationObservations
        let ordinary = await phone.observations
        XCTAssertEqual(marked.count, 1)
        XCTAssertTrue(ordinary.isEmpty)
        let received = try JSONDecoder.contractDecoder().decode(WatchEmergencyObservation.self, from: XCTUnwrap(marked.first).observationData)
        XCTAssertEqual(received.eventId, context.runId)
        XCTAssertEqual(received.appHelpResponse, .needsHelp)
        let directRequests = await http.requests()
        XCTAssertTrue(directRequests.isEmpty, "Synthetic facts never use direct Watch HTTPS")
    }

    func testMissingSimulationGrantDoesNotRevokeOrdinaryBinding() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let http = RecordingWatchTransport(responses: [])
        let direct = WatchAPIReporter(configurationStore: config, transport: http,
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config,
            persistence: MemoryRelayStore(), directBackupEnabled: false)
        _ = await relay.refreshPhoneLink()
        let reporter = WatchControlledSimulationReporter(relay: relay, store: SimulationMemoryState())
        await XCTAssertThrowsErrorAsync(try await reporter.prepareFall()) { _ in }
        let authorized = await relay.hasValidWatchSession()
        let requests = await http.requests()
        XCTAssertTrue(authorized)
        XCTAssertTrue(requests.isEmpty)
    }

    func testControlledReporterRejectsForeignEventAndWrongSourceBeforeSending() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let context = WatchSimulationContext(runId: UUID().uuidString, expiresAt: Date().addingTimeInterval(600))
        await phone.setSimulation(context)
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config,
            persistence: MemoryRelayStore(), directBackupEnabled: false)
        _ = await relay.refreshPhoneLink()
        let reporter = WatchControlledSimulationReporter(relay: relay, store: SimulationMemoryState())
        let date = try await reporter.prepareFall()
        let binding = await reporter.observationSourceBinding()
        let source = try XCTUnwrap(binding)
        let foreign = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: date,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "test")
        await XCTAssertThrowsErrorAsync(try await reporter.report(foreign, sourceBinding: source)) { _ in }
        let matching = WatchEmergencyObservation(eventId: context.runId, fallDetectedAt: date,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "test")
        await XCTAssertThrowsErrorAsync(try await reporter.report(matching, sourceBinding: String(repeating: "a", count: 64))) { _ in }
        let received = await phone.simulationObservations
        XCTAssertTrue(received.isEmpty)
    }

    func testControlledPreparationReportsSpecificFailureWithoutChangingAuthorization() {
        XCTAssertEqual(WatchSimulationFailurePresentation.message(for: CompanionRPCError.queued), "等待 iPhone 后台回复")
        XCTAssertEqual(WatchSimulationFailurePresentation.message(for: CompanionRPCError.remoteRejected(.unavailable, nil)), "等待 iPhone 服务恢复")
        XCTAssertEqual(WatchSimulationFailurePresentation.message(for: CompanionRPCError.remoteRejected(.serverRejected, 403)), "测试请求被拒（403）")
        XCTAssertEqual(WatchSimulationFailurePresentation.message(for: CompanionRPCError.remoteRejected(.serverRejected, 404)), "测试请求被拒（404）")
        XCTAssertEqual(WatchSimulationFailurePresentation.message(for: WatchAPIError.persistenceFailed), "测试记录保存失败")
        XCTAssertEqual(WatchSimulationFailurePresentation.message(for: WatchAPIError.sessionChanged), "测试授权已变化，请重试")
    }

    func testControlledFallbackNeverBecomesWANEligible() {
        let policy = ControlledSimulationFallbackPolicy()
        for reachable in [false, true] {
            XCTAssertEqual(policy.decision(connectivity: WatchConnectivityState(activationState: .activated,
                iphoneReachable: reachable), networkAvailable: true, serverAllowsFallback: true), .waitForIPhoneRecovery)
        }
    }

    func testAccountPairRecoveryReturnsToOriginalStableSourceBinding() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let original = configuration.load()
        let body = sessionBody(accessToken: "token", refreshToken: "refresh", expiresAt: now.addingTimeInterval(3600))
        let transport = RecordingWatchTransport(responses: [
            .json(statusCode: 201, body: body),
            .json(statusCode: 201, body: body.replacingOccurrences(of: "watch-user", with: "second-user")),
            .json(statusCode: 201, body: body)
        ])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(),
            appAttest: FakeWatchAppAttest(), now: { Date(timeIntervalSince1970: 1_788_000_100) })
        func envelope(_ pair: String) -> CompanionLinkEnvelope {
            CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pair,
                companionLinkTicket: UUID().uuidString + "ticket", expiresAt: now.addingTimeInterval(300))
        }
        try await reporter.recoverCompanionLink(envelope(pairID))
        let firstBinding = await reporter.observationSourceBinding()
        XCTAssertNotNil(firstBinding)
        try await reporter.recoverCompanionLink(envelope("REDACTED-SUPPLEMENT-ID-929164aa4f6a"))
        let secondBinding = await reporter.observationSourceBinding()
        XCTAssertNotEqual(firstBinding, secondBinding)
        XCTAssertNotEqual(configuration.load().deviceInstanceID, original.deviceInstanceID)
        try await reporter.recoverCompanionLink(envelope(pairID))
        let returnedBinding = await reporter.observationSourceBinding()
        XCTAssertEqual(returnedBinding, firstBinding)
        XCTAssertEqual(configuration.load().deviceInstanceID, original.deviceInstanceID)
    }

    func testRedeemUsesOnlyWhitelistedBodyAndDoesNotPersistTicket() async throws {
        let suite = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: suite)
        let deviceID = configuration.load().deviceInstanceID
        configuration.applyLinkedConfiguration(
            baseURL: "https://watch.example.test",
            companionPairID: pairID
        )
        let authStore = MemoryWatchAuthStore()
        let keyStore = MemoryAppAttestKeyStore()
        let attest = FakeWatchAppAttest()
        let transport = RecordingWatchTransport(responses: [
            .json(
                statusCode: 201,
                body: sessionBody(
                    accessToken: "watch-access",
                    refreshToken: "watch-refresh",
                    expiresAt: now.addingTimeInterval(3_600)
                )
            )
        ])
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: authStore,
            appAttestKeyStore: keyStore,
            appAttest: attest,
            now: { Date(timeIntervalSince1970: 1_788_000_100) }
        )
        let ticket = "ticket-abcdefghijklmnopqrstuvwxyz-0123456789"
        let envelope = CompanionLinkEnvelope(
            baseURL: "https://watch.example.test",
            companionPairId: pairID,
            companionLinkTicket: ticket,
            expiresAt: now.addingTimeInterval(300)
        )

        // The prior config intentionally has the same pair; only the envelope
        // itself carries the one-time ticket.
        try await reporter.redeemCompanionLink(envelope)

        let requests = await transport.requests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v2/watch/session/redeem")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let body = try jsonObject(request)
        XCTAssertEqual(
            Set(body.keys),
            [
                "deviceInstanceId", "companionPairId", "companionLinkTicket",
                "appAttestKeyId", "attestationObject"
            ]
        )
        XCTAssertEqual(body["deviceInstanceId"] as? String, deviceID)
        XCTAssertEqual(body["companionPairId"] as? String, pairID)
        XCTAssertEqual(body["companionLinkTicket"] as? String, ticket)
        XCTAssertEqual(body["appAttestKeyId"] as? String, "watch-attest-key")
        XCTAssertEqual(body["attestationObject"] as? String, "YXR0ZXN0YXRpb24=")
        XCTAssertEqual(authStore.loadAuthSession()?.accessToken, "watch-access")
        XCTAssertEqual(keyStore.loadAppAttestKeyID(), "watch-attest-key")
        XCTAssertFalse(suite.dictionaryRepresentation().values.contains {
            String(describing: $0).contains(ticket)
        })

        let ticketHash = SHA256.hash(data: Data(ticket.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let canonical = "{\"purpose\":\"AEDResponse.watch-companion-link\",\"companionLinkTicketHash\":\"\(ticketHash)\",\"deviceInstanceId\":\"\(deviceID)\",\"companionPairId\":\"\(pairID)\"}"
        XCTAssertEqual(
            attest.clientDataHashes,
            [Data(SHA256.hash(data: Data(canonical.utf8)))]
        )
    }

    func testWrongPairAndExpiredEnvelopeAreRejectedBeforeAttestationOrNetwork() async throws {
        let suite = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: suite)
        configuration.applyLinkedConfiguration(
            baseURL: "https://watch.example.test",
            companionPairID: pairID
        )
        let transport = RecordingWatchTransport(responses: [])
        let attest = FakeWatchAppAttest()
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: MemoryWatchAuthStore(),
            appAttestKeyStore: MemoryAppAttestKeyStore(),
            appAttest: attest,
            now: { Date(timeIntervalSince1970: 1_788_000_100) }
        )

        await XCTAssertThrowsErrorAsync(
            try await reporter.redeemCompanionLink(
                CompanionLinkEnvelope(
                    baseURL: "https://watch.example.test",
                    companionPairId: "REDACTED-SUPPLEMENT-ID-929164aa4f6a",
                    companionLinkTicket: "ticket-wrong-pair-abcdefghijklmnopqrstuvwxyz",
                    expiresAt: now.addingTimeInterval(300)
                )
            )
        ) { error in
            XCTAssertTrue(error is WatchAPIError)
        }
        await XCTAssertThrowsErrorAsync(
            try await reporter.redeemCompanionLink(
                CompanionLinkEnvelope(
                    baseURL: "https://watch.example.test",
                    companionPairId: pairID,
                    companionLinkTicket: "ticket-expired-abcdefghijklmnopqrstuvwxyz",
                    expiresAt: now.addingTimeInterval(-1)
                )
            )
        ) { error in
            XCTAssertTrue(error is WatchAPIError)
        }
        let rejectedRequestCount = await transport.requests().count
        XCTAssertEqual(rejectedRequestCount, 0)
        XCTAssertTrue(attest.clientDataHashes.isEmpty)
    }

    func testDuplicateEnvelopeDoesNotAttestOrRedeemSameKeyTwice() async throws {
        let suite = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: suite)
        configuration.applyLinkedConfiguration(
            baseURL: "https://watch.example.test",
            companionPairID: pairID
        )
        let transport = RecordingWatchTransport(responses: [
            .json(
                statusCode: 201,
                body: sessionBody(
                    accessToken: "watch-access",
                    refreshToken: "watch-refresh",
                    expiresAt: now.addingTimeInterval(3_600)
                )
            )
        ])
        let attest = FakeWatchAppAttest()
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: MemoryWatchAuthStore(),
            appAttestKeyStore: MemoryAppAttestKeyStore(),
            appAttest: attest,
            now: { Date(timeIntervalSince1970: 1_788_000_100) }
        )
        let envelope = CompanionLinkEnvelope(
            baseURL: "https://watch.example.test",
            companionPairId: pairID,
            companionLinkTicket: "ticket-duplicate-abcdefghijklmnopqrstuvwxyz",
            expiresAt: now.addingTimeInterval(300)
        )

        try await reporter.redeemCompanionLink(envelope)
        try await reporter.redeemCompanionLink(envelope)

        let requestCount = await transport.requests().count
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(attest.generateCount, 1)
        XCTAssertEqual(attest.attestCount, 1)
    }

    func testWatchRefreshRotatesKeychainSessionWithoutLegacyBootstrap() async throws {
        let suite = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: suite)
        configuration.applyLinkedConfiguration(
            baseURL: "https://watch.example.test",
            companionPairID: pairID
        )
        let deviceID = configuration.load().deviceInstanceID
        let old = WatchAuthSession(
            accessToken: "old-watch-access",
            refreshToken: "old-watch-refresh",
            expiresAt: now.addingTimeInterval(1),
            baseURL: "https://watch.example.test/api/v2/",
            deviceInstanceID: deviceID,
            companionPairID: pairID
        )
        let authStore = MemoryWatchAuthStore(session: old)
        let transport = RecordingWatchTransport(responses: [
            .json(
                statusCode: 200,
                body: sessionBody(
                    accessToken: "new-watch-access",
                    refreshToken: "new-watch-refresh",
                    expiresAt: now.addingTimeInterval(3_600)
                )
            ),
            .json(statusCode: 200, body: positionBody(positionUpdateID: "position-1"))
        ])
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: authStore,
            appAttestKeyStore: MemoryAppAttestKeyStore(),
            appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) }
        )
        let update = try WatchFallbackPositionUpdate(
            eventId: "REDACTED-SUPPLEMENT-ID-be8562f9e1ca",
            positionUpdateId: "position-1",
            observedAt: now,
            patientPosition: PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            activationState: .activated,
            iphoneReachable: false,
            networkAvailable: true
        )

        _ = try await reporter.reportFallbackPosition(update)

        let requests = await transport.requests()
        XCTAssertEqual(requests.map { $0.httpMethod }, ["POST", "PUT"])
        XCTAssertEqual(requests[0].url?.path, "/api/v2/watch/session/refresh")
        XCTAssertEqual(
            requests[1].url?.path,
            "/api/v2/watch/events/REDACTED-SUPPLEMENT-ID-be8562f9e1ca/fallback-position/position-1"
        )
        XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(
            requests[1].value(forHTTPHeaderField: "Authorization"),
            "Bearer [REDACTED]"
        )
        XCTAssertEqual(authStore.loadAuthSession()?.refreshToken, "new-watch-refresh")
    }

    func testTemporaryRefreshFailurePreservesCredentialsForRecovery() async throws {
        let suite = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: suite)
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test/api/v2/", companionPairID: pairID)
        let old = WatchAuthSession(accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now.addingTimeInterval(1),
            baseURL: "https://watch.example.test/api/v2/", deviceInstanceID: configuration.load().deviceInstanceID,
            companionPairID: pairID)
        let authStore = MemoryWatchAuthStore(session: old)
        let transport = RecordingWatchTransport(responses: [
            .json(statusCode: 503, body: "{}"),
            .json(statusCode: 200, body: sessionBody(accessToken: "recovered-access", refreshToken: "recovered-refresh",
                expiresAt: now.addingTimeInterval(3_600)))
        ])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: authStore, appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let failed = await reporter.restoreWatchSession(remoteValidation: true)
        XCTAssertFalse(failed)
        XCTAssertEqual(authStore.loadAuthSession(), old)
        let restored = await reporter.restoreWatchSession(remoteValidation: true)
        XCTAssertTrue(restored)
        XCTAssertEqual(authStore.loadAuthSession()?.refreshToken, "recovered-refresh")
        let requests = await transport.requests()
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/v2/watch/session/refresh", "/api/v2/watch/session/refresh"])
    }

    func testFallbackForbiddenDoesNotRotateRefreshFamily() async throws {
        let suite = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: suite)
        configuration.applyLinkedConfiguration(
            baseURL: "https://watch.example.test",
            companionPairID: pairID
        )
        let deviceID = configuration.load().deviceInstanceID
        let authStore = MemoryWatchAuthStore(session: WatchAuthSession(
            accessToken: "watch-access",
            refreshToken: "watch-refresh",
            expiresAt: now.addingTimeInterval(3_600),
            baseURL: "https://watch.example.test/api/v2/",
            deviceInstanceID: deviceID,
            companionPairID: pairID
        ))
        let transport = RecordingWatchTransport(responses: [
            .json(statusCode: 403, body: "{}")
        ])
        let reporter = WatchAPIReporter(
            configurationStore: configuration,
            transport: transport,
            authSessionStore: authStore,
            appAttestKeyStore: MemoryAppAttestKeyStore(),
            appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) }
        )
        let update = try WatchFallbackPositionUpdate(
            eventId: "REDACTED-SUPPLEMENT-ID-4d3a12e501b3",
            positionUpdateId: "position-2",
            observedAt: now,
            patientPosition: PatientPosition(
                latitude: 22.1987,
                longitude: 113.5439,
                accuracyMeters: 12
            ),
            activationState: .activated,
            iphoneReachable: true,
            networkAvailable: true
        )

        await XCTAssertThrowsErrorAsync(try await reporter.reportFallbackPosition(update)) { error in
            guard case WatchAPIError.rejected(403) = error else {
                return XCTFail("expected HTTP 403 rejection")
            }
        }
        let requestCount = await transport.requests().count
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(authStore.loadAuthSession()?.refreshToken, "watch-refresh")
    }

    func testDistinctCompanionTicketMustReachBackendEvenWhenLocalSessionLooksValid() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let auth = MemoryWatchAuthStore()
        let transport = RecordingWatchTransport(responses: [
            .json(statusCode: 201, body: sessionBody(accessToken: "first", refreshToken: "first-refresh", expiresAt: now.addingTimeInterval(3600))),
            .json(statusCode: 201, body: sessionBody(accessToken: "second", refreshToken: "second-refresh", expiresAt: now.addingTimeInterval(3600)))
        ])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: auth, appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        for ticket in ["new-ticket-one", "new-ticket-two"] {
            try await reporter.redeemCompanionLink(CompanionLinkEnvelope(baseURL: "https://watch.example.test",
                companionPairId: pairID, companionLinkTicket: ticket, expiresAt: now.addingTimeInterval(300)))
        }
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 2, "A distinct ticket needs backend acceptance, not local-session inference")
        XCTAssertEqual(auth.loadAuthSession()?.accessToken, "second")
    }

    func testEarlierRedeemResponseCannotReplaceLaterCompletedSession() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let auth = MemoryWatchAuthStore()
        let transport = DelayedLinkTransport(first: sessionBody(accessToken: "earlier", refreshToken: "earlier-refresh", expiresAt: now.addingTimeInterval(3600)),
            second: sessionBody(accessToken: "later", refreshToken: "later-refresh", expiresAt: now.addingTimeInterval(3600)))
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: auth, appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let first = CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pairID,
            companionLinkTicket: "earlier-ticket", expiresAt: now.addingTimeInterval(300))
        let second = CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pairID,
            companionLinkTicket: "later-ticket", expiresAt: now.addingTimeInterval(300))
        let task = Task { try await reporter.redeemCompanionLink(first) }
        for _ in 0..<200 { if await transport.isSuspended() { break }; try await Task.sleep(for: .milliseconds(2)) }
        guard await transport.isSuspended() else { task.cancel(); XCTFail("First redeem did not suspend"); return }
        try await reporter.redeemCompanionLink(second)
        await transport.release()
        do { try await task.value } catch { guard case WatchAPIError.sessionChanged = error else { throw error } }
        XCTAssertEqual(auth.loadAuthSession()?.accessToken, "later")
    }

    func testConcurrentIdenticalTicketAndRestartUseOneAcceptedExchange() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let auth = MemoryWatchAuthStore()
        let attest = FakeWatchAppAttest()
        let transport = DelayedLinkTransport(first: sessionBody(accessToken: "one", refreshToken: "one-refresh", expiresAt: now.addingTimeInterval(3600)), second: "{}")
        let key = MemoryAppAttestKeyStore()
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: auth, appAttestKeyStore: key, appAttest: attest,
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let ticket = "deduplicated-raw-ticket"
        let envelope = CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pairID,
            companionLinkTicket: ticket, expiresAt: now.addingTimeInterval(300))
        let first = Task { try await reporter.redeemCompanionLink(envelope) }
        for _ in 0..<200 { if await transport.isSuspended() { break }; try await Task.sleep(for: .milliseconds(2)) }
        guard await transport.isSuspended() else { first.cancel(); XCTFail("Redeem did not suspend"); return }
        let duplicate = Task { try await reporter.redeemCompanionLink(envelope) }
        await transport.release()
        try await first.value
        try await duplicate.value
        let accepted = await reporter.hasValidWatchSession()
        XCTAssertTrue(accepted)
        XCTAssertEqual(attest.attestCount, 1)
        let saved = try XCTUnwrap(auth.loadAuthSession())
        XCTAssertNotNil(saved.companionLinkFingerprint)
        XCTAssertFalse(String(decoding: try JSONEncoder.contractEncoder().encode(saved), as: UTF8.self).contains(ticket))
        let newTransport = RecordingWatchTransport(responses: [])
        let restored = WatchAPIReporter(configurationStore: configuration, transport: newTransport,
            authSessionStore: auth, appAttestKeyStore: key, appAttest: attest,
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        try await restored.redeemCompanionLink(envelope)
        let requests = await newTransport.requests()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertEqual(attest.attestCount, 1)
    }

    func testOldRefreshCannotOverwriteAcceptedLinkButSurvivesFailedLinkAttempt() async throws {
        for status in [201, 503] {
            let configuration = WatchConfigurationStore(defaults: try makeSuite())
            configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
            let auth = MemoryWatchAuthStore(session: WatchAuthSession(accessToken: "old", refreshToken: "old-refresh",
                expiresAt: now.addingTimeInterval(3600), baseURL: "https://watch.example.test/api/v2/",
                deviceInstanceID: configuration.load().deviceInstanceID, companionPairID: pairID))
            let transport = DelayedLinkTransport(first: sessionBody(accessToken: "rotated", refreshToken: "rotated-refresh", expiresAt: now.addingTimeInterval(3600)),
                second: sessionBody(accessToken: "accepted", refreshToken: "accepted-refresh", expiresAt: now.addingTimeInterval(3600)),
                firstStatus: 200, secondStatus: status)
            let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
                authSessionStore: auth, appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
                now: { Date(timeIntervalSince1970: 1_788_000_100) })
            let refresh = Task { await reporter.restoreWatchSession(remoteValidation: true) }
            for _ in 0..<200 { if await transport.isSuspended() { break }; try await Task.sleep(for: .milliseconds(2)) }
            guard await transport.isSuspended() else { refresh.cancel(); XCTFail("Refresh did not suspend"); return }
            let envelope = CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pairID,
                companionLinkTicket: "new-link-ticket", expiresAt: now.addingTimeInterval(300))
            do { try await reporter.redeemCompanionLink(envelope); XCTAssertEqual(status, 201) }
            catch { guard case WatchAPIError.rejected(503) = error, status == 503 else { throw error } }
            await transport.release()
            _ = await refresh.value
            XCTAssertEqual(auth.loadAuthSession()?.accessToken, status == 201 ? "accepted" : "rotated")
            let valid = await reporter.hasValidWatchSession()
            XCTAssertTrue(valid)
        }
    }

    func testChangedConfigurationMakesOldRedeemUnableToOverwriteSessionOrKey() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let auth = MemoryWatchAuthStore()
        let key = MemoryAppAttestKeyStore()
        let transport = DelayedLinkTransport(first: sessionBody(accessToken: "old-response", refreshToken: "old-refresh", expiresAt: now.addingTimeInterval(3600)), second: "{}")
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: auth, appAttestKeyStore: key, appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let envelope = CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pairID,
            companionLinkTicket: "old-link", expiresAt: now.addingTimeInterval(300))
        let request = Task { try await reporter.redeemCompanionLink(envelope) }
        for _ in 0..<200 { if await transport.isSuspended() { break }; try await Task.sleep(for: .milliseconds(2)) }
        guard await transport.isSuspended() else { request.cancel(); XCTFail("Redeem did not suspend"); return }
        configuration.applyLinkedConfiguration(baseURL: "https://different.example.test", companionPairID: pairID)
        let newer = WatchAuthSession(accessToken: "newer", refreshToken: "newer-refresh", expiresAt: now.addingTimeInterval(3600),
            baseURL: "https://different.example.test/api/v2/", deviceInstanceID: configuration.load().deviceInstanceID, companionPairID: pairID)
        try auth.saveAuthSession(newer)
        try key.saveAppAttestKeyID("newer-key")
        await transport.release()
        do { try await request.value; XCTFail("Obsolete result was applied") }
        catch { guard case WatchAPIError.sessionChanged = error else { throw error } }
        XCTAssertEqual(auth.loadAuthSession(), newer)
        XCTAssertEqual(key.loadAppAttestKeyID(), "newer-key")
    }

    func testFirstAcceptedEnvelopeInitializesPreviouslyEmptyLocalConfiguration() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        XCTAssertEqual(configuration.load().companionPairID, "")
        let auth = MemoryWatchAuthStore()
        let transport = RecordingWatchTransport(responses: [
            .json(statusCode: 201, body: sessionBody(accessToken: "first-link", refreshToken: "first-refresh", expiresAt: now.addingTimeInterval(3600)))
        ])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport,
            authSessionStore: auth, appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        try await reporter.redeemCompanionLink(CompanionLinkEnvelope(baseURL: "https://watch.example.test",
            companionPairId: pairID, companionLinkTicket: "first-link-ticket", expiresAt: now.addingTimeInterval(300)))
        XCTAssertEqual(configuration.load().companionPairID, pairID)
        let valid = await reporter.hasValidWatchSession()
        XCTAssertTrue(valid)
        XCTAssertEqual(auth.loadAuthSession()?.accessToken, "first-link")
    }

    private func makeSuite() throws -> UserDefaults {
        try XCTUnwrap(UserDefaults(suiteName: "WatchCompanionLinkTests.\(UUID().uuidString)"))
    }

    func testRelayConnectsAndReportsWithoutAnIndependentWatchSession() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let http = RecordingWatchTransport(responses: [])
        let direct = WatchAPIReporter(configurationStore: config, transport: http,
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(),
            appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let persistence = MemoryRelayStore()
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        let status = await relay.refreshPhoneLink()
        XCTAssertTrue(status.connected)
        XCTAssertFalse(status.directUploadReady)
        let sourceValue = await relay.observationSourceBinding()
        let source = try XCTUnwrap(sourceValue)
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: Date(),
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil,
            locationUnavailableReason: "test-no-fix")
        try await relay.report(observation, sourceBinding: source)
        let received = await phone.observations
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(try JSONDecoder.contractDecoder().decode(WatchEmergencyObservation.self,
            from: received[0].observationData).eventId, observation.eventId)
        let directRequests = await http.requests()
        XCTAssertTrue(directRequests.isEmpty)
        let restarted = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        let restoredSource = await restarted.observationSourceBinding()
        XCTAssertEqual(restoredSource, source)
        await phone.setReachable(false)
        let offline = await relay.refreshPhoneLink()
        XCTAssertFalse(offline.connected)
        let stillBound = await relay.hasValidWatchSession()
        XCTAssertTrue(stillBound, "A transient disconnect must retain the unexpired binding")
    }

    func testRelayRejectsWrongACKAndWrongSource() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: MemoryRelayStore())
        _ = await relay.refreshPhoneLink()
        let sourceValue = await relay.observationSourceBinding()
        let source = try XCTUnwrap(sourceValue)
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: Date(),
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil,
            locationUnavailableReason: "test-no-fix")
        await phone.setWrongACK(true)
        await XCTAssertThrowsErrorAsync(try await relay.report(observation, sourceBinding: source)) { _ in }
        await XCTAssertThrowsErrorAsync(try await relay.report(observation, sourceBinding: String(repeating: "0", count: 64))) { _ in }
        let received = await phone.observations
        XCTAssertEqual(received.count, 1, "An account/source mismatch must never reach the phone")
    }

    func testExpiredUploadLeaseDoesNotEraseMonitoringIdentityOrSource() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let persistence = MemoryRelayStore()
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        _ = await relay.refreshPhoneLink()
        let source = await relay.observationSourceBinding()
        let saved = try XCTUnwrap(persistence.loadRelaySession())
        let b = saved.binding
        try persistence.saveRelaySession(WatchRelaySession(baseURL: saved.baseURL, binding: CompanionRelayBinding(
            bindingId: b.bindingId, iPhoneDeviceId: b.iPhoneDeviceId, deviceInstanceId: b.deviceInstanceId,
            companionPairId: b.companionPairId, userId: b.userId, accountId: b.accountId,
            expiresAt: Date().addingTimeInterval(-3600))))
        await phone.setReachable(false)
        await phone.setBackgroundEnabled(true)
        let restarted = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        let status = await restarted.refreshPhoneLink()
        let authorized = await restarted.hasValidWatchSession()
        let recoveredSource = await restarted.observationSourceBinding()
        XCTAssertTrue(authorized)
        XCTAssertEqual(recoveredSource, source)
        XCTAssertTrue(status.backgroundReady)
        XCTAssertFalse(status.connected, "Background readiness is not proof of an instantaneous reply")
        XCTAssertFalse(status.directUploadReady, "An enduring binding never creates a direct Watch bearer")
    }

    func testUnavailableIsTransientButExplicitAuthorizationLossPersistsAcrossRestart() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let persistence = MemoryRelayStore()
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        _ = await relay.refreshPhoneLink()
        await phone.setForcedStatus(.unavailable)
        let temporary = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        _ = await temporary.refreshPhoneLink()
        let stillAuthorized = await temporary.hasValidWatchSession()
        XCTAssertTrue(stillAuthorized)
        await phone.setForcedStatus(.authorizationRequired)
        _ = await temporary.refreshPhoneLink()
        let revoked = await temporary.hasValidWatchSession()
        XCTAssertFalse(revoked)
        XCTAssertEqual(try persistence.loadRelaySession()?.authorizationSuspended, true)
        let restarted = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        let afterRestart = await restarted.hasValidWatchSession()
        XCTAssertFalse(afterRestart)
        XCTAssertNotNil(try persistence.loadRelaySession(), "Keep identity/outbox; do not silently reset or re-pair")
    }

    func testBackgroundObservationIsQueuedWithoutClaimingServerACK() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let http = RecordingWatchTransport(responses: [])
        let direct = WatchAPIReporter(configurationStore: config, transport: http,
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: MemoryRelayStore())
        _ = await relay.refreshPhoneLink()
        let sourceValue = await relay.observationSourceBinding()
        let source = try XCTUnwrap(sourceValue)
        await phone.setReachable(false)
        await phone.setBackgroundEnabled(true)
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: Date(),
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "offline-test")
        do { try await relay.report(observation, sourceBinding: source); XCTFail("Queued transport is not a server ACK") }
        catch { guard case CompanionRPCError.queued = error else { throw error } }
        let queued = await phone.queuedMethods
        XCTAssertTrue(queued.contains(.observation))
        let directRequests = await http.requests()
        XCTAssertTrue(directRequests.isEmpty)
    }

    func testDifferentPhoneOwnerControlCannotReuseOldBinding() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let persistence = MemoryRelayStore()
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        _ = await relay.refreshPhoneLink()
        await phone.setControl(CompanionServiceControl(installationID: UUID().uuidString, revision: 1,
            owner: CompanionServiceControl.owner(userID: "different-user", deviceID: "phone", pairID: pairID), authorized: true))
        let authorized = await relay.hasValidWatchSession()
        let source = await relay.observationSourceBinding()
        XCTAssertFalse(authorized)
        XCTAssertNil(source)
        XCTAssertEqual(try persistence.loadRelaySession()?.authorizationSuspended, true)
    }

    func testSameOwnerReauthorizationAdvancesRevisionToUnblockPendingFacts() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let persistence = MemoryRelayStore()
        let initial = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        _ = await initial.refreshPhoneLink()
        let originalSource = await initial.observationSourceBinding()
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        await phone.setForcedStatus(.authorizationRequired)
        _ = await relay.refreshPhoneLink()
        let blockedRevision = await relay.authorizationRevision()
        await phone.setForcedStatus(nil)
        _ = await relay.refreshPhoneLink()
        let restoredRevision = await relay.authorizationRevision()
        let restoredSource = await relay.observationSourceBinding()
        XCTAssertGreaterThan(restoredRevision, blockedRevision)
        XCTAssertEqual(restoredSource, originalSource)
        XCTAssertNotEqual(try persistence.loadRelaySession()?.authorizationSuspended, true)
    }

    func testReportAuthorizationDenialSuspendsTheGrantNotJustTheHeartbeat() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        let persistence = MemoryRelayStore()
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: persistence)
        _ = await relay.refreshPhoneLink()
        let sourceValue = await relay.observationSourceBinding()
        let source = try XCTUnwrap(sourceValue)
        await phone.setForcedStatus(.serverRejected, httpStatus: 403)
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: Date(),
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "offline-unit-test")
        await XCTAssertThrowsErrorAsync(try await relay.report(observation, sourceBinding: source)) { _ in }
        let authorized = await relay.hasValidWatchSession()
        XCTAssertFalse(authorized)
        XCTAssertEqual(try persistence.loadRelaySession()?.authorizationSuspended, true)
    }

    @MainActor
    func testWholeHandshakeAndObservationCanFinishUsingOnlyBackgroundTransfers() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let peer = RelayPhoneDouble(pair: pairID)
        let disk = RelayMailboxMemory()
        let background = BackgroundTransportDouble(disk: disk)
        let bindings = MemoryRelayStore()
        let reporter = WatchRelayReporter(direct: direct, phone: background, configuration: config, persistence: bindings)
        for _ in 0..<5 {
            _ = await reporter.refreshPhoneLink()
            try await background.deliver(to: peer)
        }
        let status = await reporter.refreshPhoneLink()
        XCTAssertTrue(status.backgroundReady)
        XCTAssertFalse(status.connected)
        let sourceValue = await reporter.observationSourceBinding()
        let source = try XCTUnwrap(sourceValue)
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: Date(),
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "offline-unit-test")
        do { try await reporter.report(observation, sourceBinding: source); XCTFail("No server ACK yet") }
        catch { guard case CompanionRPCError.queued = error else { throw error } }
        try await background.deliver(to: peer)
        // The callback arrived while the original reporter was absent. Its
        // durable response and the binding must still reconcile after restart.
        let restartedTransport = BackgroundTransportDouble(disk: disk)
        let restarted = WatchRelayReporter(direct: direct, phone: restartedTransport, configuration: config, persistence: bindings)
        try await restarted.report(observation, sourceBinding: source)
        XCTAssertTrue(restartedTransport.queued.isEmpty)
        let received = await peer.observations
        XCTAssertEqual(received.count, 1)
    }

    func testRelayRefusesAnUncorrelatedHandshakeReply() async throws {
        let config = WatchConfigurationStore(defaults: try makeSuite())
        let direct = WatchAPIReporter(configurationStore: config, transport: RecordingWatchTransport(responses: []),
            authSessionStore: MemoryWatchAuthStore(), appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
        let phone = RelayPhoneDouble(pair: pairID)
        await phone.setWrongNonce(true)
        let relay = WatchRelayReporter(direct: direct, phone: phone, configuration: config, persistence: MemoryRelayStore())
        let status = await relay.refreshPhoneLink()
        XCTAssertFalse(status.connected)
        let linked = await relay.hasValidWatchSession()
        XCTAssertFalse(linked)
        XCTAssertEqual(config.load().companionPairID, "")
    }

    func testRPCEnvelopeRejectsExtraKeysAndOversizedPayloads() throws {
        let request = try CompanionRPCRequest(method: .context, body: CompanionRPCEmpty())
        XCTAssertNotNil(CompanionRPCRequest(propertyList: request.propertyList()))
        var invalid = request.propertyList()
        invalid["token"] = "must-not-cross-link"
        XCTAssertNil(CompanionRPCRequest(propertyList: invalid))
        invalid = request.propertyList()
        invalid["payload"] = Data(repeating: 0, count: CompanionRPCRequest.maximumPayloadBytes + 1)
        XCTAssertNil(CompanionRPCRequest(propertyList: invalid))
        invalid = request.propertyList()
        invalid["payload"] = Data("{\"token\":\"unexpected\"}".utf8)
        XCTAssertNil(CompanionRPCRequest(propertyList: invalid))
    }

    @MainActor
    func testRPCReplyFromBackgroundQueueDoesNotInheritMainActorOrResumeTwice() async throws {
        let request = try CompanionRPCRequest(method: .context, body: CompanionRPCEmpty())
        let expected = try CompanionRPCReply(request: request, body: CompanionRPCEmpty())
        let actual = try await withCheckedThrowingContinuation { continuation in
            let completion = CompanionRPCCompletion(continuation)
            let callback = completion.replyHandler(requestID: request.requestID)
            let failed = completion.errorHandler()
            completion.armTimeout()
            Task.detached {
                callback(expected.propertyList())
                callback(expected.propertyList())
                failed(CompanionRPCError.unavailable)
            }
        }
        XCTAssertEqual(actual.requestID, request.requestID)
        XCTAssertEqual(actual.status, .ok)
    }

    @MainActor
    func testRPCBackgroundErrorCallbackCompletesWithoutActorTrap() async {
        do {
            let _: CompanionRPCReply = try await withCheckedThrowingContinuation { continuation in
                let completion = CompanionRPCCompletion(continuation)
                let callback = completion.errorHandler()
                completion.armTimeout()
                Task.detached { callback(CompanionRPCError.unavailable) }
            }
            XCTFail("Expected transport failure")
        } catch { XCTAssertTrue(error is CompanionRPCError) }
    }

    func testSourceBindingUsesPrincipalAndSurvivesTokenRefreshAndRestart() async throws {
        let defaults = try makeSuite()
        let configuration = WatchConfigurationStore(defaults: defaults)
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let device = configuration.load().deviceInstanceID
        let old = WatchAuthSession(accessToken: "old", refreshToken: "old-refresh", expiresAt: now.addingTimeInterval(1),
            baseURL: "https://watch.example.test/api/v2/", deviceInstanceID: device, companionPairID: pairID,
            userID: "watch-user", accountID: "watch-account")
        let auth = MemoryWatchAuthStore(session: old)
        let transport = RecordingWatchTransport(responses: [.json(statusCode: 200,
            body: sessionBody(accessToken: "new", refreshToken: "new-refresh", expiresAt: now.addingTimeInterval(3600)))])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport, authSessionStore: auth,
            appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let before = await reporter.observationSourceBinding()
        XCTAssertNotNil(before)
        let restored = await reporter.restoreWatchSession(remoteValidation: true)
        XCTAssertTrue(restored)
        let after = await reporter.observationSourceBinding()
        XCTAssertEqual(before, after)
        let reloaded = WatchAPIReporter(configurationStore: configuration, transport: transport, authSessionStore: auth,
            appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let reopened = await reloaded.observationSourceBinding()
        XCTAssertEqual(reopened, before)
        XCTAssertEqual(auth.loadAuthSession()?.accessToken, "new")
        for (user, account) in [("another-user", "watch-account"), ("watch-user", "another-account")] {
            let different = WatchAPIReporter(configurationStore: configuration, transport: transport,
                authSessionStore: MemoryWatchAuthStore(session: WatchAuthSession(accessToken: "new", refreshToken: "new-refresh",
                    expiresAt: now.addingTimeInterval(3600), baseURL: old.baseURL, deviceInstanceID: device,
                    companionPairID: pairID, userID: user, accountID: account)),
                appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest())
            let changed = await different.observationSourceBinding()
            XCTAssertNotEqual(changed, before)
        }
    }

    func testRefreshCannotReplaceKnownPrincipalAndMissingResponseIdentityIsRejected() async throws {
        for identity in ["missing", "different"] {
            let configuration = WatchConfigurationStore(defaults: try makeSuite())
            configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
            let old = WatchAuthSession(accessToken: "old", refreshToken: "old-refresh", expiresAt: now.addingTimeInterval(1),
                baseURL: "https://watch.example.test/api/v2/", deviceInstanceID: configuration.load().deviceInstanceID,
                companionPairID: pairID, userID: "watch-user", accountID: "watch-account")
            let auth = MemoryWatchAuthStore(session: old)
            var body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sessionBody(accessToken: "new", refreshToken: "new-refresh",
                expiresAt: now.addingTimeInterval(3600)).utf8)) as? [String: Any])
            if identity == "missing" { body.removeValue(forKey: "userId") }
            else { body["userId"] = "another-user" }
            let transport = RecordingWatchTransport(responses: [.json(statusCode: 200,
                body: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self))])
            let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport, authSessionStore: auth,
                appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
                now: { Date(timeIntervalSince1970: 1_788_000_100) })
            let restored = await reporter.restoreWatchSession(remoteValidation: true)
            XCTAssertFalse(restored)
            XCTAssertEqual(auth.loadAuthSession(), old)
        }
    }

    func testReporterRejectsWrongObservationSourceBeforeAnyNetworkRequest() async throws {
        let configuration = WatchConfigurationStore(defaults: try makeSuite())
        configuration.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pairID)
        let auth = MemoryWatchAuthStore(session: WatchAuthSession(accessToken: "current", refreshToken: "refresh",
            expiresAt: now.addingTimeInterval(3600), baseURL: "https://watch.example.test/api/v2/",
            deviceInstanceID: configuration.load().deviceInstanceID, companionPairID: pairID,
            userID: "watch-user", accountID: "watch-account"))
        let transport = RecordingWatchTransport(responses: [])
        let reporter = WatchAPIReporter(configurationStore: configuration, transport: transport, authSessionStore: auth,
            appAttestKeyStore: MemoryAppAttestKeyStore(), appAttest: FakeWatchAppAttest(),
            now: { Date(timeIntervalSince1970: 1_788_000_100) })
        let observation = WatchEmergencyObservation(eventId: UUID().uuidString, fallDetectedAt: now,
            fallResolution: .confirmed, appHelpResponse: .needsHelp, patientPosition: nil, locationUnavailableReason: "TEST")
        do { try await reporter.report(observation, sourceBinding: String(repeating: "a", count: 64)); XCTFail("Must reject wrong origin") }
        catch { guard case WatchAPIError.sessionChanged = error else { return XCTFail("Expected source guard") } }
        let requests = await transport.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    private func jsonObject(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func sessionBody(accessToken: String, refreshToken: String, expiresAt: Date) -> String {
        let date = ISO8601DateFormatter().string(from: expiresAt)
        return "{\"sessionId\":\"REDACTED-SUPPLEMENT-ID-4120a0091d45\",\"sessionToken\":\"\(accessToken)\",\"refreshToken\":\"\(refreshToken)\",\"expiresAt\":\"\(date)\",\"scopes\":[\"watch:report\",\"watch:fallback\"],\"userId\":\"watch-user\",\"accountId\":\"watch-account\"}"
    }

    private func positionBody(positionUpdateID: String) -> String {
        let date = ISO8601DateFormatter().string(from: now)
        return "{\"positionUpdateId\":\"\(positionUpdateID)\",\"applied\":true,\"idempotent\":false,\"ignoredAsStale\":false,\"positionObservedAt\":\"\(date)\",\"serverReceivedAt\":\"\(date)\"}"
    }
}

private final class MemoryRelayStore: @unchecked Sendable, WatchRelaySessionPersisting {
    private let lock = NSLock()
    private var value: WatchRelaySession?
    func loadRelaySession() throws -> WatchRelaySession? { lock.withLock { value } }
    func saveRelaySession(_ session: WatchRelaySession) throws { lock.withLock { value = session } }
}

private final class SimulationMemoryState: @unchecked Sendable, WatchSimulationStatePersisting {
    private let lock = NSLock()
    private var data: Data?
    private var intent: Data?
    func load() throws -> WatchSimulationSession? {
        try lock.withLock { try data.map { try JSONDecoder.contractDecoder().decode(WatchSimulationSession.self, from: $0) } }
    }
    func save(_ session: WatchSimulationSession) throws {
        let encoded = try JSONEncoder.contractEncoder().encode(session)
        lock.withLock { data = encoded }
    }
    func loadIntent() throws -> WatchSimulationIntent? {
        try lock.withLock { try intent.map { try JSONDecoder.contractDecoder().decode(WatchSimulationIntent.self, from: $0) } }
    }
    func saveIntent(_ value: WatchSimulationIntent) throws {
        let encoded = try JSONEncoder.contractEncoder().encode(value)
        lock.withLock { intent = encoded }
    }
}

@MainActor
private final class SimulationPositionProvider: WatchPositionSnapshotProviding {
    var hasRequiredAuthorization = true
    var onAuthorizationChange: ((Bool) -> Void)?
    func requestAuthorizationAndLocation() {}
    func snapshot() -> WatchPositionSnapshot { WatchPositionSnapshot(patientPosition: nil, unavailableReason: "synthetic fixture") }
}

private final class SimulationMemoryOutbox: @unchecked Sendable, WatchObservationOutbox {
    private let lock = NSLock()
    private var facts: [String: WatchEmergencyObservation] = [:]
    private var sources: [String: String] = [:]
    private var confirmed = Set<String>()
    func pending(now: Date) throws -> [WatchEmergencyObservation] { lock.withLock { Array(facts.values) } }
    func sourceBinding(eventID: String) throws -> String? { lock.withLock { sources[eventID] } }
    func store(_ observation: WatchEmergencyObservation, sourceBinding: String?) throws {
        lock.withLock { facts[observation.eventId] = observation; sources[observation.eventId] = sourceBinding }
    }
    func acknowledge(eventID: String, at: Date) throws {
        lock.withLock { facts[eventID] = nil; sources[eventID] = nil; _ = confirmed.insert(eventID) }
    }
    func suppress(eventID: String, at: Date) throws { try acknowledge(eventID: eventID, at: at) }
    func confirmedEventIDs() throws -> [String] { lock.withLock { Array(confirmed) } }
    func rejectedStatus(eventID: String) throws -> Int? { nil }
    func retainRejected(eventID: String, status: Int) throws {}
    func pruneDedupeMarkers(now: Date) throws {}
    func hasDedupeMarker(eventID: String, now: Date) throws -> Bool { lock.withLock { confirmed.contains(eventID) } }
}

private actor RelayPhoneDouble: CompanionRPCTransport {
    let pair: String
    var reachable = true
    var wrongACK = false
    var wrongNonce = false
    var observations: [CompanionRelayObservation] = []
    var simulationObservations: [CompanionRelayObservation] = []
    var simulation: WatchSimulationContext?
    var backgroundEnabled = false
    var control: CompanionServiceControl?
    var forcedStatus: CompanionRPCStatus?
    var forcedHTTPStatus: Int?
    var queuedMethods: [CompanionRPCMethod] = []
    init(pair: String) { self.pair = pair }
    func setReachable(_ value: Bool) { reachable = value }
    func setWrongACK(_ value: Bool) { wrongACK = value }
    func setWrongNonce(_ value: Bool) { wrongNonce = value }
    func setBackgroundEnabled(_ value: Bool) { backgroundEnabled = value }
    func setForcedStatus(_ value: CompanionRPCStatus?, httpStatus: Int? = nil) {
        forcedStatus = value
        forcedHTTPStatus = httpStatus
    }
    func setControl(_ value: CompanionServiceControl?) { control = value }
    func setSimulation(_ value: WatchSimulationContext?) { simulation = value }
    func backgroundControl() async -> CompanionServiceControl? { control }
    func supportsBackgroundDelivery() async -> Bool { backgroundEnabled }
    func isReachable() async -> Bool { reachable }
    func request(_ message: CompanionRPCRequest) async throws -> CompanionRPCReply {
        guard reachable else {
            if backgroundEnabled { queuedMethods.append(message.method); throw CompanionRPCError.queued }
            throw CompanionRPCError.unavailable
        }
        if let forcedStatus { return CompanionRPCReply(request: message, status: forcedStatus, httpStatus: forcedHTTPStatus) }
        let reply: CompanionRPCReply
        switch message.method {
        case .context:
            reply = try CompanionRPCReply(request: message,
                body: CompanionRelayContext(baseURL: "https://watch.example.test/api/v2/", companionPairId: pair))
        case .bind:
            let input = try message.decode(CompanionRelayBindRequest.self)
            reply = try CompanionRPCReply(request: message, body: CompanionRelayBinding(
                bindingId: "REDACTED-SUPPLEMENT-ID-371d09f890c4",
                iPhoneDeviceId: "REDACTED-SUPPLEMENT-ID-59e745031639",
                deviceInstanceId: input.deviceInstanceId, companionPairId: pair,
                userId: "watch-user", accountId: "watch-account", expiresAt: Date().addingTimeInterval(3600)))
        case .ping:
            reply = try CompanionRPCReply(request: message, body: message.decode(CompanionRelayReference.self))
        case .simulationContext:
            if let simulation { reply = try CompanionRPCReply(request: message, body: simulation) }
            else { reply = CompanionRPCReply(request: message, status: .serverRejected, httpStatus: 403) }
        case .observation, .simulationObservation:
            let input = try message.decode(CompanionRelayObservation.self)
            if message.method == .simulationObservation { simulationObservations.append(input) }
            else { observations.append(input) }
            let observation = try JSONDecoder.contractDecoder().decode(WatchEmergencyObservation.self, from: input.observationData)
            reply = try CompanionRPCReply(request: message,
                body: CompanionRelayObservationACK(eventId: observation.eventId, digest: wrongACK ? "wrong" : input.digest))
        default:
            reply = CompanionRPCReply(request: message, status: .unavailable)
        }
        if wrongNonce {
            var dictionary = reply.propertyList()
            dictionary["requestId"] = UUID().uuidString
            return CompanionRPCReply(propertyList: dictionary)!
        }
        return reply
    }
}

@MainActor
private final class BackgroundTransportDouble: CompanionRPCTransport {
    let mailbox: CompanionBackgroundMailbox
    var queued: [CompanionRPCRequest] = []
    init(disk: RelayMailboxMemory) { mailbox = CompanionBackgroundMailbox(persistence: disk) }
    func prepareRequest(_ message: CompanionRPCRequest) async throws -> CompanionRPCRequest { try mailbox.prepare(message) }
    func isReachable() async -> Bool { false }
    func supportsBackgroundDelivery() async -> Bool { true }
    func request(_ message: CompanionRPCRequest) async throws -> CompanionRPCReply {
        if let reply = try mailbox.completedReply(for: message) { return reply }
        if !queued.contains(where: { $0.requestID == message.requestID }) { queued.append(message) }
        throw CompanionRPCError.queued
    }
    func deliver(to peer: RelayPhoneDouble) async throws {
        let pending = queued
        queued.removeAll()
        for request in pending { _ = try mailbox.receive(await peer.request(request)) }
    }
}

private final class RelayMailboxMemory: CompanionMailboxPersisting, @unchecked Sendable {
    private let lock = NSLock()
    private var state = CompanionMailboxState()
    func load() throws -> CompanionMailboxState { lock.withLock { state } }
    func save(_ state: CompanionMailboxState) throws { lock.withLock { self.state = state } }
}

private final class MemoryWatchAuthStore: @unchecked Sendable, WatchAuthSessionPersisting {
    private let lock = NSLock()
    private var session: WatchAuthSession?

    init(session: WatchAuthSession? = nil) {
        self.session = session
    }

    func loadAuthSession() -> WatchAuthSession? {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    func saveAuthSession(_ session: WatchAuthSession) throws {
        lock.lock()
        self.session = session
        lock.unlock()
    }

    func clearAuthSession() throws {
        lock.lock()
        session = nil
        lock.unlock()
    }
}

private final class MemoryAppAttestKeyStore: @unchecked Sendable, WatchAppAttestKeyPersisting {
    private let lock = NSLock()
    private var keyID: String?

    func loadAppAttestKeyID() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return keyID
    }

    func saveAppAttestKeyID(_ keyID: String) throws {
        lock.lock()
        self.keyID = keyID
        lock.unlock()
    }

    func clearAppAttestKeyID() throws {
        lock.lock()
        keyID = nil
        lock.unlock()
    }
}

private final class FakeWatchAppAttest: @unchecked Sendable, WatchAppAttestProviding {
    private let lock = NSLock()
    let isSupported: Bool
    var shouldFail = false
    private(set) var generateCount = 0
    private(set) var attestCount = 0
    private(set) var clientDataHashes: [Data] = []

    init(isSupported: Bool = true) {
        self.isSupported = isSupported
    }

    func generateKey() async throws -> String {
        let shouldFail = withLock {
            generateCount += 1
            return self.shouldFail
        }
        if shouldFail { throw WatchAPIError.appAttestFailed }
        return "watch-attest-key"
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        _ = keyID
        let shouldFail = withLock {
            attestCount += 1
            clientDataHashes.append(clientDataHash)
            return self.shouldFail
        }
        if shouldFail { throw WatchAPIError.appAttestFailed }
        return Data("attestation".utf8)
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

private actor RecordingWatchTransport: WatchAPIHTTPTransport {
    struct Response: Sendable {
        let statusCode: Int
        let body: Data

        static func json(statusCode: Int, body: String) -> Response {
            Response(statusCode: statusCode, body: Data(body.utf8))
        }
    }

    private var responses: [Response]
    private var recorded: [URLRequest] = []

    init(responses: [Response]) {
        self.responses = responses
    }

    func requests() -> [URLRequest] { recorded }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        recorded.append(request)
        guard let url = request.url, !responses.isEmpty else {
            throw WatchAPIError.invalidResponse
        }
        let response = responses.removeFirst()
        guard let http = HTTPURLResponse(
            url: url,
            statusCode: response.statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw WatchAPIError.invalidResponse
        }
        return (response.body, http)
    }
}

private func XCTAssertThrowsErrorAsync<T>(
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

private actor DelayedLinkTransport: WatchAPIHTTPTransport {
    let first: String
    let second: String
    let firstStatus: Int
    let secondStatus: Int
    private var count = 0
    private var continuation: CheckedContinuation<Void, Never>?
    init(first: String, second: String, firstStatus: Int = 201, secondStatus: Int = 201) {
        self.first = first; self.second = second; self.firstStatus = firstStatus; self.secondStatus = secondStatus
    }
    func isSuspended() -> Bool { continuation != nil }
    func release() { continuation?.resume(); continuation = nil }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        count += 1
        let index = count
        if index == 1 { await withCheckedContinuation { continuation = $0 } }
        return (Data((index == 1 ? first : second).utf8), HTTPURLResponse(url: request.url!, statusCode: index == 1 ? firstStatus : secondStatus,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
}


@MainActor
final class C4dReviewCacheTests: XCTestCase {
    func testCompletedTicketCannotClaimSuccessAfterItsSessionWasRevoked() async throws {
        let namespace = "aedresponse-c4d-review-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: namespace))
        let keys = WatchKeychainStore(service: namespace)
        defer { try? keys.clearAuthSession(); try? keys.clearAppAttestKeyID(); defaults.removePersistentDomain(forName: namespace) }
        let config = WatchConfigurationStore(defaults: defaults)
        let pair = "REDACTED-SUPPLEMENT-ID-5372a9309212"
        config.applyLinkedConfiguration(baseURL: "https://watch.example.test", companionPairID: pair)
        let now = Date(timeIntervalSince1970: 1_788_000_100)
        let transport = C4dCacheTransport()
        let reporter = WatchAPIReporter(configurationStore: config, transport: transport, authSessionStore: keys,
            appAttestKeyStore: keys, appAttest: C4dCacheAttest(), now: { now })
        let envelope = CompanionLinkEnvelope(baseURL: "https://watch.example.test", companionPairId: pair,
            companionLinkTicket: "ticket-cache-review-abcdefghijklmnopqrstuvwxyz", expiresAt: now.addingTimeInterval(300))
        try await reporter.redeemCompanionLink(envelope)
        let validBefore = await reporter.hasValidWatchSession()
        XCTAssertTrue(validBefore)
        let restored = await reporter.restoreWatchSession(remoteValidation: true)
        XCTAssertFalse(restored)
        XCTAssertNil(keys.loadAuthSession(), "The server's refresh401 has revoked the local session")
        do {
            try await reporter.redeemCompanionLink(envelope)
            XCTFail("An old successful Task is not proof of a currently accepted session")
        } catch { XCTAssertTrue(error is WatchAPIError) }
        let validAfter = await reporter.hasValidWatchSession()
        XCTAssertFalse(validAfter)
    }
}

private struct C4dCacheAttest: WatchAppAttestProviding {
    let isSupported = true
    func generateKey() async throws -> String { "review-app-attest-key" }
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data { Data("attestation".utf8) }
}
private actor C4dCacheTransport: WatchAPIHTTPTransport {
    private var calls = 0
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        calls += 1
        let body = calls == 1 ? "{\"sessionToken\":\"review-access\",\"refreshToken\":\"review-refresh\",\"expiresAt\":\"2026-08-29T11:41:40.000Z\",\"userId\":\"watch-user\",\"accountId\":\"watch-account\"}" : "{}"
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: calls == 1 ? 201 : 401,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
}
