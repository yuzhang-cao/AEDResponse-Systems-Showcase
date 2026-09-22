import Foundation

enum WatchConnectivityActivationState: String, Codable, CaseIterable, Sendable {
    case notActivated = "NOT_ACTIVATED"
    case inactive = "INACTIVE"
    case activated = "ACTIVATED"
}

struct WatchConnectivityState: Equatable, Sendable {
    let activationState: WatchConnectivityActivationState
    let iphoneReachable: Bool
}

/// Product admission is deliberately a policy boundary.  The default policy
/// preserves the current fallback rule; a future server-confirmed policy can
/// be injected without moving authority into the coordinator.
enum WatchFallbackAdmissionDecision: Equatable, Sendable {
    case eligible
    case waitForIPhoneRecovery
    case waitForConnectivity
    case blockedPendingBusinessRule
}

protocol WatchFallbackAdmissionPolicy: Sendable {
    func decision(connectivity: WatchConnectivityState, networkAvailable: Bool,
                  serverAllowsFallback: Bool) -> WatchFallbackAdmissionDecision
    func decision(
        connectivity: WatchConnectivityState,
        networkAvailable: Bool
    ) -> WatchFallbackAdmissionDecision
}

extension WatchFallbackAdmissionPolicy {
    func decision(connectivity: WatchConnectivityState, networkAvailable: Bool,
                  serverAllowsFallback: Bool) -> WatchFallbackAdmissionDecision {
        decision(connectivity: connectivity, networkAvailable: networkAvailable)
    }
}

struct ReachabilityOnlyWatchFallbackAdmissionPolicy: WatchFallbackAdmissionPolicy {
    func decision(connectivity: WatchConnectivityState, networkAvailable: Bool,
                  serverAllowsFallback: Bool) -> WatchFallbackAdmissionDecision {
        if networkAvailable && serverAllowsFallback { return .eligible }
        return decision(connectivity: connectivity, networkAvailable: networkAvailable)
    }

    func decision(
        connectivity: WatchConnectivityState,
        networkAvailable: Bool
    ) -> WatchFallbackAdmissionDecision {
        if connectivity.activationState == .activated && connectivity.iphoneReachable {
            return .waitForIPhoneRecovery
        }
        return networkAvailable ? .eligible : .waitForConnectivity
    }
}

/// The only Watch-to-server fallback payload. The server performs the
/// ten-second source arbitration; the Watch merely reports its observed
/// connectivity and one real location sample.
struct WatchFallbackPositionUpdate: Codable, Equatable, Sendable {
    let schemaVersion: String
    let eventId: String
    let positionUpdateId: String
    let observedAt: Date
    let patientPosition: PatientPosition
    let activationState: WatchConnectivityActivationState
    let iphoneReachable: Bool
    let networkAvailable: Bool

    init(
        eventId: String,
        positionUpdateId: String,
        observedAt: Date,
        patientPosition: PatientPosition,
        activationState: WatchConnectivityActivationState,
        iphoneReachable: Bool,
        networkAvailable: Bool
    ) {
        schemaVersion = "2.0"
        self.eventId = eventId
        self.positionUpdateId = positionUpdateId
        self.observedAt = observedAt
        self.patientPosition = patientPosition
        self.activationState = activationState
        self.iphoneReachable = iphoneReachable
        self.networkAvailable = networkAvailable
    }
}

struct WatchFallbackPositionSample: Equatable, Sendable {
    let patientPosition: PatientPosition
    let observedAt: Date
    /// Local receipt time used only to reject a future OS timestamp. It is
    /// never sent as the position observation time.
    let receivedAt: Date

    init(
        patientPosition: PatientPosition,
        observedAt: Date,
        receivedAt: Date = Date()
    ) {
        self.patientPosition = patientPosition
        self.observedAt = observedAt
        self.receivedAt = receivedAt
    }
}

struct WatchEventStateSnapshot: Codable, Equatable, Sendable {
    let eventId: String
    let state: EventState
    let createdAt: Date
    let resolvedAt: Date?
    var fallbackAllowed: Bool? = nil

