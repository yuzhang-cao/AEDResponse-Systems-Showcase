import Foundation
import Security

struct WatchAuthSession: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let baseURL: String
    let deviceInstanceID: String
    let companionPairID: String
    let companionLinkFingerprint: String?
    let userID: String?
    let accountID: String?

    init(accessToken: String, refreshToken: String, expiresAt: Date, baseURL: String,
         deviceInstanceID: String, companionPairID: String, companionLinkFingerprint: String? = nil,
         userID: String? = nil, accountID: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.baseURL = baseURL
        self.deviceInstanceID = deviceInstanceID
        self.companionPairID = companionPairID
        self.companionLinkFingerprint = companionLinkFingerprint
        self.userID = userID
        self.accountID = accountID
    }
}

protocol WatchAuthSessionPersisting: Sendable {
    func loadAuthSession() -> WatchAuthSession?
    func saveAuthSession(_ session: WatchAuthSession) throws
    func clearAuthSession() throws
}

protocol WatchAppAttestKeyPersisting: Sendable {
    func loadAppAttestKeyID() -> String?
    func saveAppAttestKeyID(_ keyID: String) throws
    func clearAppAttestKeyID() throws
}

/// Watch access/refresh tokens and the App Attest key identifier are device
/// secrets. They are kept in Keychain and are never mirrored to UserDefaults.
final class WatchKeychainStore: @unchecked Sendable,
    WatchAuthSessionPersisting,
    WatchAppAttestKeyPersisting {
    private let service: String
    private let lock = NSLock()
    private let authAccount = "watch-auth-session"
    private let appAttestAccount = "watch-app-attest-key-id"

    init(service: String = Bundle.main.bundleIdentifier ?? "org.example.aedresponse.showcase") {
        self.service = service
    }

    func loadAuthSession() -> WatchAuthSession? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = loadData(account: authAccount),
              let session = try? JSONDecoder.contractDecoder().decode(
                WatchAuthSession.self,
                from: data
              ),
              !session.accessToken.isEmpty,
              !session.refreshToken.isEmpty,
              !session.baseURL.isEmpty,
              !session.deviceInstanceID.isEmpty,
              !session.companionPairID.isEmpty
        else { return nil }
        return session
    }

    func saveAuthSession(_ session: WatchAuthSession) throws {
        guard !session.accessToken.isEmpty,
              !session.refreshToken.isEmpty,
              !session.baseURL.isEmpty,
              !session.deviceInstanceID.isEmpty,
              !session.companionPairID.isEmpty
        else { throw WatchAPIError.persistenceFailed }
        let data: Data
        do {
            data = try JSONEncoder.contractEncoder().encode(session)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
        lock.lock()
        defer { lock.unlock() }
        try saveData(data, account: authAccount)
    }

    func clearAuthSession() throws {
        lock.lock()
        defer { lock.unlock() }
        try clearData(account: authAccount)
    }

    func loadAppAttestKeyID() -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = loadData(account: appAttestAccount),
              let keyID = String(data: data, encoding: .utf8),
              !keyID.isEmpty
        else { return nil }
        return keyID
    }

    func saveAppAttestKeyID(_ keyID: String) throws {
        guard !keyID.isEmpty else { throw WatchAPIError.persistenceFailed }
        lock.lock()
        defer { lock.unlock() }
        try saveData(Data(keyID.utf8), account: appAttestAccount)
    }

    func clearAppAttestKeyID() throws {
        lock.lock()
        defer { lock.unlock() }
        try clearData(account: appAttestAccount)
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func loadData(account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
            return nil
        }
        return item as? Data
    }

    private func saveData(_ data: Data, account: String) throws {
        let updateAttributes: [String: Any] = [
            kSecValueData as String: data
        ]
        let status = SecItemUpdate(
            baseQuery(account: account) as CFDictionary,
            updateAttributes as CFDictionary
        )
        if status == errSecItemNotFound {
            var addAttributes = baseQuery(account: account)
            addAttributes[kSecValueData as String] = data
            addAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addAttributes as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw WatchAPIError.persistenceFailed
            }
        } else if status != errSecSuccess {
            throw WatchAPIError.persistenceFailed
        }
    }

    private func clearData(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw WatchAPIError.persistenceFailed
        }
    }
}

