import Foundation

/// A Core Motion Fall Detection callback. `resolution` is Apple's independent
/// system field; it is never treated as the user's answer to the AEDResponse
/// help question.
struct FallDetectionSignal: Equatable, Sendable {
    let detectedAt: Date
    let resolution: FallResolution
}

/// CallKit exposes only that a new outgoing call state was observed. Deliberate
/// omission of number/connection/duration fields prevents the client from
/// inferring facts that the platform does not provide.
struct OutgoingCallSignal: Equatable, Sendable {
    let callID: String
    let firstObservedAt: Date
    let isOutgoing: Bool
}

enum FallDetectionAuthorizationState: String, Sendable {
    case unavailable
    case notDetermined
    case restricted
    case denied
    case authorized
}

@MainActor
protocol FallDetectionMonitoring: AnyObject {
    var authorizationState: FallDetectionAuthorizationState { get }
    var onAuthorizationChange: ((FallDetectionAuthorizationState) -> Void)? { get set }
    var onFall: ((FallDetectionSignal, @escaping () -> Void) -> Void)? { get set }
    func start()
    func stop()
    func requestAuthorization() async -> FallDetectionAuthorizationState
}

@MainActor
protocol OutgoingCallMonitoring: AnyObject {
    var onOutgoingCall: ((OutgoingCallSignal) -> Void)? { get set }
    func start()
    func stop()
}

struct WatchPositionSnapshot: Equatable, Sendable {
    let patientPosition: PatientPosition?
    let unavailableReason: String?
    let observedAt: Date?

    init(patientPosition: PatientPosition?, unavailableReason: String?, observedAt: Date? = nil) {
        self.patientPosition = patientPosition
        self.unavailableReason = unavailableReason
        self.observedAt = observedAt
    }
}

@MainActor
protocol WatchPositionSnapshotProviding: AnyObject, Sendable {
    var hasRequiredAuthorization: Bool { get }
    var onAuthorizationChange: ((Bool) -> Void)? { get set }
    func requestAuthorizationAndLocation()
    func snapshot() -> WatchPositionSnapshot
}

/// Only the minimum Fall context is persisted before the user answers. No
/// sensor sample, health data, coordinate, call metadata, or continuous track
/// belongs in this record.
struct PersistedFallContext: Codable, Equatable, Sendable {
    let eventID: String
    let fallDetectedAt: Date
    let fallResolution: FallResolution
    /// Non-secret identity fingerprint; no token or raw account identifier is
    /// placed in the minimal pre-answer UserDefaults context.
    let sourceBinding: String?
    var hasValidSourceBinding: Bool { sourceBinding.map(WatchObservationSource.isValid) ?? true }

    init(eventID: String, fallDetectedAt: Date, fallResolution: FallResolution, sourceBinding: String? = nil) {
        self.eventID = eventID
        self.fallDetectedAt = fallDetectedAt
        self.fallResolution = fallResolution
        self.sourceBinding = sourceBinding
    }
}