    var isValid: Bool {
        !eventId.isEmpty && createdAt.timeIntervalSince1970.isFinite
            && (resolvedAt.map { $0.timeIntervalSince1970.isFinite && $0 >= createdAt } ?? true)
            && (state != .active || resolvedAt == nil)
    }

    func containsHistoricalSample(_ time: Date) -> Bool {
        guard isValid, state.isTerminal, let resolvedAt else { return false }
        return time >= createdAt && time < resolvedAt
    }
}

struct QuarantinedWatchFallbackFact: Codable, Equatable, Sendable {
    enum Reason: String, Codable, Sendable { case outsideActiveWindow, serverRejectedContent }
    let update: WatchFallbackPositionUpdate
    let reason: Reason
    let serverWindow: WatchEventStateSnapshot?
    let statusCode: Int?
}

struct PersistedWatchFallbackEvent: Codable, Equatable, Sendable {
    let eventID: String
    let startedAt: Date
}

@MainActor
protocol WatchConnectivityMonitoring: AnyObject, Sendable {
    var state: WatchConnectivityState { get }
    var onStateChange: ((WatchConnectivityState) -> Void)? { get set }
    var onCompanionLinkEnvelope: ((CompanionLinkEnvelope) -> Void)? { get set }
    func activate()
}

@MainActor
protocol WatchNetworkMonitoring: AnyObject, Sendable {
    var isNetworkAvailable: Bool { get }
    var onStateChange: ((Bool) -> Void)? { get set }
    func start()
    func stop()
}

@MainActor
protocol WatchFallbackPositionProviding: AnyObject, Sendable {
    var onSignificantPositionChange: ((WatchFallbackPositionSample) -> Void)? { get set }
    func startFallbackUpdates()
    func stopFallbackUpdates()
    func fallbackSnapshot() -> WatchFallbackPositionSample?
}

protocol WatchFallbackReporting: Sendable {
    func authorizationRevision() async -> Int
    func observationSourceBinding() async -> String?
    func fetchEventState(eventID: String) async throws -> WatchEventStateSnapshot
    func reportFallbackPosition(
        _ update: WatchFallbackPositionUpdate,
        expectedSourceBinding: String?
    ) async throws -> PositionUpdateResult
}

protocol WatchFallbackStatePersisting: Sendable {
    func activeEvent() -> PersistedWatchFallbackEvent?
    func setActiveEvent(_ event: PersistedWatchFallbackEvent?)
}

protocol WatchFallbackOutbox: Sendable {
    func pending(now: Date) throws -> [WatchFallbackPositionUpdate]
    func sourceBinding(positionUpdateID: String) throws -> String?
    func store(_ update: WatchFallbackPositionUpdate, sourceBinding: String?) throws
    func acknowledge(positionUpdateID: String) throws
    func discardExpired(now: Date) throws -> [String]
    func sealedState(eventID: String) throws -> WatchEventStateSnapshot?
    func seal(_ state: WatchEventStateSnapshot) throws
    func quarantine(_ update: WatchFallbackPositionUpdate, reason: QuarantinedWatchFallbackFact.Reason,
        serverWindow: WatchEventStateSnapshot?, statusCode: Int?) throws
}

extension WatchFallbackOutbox {
    /// Legacy callers may re-open an older queue whose source metadata is
    /// absent. New samples must pass an explicit binding through the overload.
    func store(_ update: WatchFallbackPositionUpdate) throws {
        try store(update, sourceBinding: nil)
    }
}

enum WatchFallbackCoordinatorResult: Equatable, Sendable {
    case noActiveEvent
    case waitingForConnectivity
    case waitingForPosition
    case positionReported(positionUpdateID: String)
    case positionQueued(positionUpdateID: String)
    case persistenceFailed(positionUpdateID: String)
    case stoppedForIPhoneRecovery
    case eventEnded(eventID: String)
    case waitingForServerState
    case blockedPendingBusinessRule
    case stateRecovered
    case authorizationRequired
    case historyReported(positionUpdateID: String)
    case evidenceIsolated(positionUpdateID: String)
}