/// Shared low-level Keychain container for protected JSON queues.
private final class WatchProtectedJSONStore: @unchecked Sendable {
    private let service: String
    private let account: String
    private let lock = NSLock()

    init(account: String, service: String = Bundle.main.bundleIdentifier ?? "org.example.aedresponse.showcase") {
        self.service = service
        self.account = account
    }

    func load<T: Decodable>(_ type: T.Type) throws -> T? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try readData() else { return nil }
        do {
            return try JSONDecoder.contractDecoder().decode(type, from: data)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
    }

    func save<T: Encodable>(_ value: T) throws {
        let data: Data
        do {
            data = try JSONEncoder.contractEncoder().encode(value)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
        lock.lock()
        defer { lock.unlock() }
        try writeData(data)
    }

    func withValue<T: Codable, Result>(
        _ type: T.Type,
        default defaultValue: T,
        _ body: (inout T) throws -> Result
    ) throws -> Result {
        lock.lock()
        defer { lock.unlock() }
        let valueData = try readData()
        var value: T
        if let valueData {
            do {
                value = try JSONDecoder.contractDecoder().decode(T.self, from: valueData)
            } catch {
                // Preserve corrupt protected data. Never replace it with an
                // empty queue because doing so would silently lose evidence.
                throw WatchAPIError.persistenceFailed
            }
        } else {
            value = defaultValue
        }
        let result = try body(&value)
        let data: Data
        do {
            data = try JSONEncoder.contractEncoder().encode(value)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
        try writeData(data)
        return result
    }

    private func writeData(_ data: Data) throws {
        let updateAttributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery() as CFDictionary, updateAttributes as CFDictionary)
        if status == errSecItemNotFound {
            var addAttributes = baseQuery()
            addAttributes[kSecValueData as String] = data
            addAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addAttributes as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw WatchAPIError.persistenceFailed
            }
        } else if status != errSecSuccess {
            throw WatchAPIError.persistenceFailed
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func readData() throws -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw WatchAPIError.persistenceFailed
        }
        guard let data = item as? Data else {
            // A successful Keychain lookup with an unexpected value is
            // corruption, not an empty queue. Refuse to replace it.
            throw WatchAPIError.persistenceFailed
        }
        return data
    }
}

struct WatchObservationQueueState: Codable, Sendable {
    var pending: [String: WatchEmergencyObservation] = [:]
    var dedupeMarkers: [String: Date] = [:]
    var rejectedByEventID: [String: Int] = [:]
    var confirmedEventIDs: Set<String> = []
    var sourceBindingsByEventID: [String: String] = [:]

    init() {}
    private enum CodingKeys: String, CodingKey { case pending, dedupeMarkers, rejectedByEventID, confirmedEventIDs, sourceBindingsByEventID }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pending = try values.decode([String: WatchEmergencyObservation].self, forKey: .pending)
        dedupeMarkers = try values.decode([String: Date].self, forKey: .dedupeMarkers)
        rejectedByEventID = try values.decodeIfPresent([String: Int].self, forKey: .rejectedByEventID) ?? [:]
        confirmedEventIDs = try values.decodeIfPresent(Set<String>.self, forKey: .confirmedEventIDs) ?? []
        sourceBindingsByEventID = values.contains(.sourceBindingsByEventID)
            ? try values.decode([String: String].self, forKey: .sourceBindingsByEventID) : [:]
        guard confirmedEventIDs.allSatisfy({ !$0.isEmpty }), pending.allSatisfy({ $0.key == $0.value.eventId && $0.value.isContractValid }),
              rejectedByEventID.allSatisfy({ pending[$0.key] != nil && [400, 404, 409, 422].contains($0.value) }),
              sourceBindingsByEventID.allSatisfy({ (pending[$0.key] != nil || confirmedEventIDs.contains($0.key)) && WatchObservationSource.isValid($0.value) })
        else { throw WatchAPIError.persistenceFailed }
    }

}