enum WatchObservationSource {
    static func isValid(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

protocol FallEventStatePersisting: Sendable {
    func eventID(for fallDetectedAt: Date) throws -> String
    func wasReported(fallDetectedAt: Date) throws -> Bool
    func markReported(fallDetectedAt: Date) throws
    func pendingContexts(now: Date) throws -> [PersistedFallContext]
    func storePendingContext(_ context: PersistedFallContext) throws
    func clearPending(eventID: String) throws
}

extension FallEventStatePersisting {
    func pendingContexts(now: Date) throws -> [PersistedFallContext] {
        _ = now
        return []
    }

    func storePendingContext(_ context: PersistedFallContext) throws {
        _ = context
    }

    func clearPending(eventID: String) throws {
        _ = eventID
    }
}

/// Pending trigger payloads and 24-hour event markers must be protected at
/// rest. Production uses Keychain; test doubles may keep state in memory.
protocol WatchObservationOutbox: Sendable {
    func pending(now: Date) throws -> [WatchEmergencyObservation]
    func sourceBinding(eventID: String) throws -> String?
    func store(_ observation: WatchEmergencyObservation, sourceBinding: String?) throws
    func acknowledge(eventID: String, at: Date) throws
    func suppress(eventID: String, at: Date) throws
    func confirmedEventIDs() throws -> [String]
    func rejectedStatus(eventID: String) throws -> Int?
    func retainRejected(eventID: String, status: Int) throws
    func pruneDedupeMarkers(now: Date) throws
    func hasDedupeMarker(eventID: String, now: Date) throws -> Bool
}

protocol WatchObservationReporting: Sendable {
    func authorizationRevision() async -> Int
    func observationSourceBinding() async -> String?
    func fetchEventState(eventID: String) async throws -> WatchEventStateSnapshot
    func report(_ observation: WatchEmergencyObservation, sourceBinding: String) async throws
}

enum WatchHelpResponse: String, Codable, Sendable {
    case needsHelp = "NEEDS_HELP"
    case declined = "DECLINED"
}

enum WatchCoordinatorResult: Equatable, Sendable {
    case helpQuestion(eventID: String)
    case waitingForHelp(eventID: String)
    case ignored
    case declined(eventID: String)
    case reported(eventID: String, fallDetectedAt: Date)
    case queuedForRetry(eventID: String, fallDetectedAt: Date)
    case expired(eventID: String)
    case authorizationRequired(eventID: String)
    case requiresReview(eventID: String, status: Int)
    case persistenceFailed(eventID: String)
}

/// Joins one persisted Fall context with either the one-time in-app answer or
/// a newly observed outgoing-call state. The association boundary is exactly
/// 120 seconds, inclusive, and no call outcome is inferred.
actor FallEmergencyCoordinator {
    static let helpQuestionWindow: TimeInterval = 120
    static let defaultMaximumAssociationInterval = helpQuestionWindow
    static let triggerRetryWindow: TimeInterval = 35 * 60
    static let dedupeMarkerRetention: TimeInterval = 24 * 60 * 60

    private let eventState: any FallEventStatePersisting
    private let outbox: any WatchObservationOutbox
    private let reporter: any WatchObservationReporting
    private let positionProvider: any WatchPositionSnapshotProviding
    private let now: @Sendable () -> Date

    private var inFlight: Set<String> = []
    private var authorizationBlocked: [String: Int] = [:]
    private var retryPlans: [String: (attempts: Int, notBefore: Date)] = [:]
    private var pendingFalls: [String: PersistedFallContext]
    private var eventStatePersistenceBlocked = false
    private var outgoingCallsByID: [String: OutgoingCallSignal] = [:]
    private var seenOutgoingCallIDs: [String: Date] = [:]

    init(
        eventState: any FallEventStatePersisting,
        outbox: any WatchObservationOutbox,
        reporter: any WatchObservationReporting,
        positionProvider: any WatchPositionSnapshotProviding,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.eventState = eventState
        self.outbox = outbox
        self.reporter = reporter
        self.positionProvider = positionProvider
        self.now = now
        let current = now()
        do {
            pendingFalls = Dictionary(
                uniqueKeysWithValues: try eventState
                    .pendingContexts(now: current)
                    .filter {
                        current.timeIntervalSince($0.fallDetectedAt) >= 0
                            && current.timeIntervalSince($0.fallDetectedAt) <= Self.helpQuestionWindow
                    }
                    .map { ($0.eventID, $0) }
            )
        } catch {
            pendingFalls = [:]
            eventStatePersistenceBlocked = true
        }
    }

    func receive(fall: FallDetectionSignal) async -> WatchCoordinatorResult {
        guard !eventStatePersistenceBlocked else { return .persistenceFailed(eventID: "event-state") }
        let sourceBinding = await reporter.observationSourceBinding()
        await expirePending(at: now())
        let eventID: String
        let alreadyReported: Bool
        do {
            eventID = try eventState.eventID(for: fall.detectedAt)
            alreadyReported = try eventState.wasReported(fallDetectedAt: fall.detectedAt)
        } catch {
            eventStatePersistenceBlocked = true
            return .persistenceFailed(eventID: "event-state")
        }
        guard !alreadyReported else {
            return .ignored
        }
        let hasMarker: Bool
        do {
            hasMarker = try outbox.hasDedupeMarker(eventID: eventID, now: now())
        } catch {
            return .persistenceFailed(eventID: eventID)
        }
        guard !hasMarker else { return .ignored }
        if pendingFalls[eventID] != nil {
            return .waitingForHelp(eventID: eventID)
        }

        let context = PersistedFallContext(
            eventID: eventID,
            fallDetectedAt: fall.detectedAt,
            fallResolution: fall.resolution,
            sourceBinding: sourceBinding
        )
        do {
            try eventState.storePendingContext(context)
        } catch {
            eventStatePersistenceBlocked = true
            return .persistenceFailed(eventID: eventID)
        }
        pendingFalls[eventID] = context

        // A call observed just before the CM callback can still be a valid new
        // outgoing state if it falls after the Fall timestamp.
        if let result = await matchPendingCall(for: context) {
            return result
        }
        return .helpQuestion(eventID: eventID)
    }

    func answer(
        eventID: String,
        response: WatchHelpResponse,
        answeredAt: Date
    ) async -> WatchCoordinatorResult {
        guard !eventStatePersistenceBlocked else { return .persistenceFailed(eventID: "event-state") }
        let expiredEventIDs = await expirePending(at: answeredAt)
        if expiredEventIDs.contains(eventID) {
            return .expired(eventID: eventID)
        }
        guard let context = pendingFalls[eventID] else { return .ignored }
        guard context.hasValidSourceBinding else { return .persistenceFailed(eventID: eventID) }
        guard Self.isWithinHelpWindow(
            fallDetectedAt: context.fallDetectedAt,
            observedAt: answeredAt
        ) else {
            do { try eventState.clearPending(eventID: eventID) }
            catch {
                eventStatePersistenceBlocked = true
                return .persistenceFailed(eventID: eventID)
            }
            pendingFalls.removeValue(forKey: eventID)
            return .expired(eventID: eventID)
        }

        switch response {
        case .declined:
            do {
                try outbox.suppress(eventID: eventID, at: answeredAt)
                try eventState.clearPending(eventID: eventID)
            } catch {
                eventStatePersistenceBlocked = true
                return .persistenceFailed(eventID: eventID)
            }
            pendingFalls.removeValue(forKey: eventID)
            return .declined(eventID: eventID)
        case .needsHelp:
            return await assembleAndReport(
                context: context,
                appHelpResponse: .needsHelp,
                callFirstObservedAt: nil
            )
        }
    }

    func receive(call: OutgoingCallSignal) async -> WatchCoordinatorResult {
        guard !eventStatePersistenceBlocked else { return .persistenceFailed(eventID: "event-state") }
        let current = max(now(), call.firstObservedAt)
        await expirePending(at: current)
        guard call.isOutgoing else { return .ignored }
        pruneCalls(at: current)
        guard seenOutgoingCallIDs[call.callID] == nil else { return .ignored }
        seenOutgoingCallIDs[call.callID] = call.firstObservedAt
        outgoingCallsByID[call.callID] = call

        let candidates = pendingFalls.values
            .filter {
                Self.isWithinHelpWindow(
                    fallDetectedAt: $0.fallDetectedAt,
                    observedAt: call.firstObservedAt
                )
            }
            .sorted { $0.fallDetectedAt > $1.fallDetectedAt }
        guard let context = candidates.first else {
            return pendingFalls.values.first.map {
                .waitingForHelp(eventID: $0.eventID)
            } ?? .ignored
        }
        guard context.hasValidSourceBinding else { return .persistenceFailed(eventID: context.eventID) }
        outgoingCallsByID.removeValue(forKey: call.callID)
        return await assembleAndReport(
            context: context,
            appHelpResponse: .noResponse,
            callFirstObservedAt: call.firstObservedAt
        )
    }

    func retryPending(at date: Date? = nil, allowCreation: Bool = true) async -> [WatchCoordinatorResult] {
        let current = date ?? now()
        let pending: [WatchEmergencyObservation]
        do {
            try outbox.pruneDedupeMarkers(now: current)
            pending = try outbox.pending(now: current)
        } catch { return [.persistenceFailed(eventID: "outbox")] }
        var results: [WatchCoordinatorResult] = []
        for observation in pending.sorted(by: { $0.fallDetectedAt < $1.fallDetectedAt }) {
            results.append(await submit(observation, at: current, allowCreation: allowCreation))
        }
        return results
    }

    private func submit(_ observation: WatchEmergencyObservation, at date: Date, allowCreation: Bool) async -> WatchCoordinatorResult {
        let id = observation.eventId
        let queued = WatchCoordinatorResult.queuedForRetry(eventID: id, fallDetectedAt: observation.fallDetectedAt)
        guard inFlight.insert(id).inserted else { return queued }
        defer { inFlight.remove(id) }
        let revision = await reporter.authorizationRevision()
        if authorizationBlocked[id] == revision { return .authorizationRequired(eventID: id) }
        if let plan = retryPlans[id], date < plan.notBefore { return queued }
        let originalBinding: String?
        do {
            if let status = try outbox.rejectedStatus(eventID: id) { return .requiresReview(eventID: id, status: status) }
            originalBinding = try outbox.sourceBinding(eventID: id)
        } catch { return .persistenceFailed(eventID: id) }
        guard let currentBinding = await reporter.observationSourceBinding(),
              originalBinding == nil || originalBinding == currentBinding
        else { return .authorizationRequired(eventID: id) }
        let pastCreationDeadline = date.timeIntervalSince(observation.fallDetectedAt) > Self.triggerRetryWindow
        var readingExisting = false
        do {
            // Recovery cannot create a late rescue. GET proves only existence and
            // access; the original PUT must still confirm the exact observation.
            if originalBinding == nil || !allowCreation || pastCreationDeadline {
                readingExisting = true
                let state = try await reporter.fetchEventState(eventID: id)
                guard state.eventId == id, state.isValid else { throw WatchAPIError.invalidResponse }
                guard revision == (await reporter.authorizationRevision()) else { return .authorizationRequired(eventID: id) }
            }
            readingExisting = false
            try await reporter.report(observation, sourceBinding: currentBinding)
            guard revision == (await reporter.authorizationRevision()) else { return .authorizationRequired(eventID: id) }
            do { try outbox.acknowledge(eventID: id, at: date) }
            catch { return .persistenceFailed(eventID: id) }
            retryPlans.removeValue(forKey: id)
            authorizationBlocked.removeValue(forKey: id)
            do { try eventState.markReported(fallDetectedAt: observation.fallDetectedAt) }
            catch {
                eventStatePersistenceBlocked = true
                return .persistenceFailed(eventID: id)
            }
            return .reported(eventID: id, fallDetectedAt: observation.fallDetectedAt)
        } catch {
            guard revision == (await reporter.authorizationRevision()) else { return .authorizationRequired(eventID: id) }
            if case WatchAPIError.persistenceFailed = error { return .persistenceFailed(eventID: id) }
            if case let WatchAPIError.rejected(status) = error {
                if [400, 404, 409, 422].contains(status), !(status == 404 && readingExisting) {
                    do { try outbox.retainRejected(eventID: id, status: status) }
                    catch { return .persistenceFailed(eventID: id) }
                    return .requiresReview(eventID: id, status: status)
                }
                if [401, 403].contains(status) {
                    authorizationBlocked[id] = revision
                    return .authorizationRequired(eventID: id)
                }
            }
            if case WatchAPIError.notLinked = error {
                authorizationBlocked[id] = revision
                return .authorizationRequired(eventID: id)
            }
            if case WatchAPIError.sessionChanged = error { return .authorizationRequired(eventID: id) }
            let attempts = (retryPlans[id]?.attempts ?? 0) + 1
            retryPlans[id] = (attempts, date.addingTimeInterval(min(60, pow(2, Double(min(attempts - 1, 6))))))
            return queued
        }
    }

    @discardableResult
    func expirePending(at date: Date? = nil) async -> [String] {
        guard !eventStatePersistenceBlocked else { return [] }
        let current = date ?? now()
        let durableObservationIDs: Set<String>
        do {
            durableObservationIDs = Set(try outbox.pending(now: current).map(\.eventId))
        } catch {
            eventStatePersistenceBlocked = true
            return []
        }
        let expired = pendingFalls.values.filter {
            !Self.isWithinHelpWindow(
                fallDetectedAt: $0.fallDetectedAt,
                observedAt: current
            )
        }
        var expiredEventIDs: [String] = []
        for context in expired {
            // Expiry is also a one-time answer: do not re-present the same
            // deterministic event ID if Core Motion repeats its callback.
            do {
                if !durableObservationIDs.contains(context.eventID) {
                    try outbox.suppress(eventID: context.eventID, at: current)
                }
                try eventState.clearPending(eventID: context.eventID)
                pendingFalls.removeValue(forKey: context.eventID)
                expiredEventIDs.append(context.eventID)
            } catch {
                eventStatePersistenceBlocked = true
                break
            }
        }
        try? outbox.pruneDedupeMarkers(now: current)
        pruneCalls(at: current)
        return expiredEventIDs
    }

    func hasPendingHelpQuestion() -> Bool {
        !pendingFalls.isEmpty
    }

    private func matchPendingCall(
        for context: PersistedFallContext
    ) async -> WatchCoordinatorResult? {
        guard context.hasValidSourceBinding else { return .persistenceFailed(eventID: context.eventID) }
        guard let call = outgoingCallsByID.values
            .filter({
                Self.isWithinHelpWindow(
                    fallDetectedAt: context.fallDetectedAt,
                    observedAt: $0.firstObservedAt
                )
            })
            .min(by: { $0.firstObservedAt < $1.firstObservedAt })
        else { return nil }
        outgoingCallsByID.removeValue(forKey: call.callID)
        let result = await assembleAndReport(
            context: context,
            appHelpResponse: .noResponse,
            callFirstObservedAt: call.firstObservedAt
        )
        if case .reported = result {
            do { try eventState.clearPending(eventID: context.eventID) }
            catch {
                eventStatePersistenceBlocked = true
                return .persistenceFailed(eventID: context.eventID)
            }
            pendingFalls.removeValue(forKey: context.eventID)
        }
        return result
    }

    private func pruneCalls(at date: Date) {
        let cutoff = date.addingTimeInterval(-Self.helpQuestionWindow)
        outgoingCallsByID = outgoingCallsByID.filter {
            $0.value.firstObservedAt >= cutoff
        }
        seenOutgoingCallIDs = seenOutgoingCallIDs.filter { $0.value >= cutoff }
    }

    private func assembleAndReport(
        context: PersistedFallContext,
        appHelpResponse: WatchAppHelpResponse,
        callFirstObservedAt: Date?
    ) async -> WatchCoordinatorResult {
        do {
            if try outbox.hasDedupeMarker(eventID: context.eventID, now: now()) {
                return .ignored
            }
        } catch {
            return .persistenceFailed(eventID: context.eventID)
        }
        let snapshot = await positionProvider.snapshot()
        let candidate = WatchEmergencyObservation(
            eventId: context.eventID,
            fallDetectedAt: context.fallDetectedAt,
            fallResolution: context.fallResolution,
            appHelpResponse: appHelpResponse,
            callFirstObservedAt: callFirstObservedAt,
            patientPosition: snapshot.patientPosition,
            patientPositionObservedAt: snapshot.patientPosition == nil ? nil : snapshot.observedAt,
            locationUnavailableReason: snapshot.patientPosition == nil
                ? snapshot.unavailableReason ?? "WATCH_LOCATION_UNAVAILABLE"
                : nil
        )
        let observation: WatchEmergencyObservation
        do {
            observation = try JSONDecoder.contractDecoder().decode(WatchEmergencyObservation.self,
                from: JSONEncoder.contractEncoder().encode(candidate))
            try outbox.store(observation, sourceBinding: context.sourceBinding)
        } catch { return .persistenceFailed(eventID: context.eventID) }
        do {
            // Once the complete observation is durable in the protected
            // outbox, the short-lived help-question context is handed off.
            // Network success is not required for this local transition.
            try eventState.clearPending(eventID: context.eventID)
        } catch {
            eventStatePersistenceBlocked = true
            return .persistenceFailed(eventID: context.eventID)
        }
        pendingFalls.removeValue(forKey: context.eventID)
        return await submit(observation, at: now(), allowCreation: true)
    }

    private static func isWithinHelpWindow(
        fallDetectedAt: Date,
        observedAt: Date
    ) -> Bool {
        let interval = observedAt.timeIntervalSince(fallDetectedAt)
        return interval >= 0 && interval <= helpQuestionWindow
    }
}

@MainActor
final class SimulatedFallDetectionMonitor: FallDetectionMonitoring {
    var authorizationState: FallDetectionAuthorizationState = .authorized {
        didSet { onAuthorizationChange?(authorizationState) }
    }
    var onAuthorizationChange: ((FallDetectionAuthorizationState) -> Void)?
    var onFall: ((FallDetectionSignal, @escaping () -> Void) -> Void)?

    func start() {}
    func stop() {}

    func requestAuthorization() async -> FallDetectionAuthorizationState {
        authorizationState
    }

    func emit(_ signal: FallDetectionSignal, completion: @escaping () -> Void = {}) {
        onFall?(signal, completion)
    }
}

@MainActor
final class SimulatedOutgoingCallMonitor: OutgoingCallMonitoring {
    var onOutgoingCall: ((OutgoingCallSignal) -> Void)?

    func start() {}
    func stop() {}

    func emit(_ signal: OutgoingCallSignal) {
        onOutgoingCall?(signal)
    }
}