/// Direct Watch fallback. It never sends a separate connectivity report or
/// waits for a server-issued client grant. Admission is delegated to the
/// policy; the default remains ACTIVATED+reachable iPhone suppression plus
/// Watch WAN availability.
actor WatchFallbackCoordinator {
    static let uploadIntervalSeconds: TimeInterval = 5
    static let movementEarlyDistanceMeters: Double = 10

    private let stateStore: any WatchFallbackStatePersisting
    private let outbox: any WatchFallbackOutbox
    private let reporter: any WatchFallbackReporting
    private let positionProvider: any WatchFallbackPositionProviding
    private let admissionPolicy: any WatchFallbackAdmissionPolicy
    private let makeID: @Sendable () -> String
    private let now: @Sendable () -> Date

    private var activeEvent: PersistedWatchFallbackEvent?
    private var latestConnectivity = WatchConnectivityState(
        activationState: .notActivated,
        iphoneReachable: false
    )
    private var latestNetworkAvailable = false
    private var lastCollectedSample: WatchFallbackPositionSample?
    private var activeGeneration = 0
    private var recoveredState: WatchEventStateSnapshot?
    private struct EventStateRecoveryProof: Sendable {
        let snapshot: WatchEventStateSnapshot
        let sourceBinding: String?
        let authorizationRevision: Int
    }
    private var recoveryProofs: [String: EventStateRecoveryProof] = [:]
    private var recoveryInFlight = false
    private var authorizationBlocked: [String: Int] = [:]
    private var samplingBlockedAuthorizationRevision: Int?
    private var samplingBlockedByContent: [String: (revision: Int, recordID: String)] = [:]
    private var retryPlans: [String: (attempts: Int, notBefore: Date)] = [:]

    init(
        stateStore: any WatchFallbackStatePersisting,
        outbox: any WatchFallbackOutbox,
        reporter: any WatchFallbackReporting,
        positionProvider: any WatchFallbackPositionProviding,
        admissionPolicy: any WatchFallbackAdmissionPolicy = ReachabilityOnlyWatchFallbackAdmissionPolicy(),
        makeID: @escaping @Sendable () -> String = { UUID().uuidString },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.stateStore = stateStore
        self.outbox = outbox
        self.reporter = reporter
        self.positionProvider = positionProvider
        self.admissionPolicy = admissionPolicy
        self.makeID = makeID
        self.now = now
        activeEvent = stateStore.activeEvent()
    }

    func activate(
        eventID: String,
        fallDetectedAt: Date,
        connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        observedAt: Date
    ) async -> WatchFallbackCoordinatorResult {
        if activeEvent?.eventID != eventID {
            activeEvent = PersistedWatchFallbackEvent(
                eventID: eventID,
                startedAt: fallDetectedAt
            )
            stateStore.setActiveEvent(activeEvent)
            lastCollectedSample = nil
            activeGeneration += 1
        }
        return await reconcile(
            connectivity: connectivity,
            networkAvailable: networkAvailable,
            observedAt: observedAt,
            preferredPosition: nil,
            expectedGeneration: activeGeneration
        )
    }

    func resume(
        connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        observedAt: Date
    ) async -> WatchFallbackCoordinatorResult {
        return await reconcile(
            connectivity: connectivity,
            networkAvailable: networkAvailable,
            observedAt: observedAt,
            preferredPosition: nil,
            expectedGeneration: activeGeneration
        )
    }

    func connectivityDidChange(
        _ connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        observedAt: Date
    ) async -> WatchFallbackCoordinatorResult {
        return await reconcile(
            connectivity: connectivity,
            networkAvailable: networkAvailable,
            observedAt: observedAt,
            preferredPosition: nil,
            expectedGeneration: activeGeneration
        )
    }

    func networkDidChange(
        _ networkAvailable: Bool,
        connectivity: WatchConnectivityState,
        observedAt: Date
    ) async -> WatchFallbackCoordinatorResult {
        await connectivityDidChange(
            connectivity,
            networkAvailable: networkAvailable,
            observedAt: observedAt
        )
    }

    func periodicReport(
        connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        observedAt: Date
    ) async -> WatchFallbackCoordinatorResult {
        return await reconcile(
            connectivity: connectivity,
            networkAvailable: networkAvailable,
            observedAt: observedAt,
            preferredPosition: nil,
            expectedGeneration: activeGeneration
        )
    }

    func significantPositionDidChange(
        _ sample: WatchFallbackPositionSample,
        connectivity: WatchConnectivityState,
        networkAvailable: Bool
    ) async -> WatchFallbackCoordinatorResult {
        return await reconcile(connectivity: connectivity, networkAvailable: networkAvailable,
            observedAt: sample.observedAt, preferredPosition: sample, expectedGeneration: activeGeneration)
    }

    /// Restores authority and old evidence even when the sampling permission gate is closed.
    func recoverEventState(networkAvailable: Bool, observedAt: Date, confirmedEventIDs: [String] = []) async -> WatchFallbackCoordinatorResult {
        return await recoverKnownEvents(networkAvailable: networkAvailable, at: observedAt, confirmedEventIDs: confirmedEventIDs) ?? .stateRecovered
    }

    func stop() async {
        activeGeneration += 1
        await positionProvider.stopFallbackUpdates()
    }

    func clearActiveEvent() async {
        // Clear only the acquisition context. Unconfirmed facts belong to the outbox.
        activeEvent = nil
        stateStore.setActiveEvent(nil)
        activeGeneration += 1
        lastCollectedSample = nil
        await positionProvider.stopFallbackUpdates()
    }

    func currentActiveEventID() -> String? {
        activeEvent?.eventID
    }

    private func recoverKnownEvents(networkAvailable: Bool, at date: Date, drainHistory: Bool = true, confirmedEventIDs: [String] = []) async -> WatchFallbackCoordinatorResult? {
        guard networkAvailable else { return activeEvent == nil ? .noActiveEvent : .waitingForConnectivity }
        guard !recoveryInFlight else { return .waitingForServerState }
        recoveryInFlight = true
        defer { recoveryInFlight = false }
        let pending: [WatchFallbackPositionUpdate]
        do { pending = try outbox.pending(now: date) }
        catch { return .persistenceFailed(positionUpdateID: "outbox") }
        var eventIDs = activeEvent.map { [$0.eventID] } ?? []
        if drainHistory {
            for update in pending where !eventIDs.contains(update.eventId) { eventIDs.append(update.eventId) }
            for id in confirmedEventIDs where !eventIDs.contains(id) { eventIDs.append(id) }
        }
        guard !eventIDs.isEmpty else { return .noActiveEvent }
        var activeCandidates: [WatchEventStateSnapshot] = []
        var terminalResult: WatchFallbackCoordinatorResult?
        for eventID in eventIDs {
            let generation = activeGeneration
            let authRevision = await reporter.authorizationRevision()
            let sourceAtRead = await reporter.observationSourceBinding()
            let snapshot: WatchEventStateSnapshot
            do {
                snapshot = try await reporter.fetchEventState(eventID: eventID)
                guard snapshot.eventId == eventID, snapshot.isValid else { throw WatchAPIError.invalidResponse }
                let currentRevision = await reporter.authorizationRevision()
                let currentSource = await reporter.observationSourceBinding()
                guard generation == activeGeneration, authRevision == currentRevision,
                      sourceAtRead == currentSource else { return .waitingForServerState }
            } catch {
                if activeEvent?.eventID == eventID {
                    return Self.isAuthorizationFailure(error) ? .authorizationRequired : .waitingForServerState
                }
                // An inaccessible old event cannot consume another event's pending records.
                continue
            }
            recoveryProofs[eventID] = EventStateRecoveryProof(
                snapshot: snapshot,
                sourceBinding: sourceAtRead,
                authorizationRevision: authRevision
            )
            if snapshot.state == .active {
                do {
                    guard try outbox.sealedState(eventID: eventID) == nil else { return .waitingForServerState }
                } catch { return .persistenceFailed(positionUpdateID: "outbox") }
                if activeEvent?.eventID == eventID { recoveredState = snapshot }
                else { activeCandidates.append(snapshot) }
                continue
            }
            let wasCurrent = activeEvent?.eventID == eventID
            if wasCurrent {
                recoveredState = snapshot
                activeGeneration += 1
                await positionProvider.stopFallbackUpdates()
            }
            do { try outbox.seal(snapshot) }
            catch { return .persistenceFailed(positionUpdateID: "outbox") }
            if activeEvent?.eventID == eventID {
                activeEvent = nil
                stateStore.setActiveEvent(nil)
                lastCollectedSample = nil
            }
            if wasCurrent { terminalResult = .eventEnded(eventID: eventID) }
            // A terminal state with no trustworthy end timestamp still stops capture, but never erases history.
            guard snapshot.resolvedAt != nil, drainHistory else { continue }
            for update in pending.filter({ $0.eventId == eventID }).sorted(by: { $0.observedAt < $1.observedAt }) {
                if !snapshot.containsHistoricalSample(update.observedAt) {
                    do { try outbox.quarantine(update, reason: .outsideActiveWindow, serverWindow: snapshot, statusCode: nil) }
                    catch { return .persistenceFailed(positionUpdateID: update.positionUpdateId) }
                    terminalResult = .evidenceIsolated(positionUpdateID: update.positionUpdateId)
                    continue
                }
                return await upload(
                    update,
                    at: date,
                    expectedGeneration: nil,
                    historical: true,
                    window: snapshot,
                    proof: recoveryProofs[eventID]
                )
            }
        }
        // Recover a lost local pointer only when the authorized backend identifies a single active event.
        // Choosing between multiple active Falls remains an unresolved business rule.
        if activeEvent == nil, activeCandidates.count == 1, let candidate = activeCandidates.first {
            activeEvent = PersistedWatchFallbackEvent(eventID: candidate.eventId, startedAt: candidate.createdAt)
            stateStore.setActiveEvent(activeEvent)
            activeGeneration += 1
            recoveredState = candidate
            lastCollectedSample = nil
        }
        return terminalResult ?? (activeEvent == nil ? .noActiveEvent : nil)
    }

    private func upload(
        _ update: WatchFallbackPositionUpdate,
        at date: Date,
        expectedGeneration: Int?,
        historical: Bool,
        window: WatchEventStateSnapshot?,
        proof: EventStateRecoveryProof? = nil
    ) async -> WatchFallbackCoordinatorResult {
        let revision = await reporter.authorizationRevision()
        if let expectedGeneration, expectedGeneration != activeGeneration { return .waitingForServerState }
        if authorizationBlocked[update.positionUpdateId] == revision { return .authorizationRequired }
        if let retry = retryPlans[update.positionUpdateId], date < retry.notBefore {
            return .positionQueued(positionUpdateID: update.positionUpdateId)
        }
        let storedBinding: String?
        do {
            storedBinding = try outbox.sourceBinding(positionUpdateID: update.positionUpdateId)
        } catch {
            return .persistenceFailed(positionUpdateID: update.positionUpdateId)
        }
        guard let sourceAtStart = await reporter.observationSourceBinding() else {
            await positionProvider.stopFallbackUpdates()
            return .authorizationRequired
        }
        if let storedBinding {
            guard storedBinding == sourceAtStart else {
                await positionProvider.stopFallbackUpdates()
                return .authorizationRequired
            }
        } else {
            // A legacy record without a local source may only be replayed after
            // this session has proved the event exists and is accessible.
            guard let proof,
                  proof.snapshot.eventId == update.eventId,
                  proof.snapshot.isValid,
                  proof.authorizationRevision == revision,
                  proof.sourceBinding == sourceAtStart else {
                await positionProvider.stopFallbackUpdates()
                return .authorizationRequired
            }
        }
        if let proof {
            guard proof.authorizationRevision == revision,
                  proof.sourceBinding == sourceAtStart else {
                await positionProvider.stopFallbackUpdates()
                return .authorizationRequired
            }
        }
        do {
            let result = try await reporter.reportFallbackPosition(
                update,
                expectedSourceBinding: sourceAtStart
            )
            guard result.positionUpdateId == update.positionUpdateId else {
                return .persistenceFailed(positionUpdateID: update.positionUpdateId)
            }
            let currentRevision = await reporter.authorizationRevision()
            if let expectedGeneration, expectedGeneration != activeGeneration {
                return .waitingForServerState
            }
            guard revision == currentRevision else { return .authorizationRequired }
            guard await reporter.observationSourceBinding() == sourceAtStart else {
                await positionProvider.stopFallbackUpdates()
                return .authorizationRequired
            }
            if let expectedGeneration, expectedGeneration != activeGeneration {
                return .waitingForServerState
            }
            try outbox.acknowledge(positionUpdateID: update.positionUpdateId)
            authorizationBlocked.removeValue(forKey: update.positionUpdateId)
            retryPlans.removeValue(forKey: update.positionUpdateId)
            return historical ? .historyReported(positionUpdateID: update.positionUpdateId)
                : .positionReported(positionUpdateID: update.positionUpdateId)
        } catch {
            let currentRevision = await reporter.authorizationRevision()
            if let expectedGeneration, expectedGeneration != activeGeneration { return .waitingForServerState }
            guard revision == currentRevision else { return .authorizationRequired }
            if case WatchAPIError.fallbackAdmissionChanged = error {
                recoveredState = nil
                await positionProvider.stopFallbackUpdates()
                return .waitingForServerState
            }
            if Self.isAuthorizationFailure(error) {
                authorizationBlocked[update.positionUpdateId] = revision
                samplingBlockedAuthorizationRevision = revision
                await positionProvider.stopFallbackUpdates()
                return .authorizationRequired
            }
            if case let WatchAPIError.rejected(status) = error, [400, 409, 422].contains(status) {
                do { try outbox.quarantine(update, reason: .serverRejectedContent, serverWindow: window, statusCode: status) }
                catch { return .persistenceFailed(positionUpdateID: update.positionUpdateId) }
                if !historical {
                    samplingBlockedByContent[update.eventId] = (revision, update.positionUpdateId)
                    await positionProvider.stopFallbackUpdates()
                }
                return .evidenceIsolated(positionUpdateID: update.positionUpdateId)
            }
            if case WatchAPIError.persistenceFailed = error {
                return .persistenceFailed(positionUpdateID: update.positionUpdateId)
            }
            let attempts = (retryPlans[update.positionUpdateId]?.attempts ?? 0) + 1
            let delay = min(60, pow(2, Double(min(attempts - 1, 6))))
            retryPlans[update.positionUpdateId] = (attempts, date.addingTimeInterval(delay))
            return .positionQueued(positionUpdateID: update.positionUpdateId)
        }
    }

    private static func isAuthorizationFailure(_ error: Error) -> Bool {
        if case let WatchAPIError.rejected(status) = error { return [401, 403].contains(status) }
        if case WatchAPIError.notLinked = error { return true }
        if case WatchAPIError.sessionChanged = error { return true }
        return false
    }

    private func reconcile(
        connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        observedAt: Date,
        preferredPosition: WatchFallbackPositionSample?,
        expectedGeneration: Int
    ) async -> WatchFallbackCoordinatorResult {
        guard expectedGeneration == activeGeneration else { return .waitingForServerState }
        if latestConnectivity != connectivity || latestNetworkAvailable != networkAvailable {
            activeGeneration += 1
        }
        let generation = activeGeneration
        latestConnectivity = connectivity
        latestNetworkAvailable = networkAvailable
        var admission = admissionPolicy.decision(
            connectivity: connectivity, networkAvailable: networkAvailable,
            serverAllowsFallback: recoveredState?.fallbackAllowed == true
        )
        let eligible = admission == .eligible
        if !eligible { await positionProvider.stopFallbackUpdates() }
        guard generation == activeGeneration else { return .waitingForServerState }
        // An existing query owns its eventual result. A duplicate opportunity must not
        // stop a valid sampler, and a changed input has already invalidated the old query.
        if recoveryInFlight {
            return eligible ? .waitingForServerState : Self.result(for: admission)
        }
        if let recovery = await recoverKnownEvents(networkAvailable: networkAvailable, at: observedAt,
            drainHistory: preferredPosition == nil && activeEvent == nil) {
            if generation == activeGeneration, eligible { await positionProvider.stopFallbackUpdates() }
            return recovery
        }
        guard let activeEvent, generation == activeGeneration,
              recoveredState?.eventId == activeEvent.eventID, recoveredState?.state == .active
        else { return .waitingForServerState }

        admission = admissionPolicy.decision(connectivity: connectivity, networkAvailable: networkAvailable,
            serverAllowsFallback: recoveredState?.fallbackAllowed == true)
        guard admission == .eligible else {
            if eligible { await positionProvider.stopFallbackUpdates() }
            return Self.result(for: admission)
        }

        let revision = await reporter.authorizationRevision()
        guard generation == activeGeneration else { return .waitingForServerState }
        if samplingBlockedAuthorizationRevision == revision {
            await positionProvider.stopFallbackUpdates()
            return .authorizationRequired
        }
        let pending: [WatchFallbackPositionUpdate]
        do {
            pending = try outbox.pending(now: observedAt)
        } catch {
            await positionProvider.stopFallbackUpdates()
            return .persistenceFailed(positionUpdateID: "outbox")
        }
        let contentBlock = samplingBlockedByContent[activeEvent.eventID]
        let mayCollect = contentBlock?.revision != revision
        if mayCollect { await positionProvider.startFallbackUpdates() }
        if let preferredPosition, mayCollect {
            guard shouldSend(sample: preferredPosition) else { return .waitingForPosition }
            return await send(sample: preferredPosition, connectivity: connectivity, networkAvailable: networkAvailable,
                expectedGeneration: generation, expectedAuthorizationRevision: revision, attemptedAt: observedAt)
        }
        if let pending = pending
            .filter({ $0.eventId == activeEvent.eventID })
            .sorted(by: { $0.observedAt < $1.observedAt })
            .first {
            return await send(
                update: pending,
                expectedGeneration: generation,
                connectivity: connectivity,
                networkAvailable: networkAvailable,
                attemptedAt: observedAt,
                existingStateProof: recoveryProofs[pending.eventId]
            )
        }

        if !mayCollect, let contentBlock {
            return .evidenceIsolated(positionUpdateID: contentBlock.recordID)
        }
        let sample: WatchFallbackPositionSample?
        if let preferredPosition {
            sample = preferredPosition
        } else {
            sample = await positionProvider.fallbackSnapshot()
        }
        guard let sample else { return .waitingForPosition }
        guard shouldSend(sample: sample) else { return .waitingForPosition }
        return await send(
            sample: sample,
            connectivity: connectivity,
            networkAvailable: networkAvailable,
            expectedGeneration: generation,
            expectedAuthorizationRevision: revision,
            attemptedAt: observedAt
        )
    }

    private func send(
        sample: WatchFallbackPositionSample,
        connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        expectedGeneration: Int,
        expectedAuthorizationRevision: Int,
        attemptedAt: Date
    ) async -> WatchFallbackCoordinatorResult {
        guard expectedGeneration == activeGeneration, let activeEvent else { return .noActiveEvent }
        guard await reporter.authorizationRevision() == expectedAuthorizationRevision else {
            await positionProvider.stopFallbackUpdates()
            return .authorizationRequired
        }
        guard let sourceBinding = await reporter.observationSourceBinding() else {
            await positionProvider.stopFallbackUpdates()
            return .authorizationRequired
        }
        let finalAuthorizationRevision = await reporter.authorizationRevision()
        guard expectedGeneration == activeGeneration,
              finalAuthorizationRevision == expectedAuthorizationRevision else {
            await positionProvider.stopFallbackUpdates()
            return .waitingForServerState
        }
        // Actor re-entry during authorization checks may have collected a
        // newer sample. Reserve only fresh facts before the next suspension.
        guard shouldSend(sample: sample) else { return .waitingForPosition }
        let candidate = WatchFallbackPositionUpdate(
            eventId: activeEvent.eventID,
            positionUpdateId: makeID(),
            observedAt: sample.observedAt,
            patientPosition: sample.patientPosition,
            activationState: connectivity.activationState,
            iphoneReachable: connectivity.iphoneReachable,
            networkAvailable: networkAvailable
        )
        let update: WatchFallbackPositionUpdate
        do {
            update = try JSONDecoder.contractDecoder().decode(WatchFallbackPositionUpdate.self,
                from: JSONEncoder.contractEncoder().encode(candidate))
            try outbox.store(update, sourceBinding: sourceBinding)
            lastCollectedSample = sample
        } catch {
            return .persistenceFailed(positionUpdateID: candidate.positionUpdateId)
        }
        return await send(
            update: update,
            expectedGeneration: expectedGeneration,
            connectivity: connectivity,
            networkAvailable: networkAvailable,
            attemptedAt: attemptedAt
        )
    }

    private func send(
        update: WatchFallbackPositionUpdate,
        expectedGeneration: Int,
        connectivity: WatchConnectivityState,
        networkAvailable: Bool,
        attemptedAt: Date,
        existingStateProof: EventStateRecoveryProof? = nil
    ) async -> WatchFallbackCoordinatorResult {
        guard let activeEvent,
              activeEvent.eventID == update.eventId,
              expectedGeneration == activeGeneration,
              admissionPolicy.decision(
                  connectivity: connectivity,
                  networkAvailable: networkAvailable,
                serverAllowsFallback: recoveredState?.fallbackAllowed == true
              ) == .eligible
        else {
            // A context/connectivity change never discards unconfirmed evidence.
            return Self.result(for: admissionPolicy.decision(
                connectivity: connectivity,
                networkAvailable: networkAvailable,
                serverAllowsFallback: recoveredState?.fallbackAllowed == true
            ))
        }

        return await upload(update, at: attemptedAt, expectedGeneration: expectedGeneration, historical: false,
            window: existingStateProof?.snapshot,
            proof: existingStateProof)
    }

    private func shouldSend(sample: WatchFallbackPositionSample) -> Bool {
        // Fresh collection must advance the sensor clock. Historical outbox
        // records use the retry path and do not change this sampling cursor.
        guard LocationFixValidity.isValid(
            latitude: sample.patientPosition.latitude,
            longitude: sample.patientPosition.longitude,
            accuracyMeters: sample.patientPosition.accuracyMeters,
            observedAt: sample.observedAt,
            now: sample.receivedAt
        ) else { return false }
        guard let previous = lastCollectedSample else { return true }
        guard sample.observedAt > previous.observedAt else { return false }
        if sample.observedAt.timeIntervalSince(previous.observedAt) >= Self.uploadIntervalSeconds {
            return true
        }
        return Self.distanceMeters(from: previous.patientPosition, to: sample.patientPosition)
            >= Self.movementEarlyDistanceMeters
    }

    private static func result(for decision: WatchFallbackAdmissionDecision) -> WatchFallbackCoordinatorResult {
        switch decision {
        case .eligible:
            return .waitingForServerState
        case .waitForIPhoneRecovery:
            return .stoppedForIPhoneRecovery
        case .waitForConnectivity:
            return .waitingForConnectivity
        case .blockedPendingBusinessRule:
            return .blockedPendingBusinessRule
        }
    }

    private static func distanceMeters(
        from first: PatientPosition,
        to second: PatientPosition
    ) -> Double {
        let earthRadius = 6_371_008.8
        let latitude1 = first.latitude * .pi / 180
        let latitude2 = second.latitude * .pi / 180
        let deltaLatitude = (second.latitude - first.latitude) * .pi / 180
        let deltaLongitude = (second.longitude - first.longitude) * .pi / 180
        let haversine = sin(deltaLatitude / 2) * sin(deltaLatitude / 2)
            + cos(latitude1) * cos(latitude2)
            * sin(deltaLongitude / 2) * sin(deltaLongitude / 2)
        return earthRadius * 2 * atan2(sqrt(haversine), sqrt(max(0, 1 - haversine)))
    }
}