/// The creation deadline never deletes an unconfirmed observation. Only an
/// exact-content server ACK releases its protected retry copy.
final class KeychainObservationOutbox: @unchecked Sendable, WatchObservationOutbox {
    static let dedupeRetention: TimeInterval = 24 * 60 * 60
    private let store: WatchProtectedJSONStore

    init(service: String = Bundle.main.bundleIdentifier ?? "org.example.aedresponse.showcase") {
        store = WatchProtectedJSONStore(account: "watch-trigger-outbox", service: service)
    }

    func pending(now: Date) throws -> [WatchEmergencyObservation] {
        return try store.load(WatchObservationQueueState.self)?.pending.values.sorted {
            $0.fallDetectedAt < $1.fallDetectedAt
        } ?? []
    }

    func sourceBinding(eventID: String) throws -> String? {
        try store.load(WatchObservationQueueState.self)?.sourceBindingsByEventID[eventID]
    }

    func store(_ observation: WatchEmergencyObservation, sourceBinding: String? = nil) throws {
        guard observation.isContractValid, sourceBinding.map(WatchObservationSource.isValid) ?? true
        else { throw WatchAPIError.persistenceFailed }
        try store.withValue(WatchObservationQueueState.self, default: WatchObservationQueueState()) { state in
            if let existing = state.pending[observation.eventId] {
                guard existing == observation, state.sourceBindingsByEventID[observation.eventId] == sourceBinding
                else { throw WatchAPIError.persistenceFailed }
                return
            }
            guard state.dedupeMarkers[observation.eventId] == nil, !state.confirmedEventIDs.contains(observation.eventId)
            else { throw WatchAPIError.persistenceFailed }
            state.pending[observation.eventId] = observation
            state.sourceBindingsByEventID[observation.eventId] = sourceBinding
        }
    }

    func acknowledge(eventID: String, at date: Date) throws {
        try store.withValue(WatchObservationQueueState.self, default: WatchObservationQueueState()) {
            if $0.pending.removeValue(forKey: eventID) != nil { $0.confirmedEventIDs.insert(eventID) }
            $0.rejectedByEventID.removeValue(forKey: eventID)
            $0.dedupeMarkers[eventID] = date
        }
    }

    func suppress(eventID: String, at date: Date) throws {
        try store.withValue(WatchObservationQueueState.self, default: WatchObservationQueueState()) {
            guard $0.pending[eventID] == nil else { throw WatchAPIError.persistenceFailed }
            $0.dedupeMarkers[eventID] = date
        }
    }

    func confirmedEventIDs() throws -> [String] {
        try store.load(WatchObservationQueueState.self)?.confirmedEventIDs.sorted() ?? []
    }

    func rejectedStatus(eventID: String) throws -> Int? {
        try store.load(WatchObservationQueueState.self)?.rejectedByEventID[eventID]
    }

    func retainRejected(eventID: String, status: Int) throws {
        try store.withValue(WatchObservationQueueState.self, default: WatchObservationQueueState()) {
            guard $0.pending[eventID] != nil, [400, 404, 409, 422].contains(status),
                  $0.rejectedByEventID[eventID].map({ $0 == status }) ?? true
            else { throw WatchAPIError.persistenceFailed }
            $0.rejectedByEventID[eventID] = status
        }
    }

    func pruneDedupeMarkers(now date: Date) throws {
        try store.withValue(WatchObservationQueueState.self, default: WatchObservationQueueState()) {
            $0.dedupeMarkers = $0.dedupeMarkers.filter {
                date.timeIntervalSince($0.value) <= Self.dedupeRetention
            }
        }
    }

    func hasDedupeMarker(eventID: String, now date: Date) throws -> Bool {
        guard let state = try store.load(WatchObservationQueueState.self) else { return false }
        if state.pending[eventID] != nil { return true }
        return state.dedupeMarkers[eventID].map { date.timeIntervalSince($0) <= Self.dedupeRetention } ?? false
    }
}

struct WatchFallbackQueueState: Codable, Sendable {
    var pending: [String: WatchFallbackPositionUpdate] = [:]
    var sealedEvents: [String: WatchEventStateSnapshot] = [:]
    var quarantined: [String: QuarantinedWatchFallbackFact] = [:]
    /// Local-only source binding for each unacknowledged fallback fact. It is
    /// deliberately absent from the HTTP payload and never contains a token.
    var sourceBindingsByPositionUpdateID: [String: String] = [:]

    init() {}
    private enum CodingKeys: String, CodingKey {
        case pending, sealedEvents, quarantined, sourceBindingsByPositionUpdateID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pending = try values.decode([String: WatchFallbackPositionUpdate].self, forKey: .pending)
        sealedEvents = try values.decodeIfPresent([String: WatchEventStateSnapshot].self, forKey: .sealedEvents) ?? [:]
        quarantined = try values.decodeIfPresent([String: QuarantinedWatchFallbackFact].self, forKey: .quarantined) ?? [:]
        sourceBindingsByPositionUpdateID = values.contains(.sourceBindingsByPositionUpdateID)
            ? try values.decode([String: String].self, forKey: .sourceBindingsByPositionUpdateID) : [:]
        guard pending.allSatisfy({ $0.key == $0.value.positionUpdateId }),
              sealedEvents.allSatisfy({ $0.key == $0.value.eventId && $0.value.isValid && $0.value.state.isTerminal }),
              quarantined.allSatisfy({ $0.key == $0.value.update.positionUpdateId && pending[$0.key] == nil }),
              sourceBindingsByPositionUpdateID.allSatisfy({
                  (pending[$0.key] != nil || quarantined[$0.key] != nil)
                      && WatchObservationSource.isValid($0.value)
              })
        else { throw WatchAPIError.persistenceFailed }
    }
}

/// Fallback samples contain location and therefore never use UserDefaults.
/// The queue is keyed by stable positionUpdateId and never silently truncates
/// old entries; ACK removes a pending sample, isolation retains its full body.
private final class WatchProtectedFileStore: @unchecked Sendable {
    private let url: URL?
    private let initializationFailed: Bool
    private let lock = NSLock()

    init(filename: String) {
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first
        guard let directory else {
            url = nil
            initializationFailed = true
            return
        }
        let appDirectory = directory.appendingPathComponent("AEDResponse", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: appDirectory,
                withIntermediateDirectories: true
            )
            url = appDirectory.appendingPathComponent(filename, isDirectory: false)
            initializationFailed = false
        } catch {
            url = nil
            initializationFailed = true
        }
    }

    init(fileURL: URL) {
        url = fileURL
        initializationFailed = false
    }

    func load<T: Decodable>(_ type: T.Type) throws -> T? {
        lock.lock()
        defer { lock.unlock() }
        guard !initializationFailed, let url else {
            throw WatchAPIError.persistenceFailed
        }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
        do {
            return try JSONDecoder.contractDecoder().decode(type, from: data)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
    }

    func withValue<T: Codable, Result>(
        _ type: T.Type,
        default defaultValue: T,
        _ body: (inout T) throws -> Result
    ) throws -> Result {
        lock.lock()
        defer { lock.unlock() }
        guard !initializationFailed, let url else {
            throw WatchAPIError.persistenceFailed
        }
        var value: T
        if FileManager.default.fileExists(atPath: url.path) {
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                throw WatchAPIError.persistenceFailed
            }
            do {
                value = try JSONDecoder.contractDecoder().decode(T.self, from: data)
            } catch {
                throw WatchAPIError.persistenceFailed
            }
        } else {
            value = defaultValue
        }
        let result = try body(&value)
        let data: Data
        do {
            data = try JSONEncoder.contractEncoder().encode(value)
        } catch {
            throw WatchAPIError.persistenceFailed
        }
        do {
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch {
            throw WatchAPIError.persistenceFailed
        }
        return result
    }
}

final class ProtectedFileWatchFallbackOutbox: @unchecked Sendable, WatchFallbackOutbox {
    private let store: WatchProtectedFileStore

    init(filename: String = "watch-fallback-outbox.json") {
        store = WatchProtectedFileStore(filename: filename)
    }

    init(fileURL: URL) {
        store = WatchProtectedFileStore(fileURL: fileURL)
    }

    func pending(now: Date) throws -> [WatchFallbackPositionUpdate] {
        _ = now
        return try store.load(WatchFallbackQueueState.self)?.pending.values.sorted {
            $0.observedAt < $1.observedAt
        } ?? []
    }

    func sourceBinding(positionUpdateID: String) throws -> String? {
        try store.load(WatchFallbackQueueState.self)?.sourceBindingsByPositionUpdateID[positionUpdateID]
    }

    func store(_ update: WatchFallbackPositionUpdate, sourceBinding: String?) throws {
        guard update.eventId.isEmpty == false,
              sourceBinding.map(WatchObservationSource.isValid) ?? true
        else { throw WatchAPIError.persistenceFailed }
        _ = try store.withValue(WatchFallbackQueueState.self, default: WatchFallbackQueueState()) {
            guard $0.quarantined[update.positionUpdateId] == nil,
                  $0.pending[update.positionUpdateId].map({ $0 == update }) ?? true
            else { throw WatchAPIError.persistenceFailed }
            if let existingBinding = $0.sourceBindingsByPositionUpdateID[update.positionUpdateId] {
                guard existingBinding == sourceBinding else { throw WatchAPIError.persistenceFailed }
            } else if $0.pending[update.positionUpdateId] != nil {
                guard sourceBinding == nil else { throw WatchAPIError.persistenceFailed }
            }
            $0.pending[update.positionUpdateId] = update
            if let sourceBinding {
                $0.sourceBindingsByPositionUpdateID[update.positionUpdateId] = sourceBinding
            }
        }
    }

    func acknowledge(positionUpdateID: String) throws {
        _ = try store.withValue(WatchFallbackQueueState.self, default: WatchFallbackQueueState()) {
            $0.pending.removeValue(forKey: positionUpdateID)
            if $0.quarantined[positionUpdateID] == nil {
                $0.sourceBindingsByPositionUpdateID.removeValue(forKey: positionUpdateID)
            }
        }
    }

    func sealedState(eventID: String) throws -> WatchEventStateSnapshot? {
        try store.load(WatchFallbackQueueState.self)?.sealedEvents[eventID]
    }

    func seal(_ snapshot: WatchEventStateSnapshot) throws {
        guard snapshot.isValid, snapshot.state.isTerminal else { throw WatchAPIError.invalidResponse }
        _ = try store.withValue(WatchFallbackQueueState.self, default: WatchFallbackQueueState()) {
            if let prior = $0.sealedEvents[snapshot.eventId] {
                guard prior.state == snapshot.state, prior.createdAt == snapshot.createdAt,
                      prior.resolvedAt == nil || prior.resolvedAt == snapshot.resolvedAt
                else { throw WatchAPIError.invalidResponse }
            }
            $0.sealedEvents[snapshot.eventId] = snapshot
        }
    }

    func quarantine(_ update: WatchFallbackPositionUpdate, reason: QuarantinedWatchFallbackFact.Reason,
        serverWindow: WatchEventStateSnapshot?, statusCode: Int?) throws {
        _ = try store.withValue(WatchFallbackQueueState.self, default: WatchFallbackQueueState()) {
            guard $0.pending[update.positionUpdateId].map({ $0 == update }) ?? true,
                  $0.quarantined[update.positionUpdateId].map({ $0.update == update }) ?? true
            else { throw WatchAPIError.persistenceFailed }
            if $0.quarantined[update.positionUpdateId] == nil {
                $0.quarantined[update.positionUpdateId] = QuarantinedWatchFallbackFact(update: update,
                    reason: reason, serverWindow: serverWindow, statusCode: statusCode)
            }
            $0.pending.removeValue(forKey: update.positionUpdateId)
        }
    }

    func discardExpired(now: Date) throws -> [String] {
        _ = now
        return []
    }
}

struct WatchConfiguration: Equatable, Sendable {
    let baseURL: String
    let companionPairID: String
    let deviceInstanceID: String
}

/// The Watch has no production text-field configuration. This store is
/// updated only after a server-backed companion-link envelope is redeemed.
final class WatchConfigurationStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let lock = NSLock()
    private let baseURLKey = "aedresponse.watch.v2.base-url"
    private let pairIDKey = "aedresponse.watch.v2.companion-pair-id"
    private let deviceIDKey = "aedresponse.watch.v2.device-instance-id"
    private let linkedConfigurationKey = "aedresponse.watch.v2.linked-configuration"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> WatchConfiguration {
        lock.lock()
        defer { lock.unlock() }
        if let stored = defaults.object(forKey: linkedConfigurationKey) {
            guard let linked = stored as? [String: String],
                  let baseURL = linked["baseURL"], let pair = linked["pair"],
                  let device = linked["device"], UUID(uuidString: device) != nil else {
                return WatchConfiguration(baseURL: "", companionPairID: "", deviceInstanceID: "")
            }
            return WatchConfiguration(baseURL: baseURL, companionPairID: pair, deviceInstanceID: device)
        }
        let deviceID: String
        if let stored = defaults.string(forKey: deviceIDKey), UUID(uuidString: stored) != nil {
            deviceID = stored
        } else {
            deviceID = UUID().uuidString
            defaults.set(deviceID, forKey: deviceIDKey)
        }
        return WatchConfiguration(
            baseURL: defaults.string(forKey: baseURLKey) ?? "",
            companionPairID: defaults.string(forKey: pairIDKey) ?? "",
            deviceInstanceID: deviceID
        )
    }

    func candidateConfiguration(for pairID: String) throws -> WatchConfiguration {
        let current = load()
        guard current.companionPairID != pairID, !current.companionPairID.isEmpty else { return current }
        lock.lock()
        defer { lock.unlock() }
        let key = "aedresponse.watch.v2.device-ids-by-pair"
        let stored = defaults.object(forKey: key)
        guard stored == nil || stored is [String: String] else { throw WatchAPIError.persistenceFailed }
        var identities = stored as? [String: String] ?? [:]
        guard identities.values.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw WatchAPIError.persistenceFailed
        }
        identities[current.companionPairID] = current.deviceInstanceID
        let deviceID = identities[pairID] ?? UUID().uuidString
        identities[pairID] = deviceID
        defaults.set(identities, forKey: key)
        return WatchConfiguration(baseURL: current.baseURL, companionPairID: pairID, deviceInstanceID: deviceID)
    }

    func applyLinkedConfiguration(baseURL: String, companionPairID: String, deviceInstanceID: String? = nil) {
        lock.lock()
        defer { lock.unlock() }
        let linked = defaults.dictionary(forKey: linkedConfigurationKey) as? [String: String]
        let device = deviceInstanceID ?? linked?["device"]
            ?? defaults.string(forKey: deviceIDKey) ?? UUID().uuidString
        // Publish one configuration value; a crash must not combine the new
        // account's pair with the old device identity.
        defaults.set(["baseURL": baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                      "pair": companionPairID.trimmingCharacters(in: .whitespacesAndNewlines),
                      "device": device], forKey: linkedConfigurationKey)
    }
}

final class UserDefaultsFallEventStateStore: @unchecked Sendable, FallEventStatePersisting {
    private struct Record: Codable {
        let eventID: String
        var reported: Bool
        var pendingContext: PersistedFallContext?

        private enum CodingKeys: String, CodingKey {
            case eventID, reported, pendingContext
        }

        init(eventID: String, reported: Bool, pendingContext: PersistedFallContext? = nil) {
            self.eventID = eventID
            self.reported = reported
            self.pendingContext = pendingContext
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            eventID = try container.decode(String.self, forKey: .eventID)
            reported = try container.decodeIfPresent(Bool.self, forKey: .reported) ?? false
            pendingContext = try container.decodeIfPresent(
                PersistedFallContext.self,
                forKey: .pendingContext
            )
        }
    }

    private let defaults: UserDefaults
    private let lock = NSLock()
    private let key = "aedresponse.watch.v2.fall-event-state"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func eventID(for fallDetectedAt: Date) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        var records = try loadRecords()
        let dateKey = Self.key(for: fallDetectedAt)
        if let existing = records[dateKey] { return existing.eventID }
        let eventID = UUID().uuidString
        records[dateKey] = Record(eventID: eventID, reported: false)
        try saveRecords(records)
        return eventID
    }

    func wasReported(fallDetectedAt: Date) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return try loadRecords()[Self.key(for: fallDetectedAt)]?.reported ?? false
    }

    func markReported(fallDetectedAt: Date) throws {
        lock.lock()
        defer { lock.unlock() }
        var records = try loadRecords()
        let dateKey = Self.key(for: fallDetectedAt)
        if var record = records[dateKey] {
            record.reported = true
            record.pendingContext = nil
            records[dateKey] = record
        }
        try saveRecords(records)
    }

    func pendingContexts(now date: Date) throws -> [PersistedFallContext] {
        lock.lock()
        defer { lock.unlock() }
        var records = try loadRecords()
        let values = records.values.compactMap { record -> PersistedFallContext? in
            guard let context = record.pendingContext else { return nil }
            return date.timeIntervalSince(context.fallDetectedAt) >= 0
                && date.timeIntervalSince(context.fallDetectedAt) <= 120
                ? context
                : nil
        }
        records = records.filter { entry in
            guard let context = entry.value.pendingContext else { return true }
            return date.timeIntervalSince(context.fallDetectedAt) <= 120
        }
        try saveRecords(records)
        return values
    }

    func storePendingContext(_ context: PersistedFallContext) throws {
        lock.lock()
        defer { lock.unlock() }
        var records = try loadRecords()
        let dateKey = Self.key(for: context.fallDetectedAt)
        let eventID = records[dateKey]?.eventID ?? context.eventID
        records[dateKey] = Record(
            eventID: eventID,
            reported: records[dateKey]?.reported ?? false,
            pendingContext: context
        )
        try saveRecords(records)
    }

    func clearPending(eventID: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var records = try loadRecords()
        for key in records.keys where records[key]?.eventID == eventID {
            records[key]?.pendingContext = nil
        }
        try saveRecords(records)
    }

    private static func key(for date: Date) -> String {
        String(Int64((date.timeIntervalSince1970 * 1_000).rounded()))
    }

    private func loadRecords() throws -> [String: Record] {
        guard defaults.object(forKey: key) != nil else { return [:] }
        guard let data = defaults.data(forKey: key) else {
            // A value of the wrong UserDefaults type is corruption, not a
            // missing record. Keep it untouched so recovery can inspect it.
            throw WatchAPIError.persistenceFailed
        }
        do {
            return try JSONDecoder.contractDecoder().decode([String: Record].self, from: data)
        } catch {
            // Keep the raw UserDefaults bytes. A corrupt context is a
            // persistence failure, never an empty state to be overwritten.
            throw WatchAPIError.persistenceFailed
        }
    }

    private func saveRecords(_ records: [String: Record]) throws {
        let data: Data
        do { data = try JSONEncoder.contractEncoder().encode(records) }
        catch { throw WatchAPIError.persistenceFailed }
        defaults.set(data, forKey: key)
    }
}

final class UserDefaultsWatchFallbackStateStore: @unchecked Sendable,
    WatchFallbackStatePersisting {
    private let defaults: UserDefaults
    private let lock = NSLock()
    private let key = "aedresponse.watch.v2.fallback-active-event"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func activeEvent() -> PersistedWatchFallbackEvent? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder.contractDecoder().decode(
            PersistedWatchFallbackEvent.self,
            from: data
        )
    }

    func setActiveEvent(_ event: PersistedWatchFallbackEvent?) {
        lock.lock()
        defer { lock.unlock() }
        guard let event,
              let data = try? JSONEncoder.contractEncoder().encode(event)
        else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }
}
