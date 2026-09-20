import CryptoKit
import Foundation

enum WatchAPIError: Error, LocalizedError {
    case invalidConfiguration
    case invalidResponse
    case rejected(Int)
    case notLinked
    case expiredCompanionLink
    case companionPairMismatch
    case appAttestUnsupported
    case appAttestFailed
    case persistenceFailed
    case fallbackAdmissionChanged
    case sessionChanged

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration:
            "请使用受信任的 v2 服务地址和 iPhone 配对 ID。"
        case .invalidResponse:
            "v2 服务返回了无法识别的响应。"
        case let .rejected(status):
            "v2 服务拒绝 Watch 请求（HTTP \(status)）。"
        case .notLinked:
            "Watch 尚未完成受保护的 iPhone 配对。请从 iPhone 重新发送配对凭据。"
        case .expiredCompanionLink:
            "Watch 配对凭据已过期，请从 iPhone 重新发送。"
        case .companionPairMismatch:
            "Watch 配对 ID 与当前 iPhone 不匹配，已拒绝绑定。"
        case .appAttestUnsupported:
            "此 Watch 不支持 Apple App Attest，无法安全绑定。"
        case .appAttestFailed:
            "Apple App Attest 未完成，Watch 不会降级为匿名会话。"
        case .persistenceFailed:
            "Watch 安全会话保存失败，已停止网络上报。"
        case .fallbackAdmissionChanged:
            "手机位置已恢复；等待后端重新确认备用上传条件。"
        case .sessionChanged:
            "Watch 会话已变化，旧请求结果不再应用；未确认记录仍保留。"
        }
    }
}

protocol WatchAPIHTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

protocol WatchCompanionLinkRedeeming: Sendable {
    func redeemCompanionLink(_ envelope: CompanionLinkEnvelope) async throws
    func recoverCompanionLink(_ envelope: CompanionLinkEnvelope) async throws
    func restoreWatchSession(remoteValidation: Bool) async -> Bool
    func hasValidWatchSession() async -> Bool
}

extension WatchCompanionLinkRedeeming {
    func recoverCompanionLink(_ envelope: CompanionLinkEnvelope) async throws {
        try await redeemCompanionLink(envelope)
    }
}

private struct URLSessionWatchAPIHTTPTransport: WatchAPIHTTPTransport {
    let session: URLSession

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

actor WatchAPIReporter: WatchObservationReporting,
    WatchFallbackReporting,
    WatchCompanionLinkRedeeming {
    private struct SessionResponse: Decodable {
        let sessionToken: String
        let refreshToken: String
        let expiresAt: Date
        let userId: String
        let accountId: String
    }

    private struct RefreshBody: Encodable {
        let refreshToken: String
    }

    private struct RedeemBody: Encodable {
        let deviceInstanceId: String
        let companionPairId: String
        let companionLinkTicket: String
        let appAttestKeyId: String
        let attestationObject: String
    }

    private let configurationStore: WatchConfigurationStore
    private let transport: any WatchAPIHTTPTransport
    private let authSessionStore: any WatchAuthSessionPersisting
    private let appAttestKeyStore: any WatchAppAttestKeyPersisting
    private let appAttest: any WatchAppAttestProviding
    private let now: @Sendable () -> Date
    private var authRevision = 0
    private var authSession: WatchAuthSession? {
        didSet { if oldValue != authSession { authRevision += 1 } }
    }
    private var refreshTask: Task<WatchAuthSession, Error>?
    private var refreshTaskID: UUID?
    private var refreshTaskSession: WatchAuthSession?
    private var linkGeneration = 0
    private var currentLinkID: UUID?
    private var linkAttempts: [String: (id: UUID, expiresAt: Date, task: Task<Void, Error>)] = [:]

    init(
        configurationStore: WatchConfigurationStore,
        session: URLSession = .shared,
        authSessionStore: any WatchAuthSessionPersisting = WatchKeychainStore(),
        appAttestKeyStore: any WatchAppAttestKeyPersisting = WatchKeychainStore(),
        appAttest: any WatchAppAttestProviding = DeviceCheckAppAttestAdapter(),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.configurationStore = configurationStore
        transport = URLSessionWatchAPIHTTPTransport(session: session)
        self.authSessionStore = authSessionStore
        self.appAttestKeyStore = appAttestKeyStore
        self.appAttest = appAttest
        self.now = now
        authSession = authSessionStore.loadAuthSession()
    }

    init(
        configurationStore: WatchConfigurationStore,
        transport: any WatchAPIHTTPTransport,
        authSessionStore: any WatchAuthSessionPersisting = WatchKeychainStore(),
        appAttestKeyStore: any WatchAppAttestKeyPersisting = WatchKeychainStore(),
        appAttest: any WatchAppAttestProviding = DeviceCheckAppAttestAdapter(),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.configurationStore = configurationStore
        self.transport = transport
        self.authSessionStore = authSessionStore
        self.appAttestKeyStore = appAttestKeyStore
        self.appAttest = appAttest
        self.now = now
        authSession = authSessionStore.loadAuthSession()
    }

    /// Exchanges the transient iPhone-issued envelope for a Watch-scoped
    /// session. The raw ticket is never persisted; only the server-issued
    /// access/refresh pair is written to Keychain.
    func redeemCompanionLink(_ envelope: CompanionLinkEnvelope) async throws {
        try await redeem(envelope, recoveringAccount: false)
    }

    func recoverCompanionLink(_ envelope: CompanionLinkEnvelope) async throws {
        try await redeem(envelope, recoveringAccount: true)
    }

    private func redeem(_ envelope: CompanionLinkEnvelope, recoveringAccount: Bool) async throws {
        guard envelope.expiresAt > now() else {
            throw WatchAPIError.expiredCompanionLink
        }
        let baseURL = try Self.apiBaseURL(from: envelope.baseURL)
        let originalConfiguration = configurationStore.load()
        let configuration = recoveringAccount
            ? try configurationStore.candidateConfiguration(for: envelope.companionPairId)
            : originalConfiguration
        guard UUID(uuidString: configuration.deviceInstanceID) != nil,
              UUID(uuidString: envelope.companionPairId) != nil,
              !envelope.companionLinkTicket.isEmpty
        else {
            throw WatchAPIError.invalidConfiguration
        }
        if !configuration.baseURL.isEmpty {
            guard let configuredBaseURL = try? Self.apiBaseURL(from: configuration.baseURL),
                  configuredBaseURL.absoluteString == baseURL.absoluteString
            else {
                // A link envelope cannot silently move an existing Watch
                // session to a different issuer. Rebinding requires a fresh
                // local configuration and a new App Attest exchange.
                throw WatchAPIError.invalidConfiguration
            }
        }
        if !configuration.companionPairID.isEmpty,
           configuration.companionPairID != envelope.companionPairId {
            throw WatchAPIError.companionPairMismatch
        }
        let fingerprint = CompanionLinkClientData.hash(ticket: envelope.companionLinkTicket,
            deviceInstanceID: configuration.deviceInstanceID, companionPairID: envelope.companionPairId).base64EncodedString()
        linkAttempts = linkAttempts.filter { $0.value.expiresAt > now() }
        if let previous = linkAttempts[fingerprint] {
            guard currentLinkID == previous.id else { throw WatchAPIError.sessionChanged }
            try await previous.task.value
            try await validateAcceptedLink(fingerprint: fingerprint, configuration: configuration,
                companionPairID: envelope.companionPairId, baseURL: baseURL)
            return
        }
        if currentLinkID == nil, let existing = authSession,
           existing.baseURL == baseURL.absoluteString,
           existing.deviceInstanceID == configuration.deviceInstanceID,
           existing.companionPairID == envelope.companionPairId,
           existing.companionLinkFingerprint == fingerprint {
            try await validateAcceptedLink(fingerprint: fingerprint, configuration: configuration,
                companionPairID: envelope.companionPairId, baseURL: baseURL)
            return
        }
        guard appAttest.isSupported else { throw WatchAPIError.appAttestUnsupported }
        let operationID = UUID()
        currentLinkID = operationID
        linkGeneration += 1
        authRevision += 1
        let task = Task { [weak self] in
            guard let self else { throw WatchAPIError.sessionChanged }
            try await self.performRedeem(envelope, configuration: configuration, baseURL: baseURL,
                fingerprint: fingerprint, operationID: operationID, originalConfiguration: originalConfiguration)
        }
        linkAttempts[fingerprint] = (operationID, envelope.expiresAt, task)
        defer {
            if currentLinkID == operationID { currentLinkID = nil }
            if linkAttempts[fingerprint]?.id == operationID { linkAttempts.removeValue(forKey: fingerprint) }
        }
        try await task.value
        try await validateAcceptedLink(fingerprint: fingerprint, configuration: configuration,
                companionPairID: envelope.companionPairId, baseURL: baseURL)
    }

    private func validateAcceptedLink(fingerprint: String, configuration: WatchConfiguration, companionPairID: String, baseURL: URL) async throws {
        func matchingSession() -> WatchAuthSession? {
            let current = configurationStore.load()
            guard currentLinkID == nil, let session = authSession,
                  session.companionLinkFingerprint == fingerprint,
                  session.baseURL == baseURL.absoluteString,
                  (try? Self.apiBaseURL(from: current.baseURL)) == baseURL,
                  current.deviceInstanceID == configuration.deviceInstanceID,
                  current.companionPairID == companionPairID,
                  session.deviceInstanceID == configuration.deviceInstanceID,
                  session.companionPairID == companionPairID else { return nil }
            return session
        }
        guard let session = matchingSession() else { throw WatchAPIError.sessionChanged }
        if session.expiresAt <= now().addingTimeInterval(30) { _ = try await refreshSingleFlight(session) }
        guard let current = matchingSession(), current.expiresAt > now() else { throw WatchAPIError.sessionChanged }
    }

    private func performRedeem(_ envelope: CompanionLinkEnvelope, configuration: WatchConfiguration,
        baseURL: URL, fingerprint: String, operationID: UUID, originalConfiguration: WatchConfiguration) async throws {
        func requireCurrent() throws {
            guard currentLinkID == operationID, configurationStore.load() == originalConfiguration else {
                throw WatchAPIError.sessionChanged
            }
        }
        try requireCurrent()
        let clientDataHash = CompanionLinkClientData.hash(ticket: envelope.companionLinkTicket,
            deviceInstanceID: configuration.deviceInstanceID, companionPairID: envelope.companionPairId)
        let keyID: String
        let attestationObject: Data
        do {
            keyID = try await appAttest.generateKey()
            try requireCurrent()
            guard !keyID.isEmpty else { throw WatchAPIError.appAttestFailed }
            attestationObject = try await appAttest.attestKey(keyID, clientDataHash: clientDataHash)
            try requireCurrent()
            guard !attestationObject.isEmpty else { throw WatchAPIError.appAttestFailed }
        } catch let error as WatchAPIError { throw error }
        catch { throw WatchAPIError.appAttestFailed }

        let body = RedeemBody(deviceInstanceId: configuration.deviceInstanceID,
            companionPairId: envelope.companionPairId, companionLinkTicket: envelope.companionLinkTicket,
            appAttestKeyId: keyID, attestationObject: attestationObject.base64EncodedString())
        let (data, response) = try await post(body, path: "watch/session/redeem", baseURL: baseURL)
        try requireCurrent()
        guard response.statusCode == 201 else { throw WatchAPIError.rejected(response.statusCode) }
        let session = try sessionFromResponse(data, baseURL: baseURL,
            deviceInstanceID: configuration.deviceInstanceID, companionPairID: envelope.companionPairId,
            companionLinkFingerprint: fingerprint)
        do {
            // No stale attempt may replace or clear a key belonging to a later session.
            try appAttestKeyStore.saveAppAttestKeyID(keyID)
            try authSessionStore.saveAuthSession(session)
        } catch {
            invalidateSession(clearPersisted: true)
            try? appAttestKeyStore.clearAppAttestKeyID()
            throw WatchAPIError.persistenceFailed
        }
        configurationStore.applyLinkedConfiguration(baseURL: baseURL.absoluteString,
            companionPairID: envelope.companionPairId, deviceInstanceID: configuration.deviceInstanceID)
        authSession = session
        currentLinkID = nil
        if linkAttempts[fingerprint]?.id == operationID { linkAttempts.removeValue(forKey: fingerprint) }
    }

    func authorizationRevision() -> Int { authRevision }

    func hasValidWatchSession() -> Bool {
        guard currentLinkID == nil else { return false }
        let configuration = configurationStore.load()
        guard let session = authSession,
              !session.accessToken.isEmpty,
              !session.refreshToken.isEmpty,
              !session.baseURL.isEmpty,
              !session.deviceInstanceID.isEmpty,
              !session.companionPairID.isEmpty,
              session.deviceInstanceID == configuration.deviceInstanceID,
              session.companionPairID == configuration.companionPairID,
              let configuredBaseURL = try? Self.apiBaseURL(from: configuration.baseURL),
              session.baseURL == configuredBaseURL.absoluteString
        else { return false }
        return session.expiresAt > now()
    }

    /// Cold-start validation always rotates the persisted Watch session on its
    /// bound issuer before any trigger/fallback request is allowed.
    func restoreWatchSession(remoteValidation: Bool) async -> Bool {
        guard currentLinkID == nil else { return false }
        guard let session = authSession else { return false }
        let configuration = configurationStore.load()
        guard let configuredBaseURL = try? Self.apiBaseURL(from: configuration.baseURL),
              session.baseURL == configuredBaseURL.absoluteString,
              session.deviceInstanceID == configuration.deviceInstanceID,
              session.companionPairID == configuration.companionPairID
        else {
            // Never refresh a session against an issuer that is no longer the
            // currently linked configuration. This also makes a changed host,
            // path, or pair fail closed without sending the old bearer.
            invalidateSession(clearPersisted: true)
            return false
        }
        guard hasValidWatchSession() else {
            if !remoteValidation { return false }
            do {
                _ = try await refreshSingleFlight(session)
                return hasValidWatchSession()
            } catch {
                return false
            }
        }
        guard remoteValidation else { return true }
        do {
            _ = try await refreshSingleFlight(session)
            return hasValidWatchSession()
        } catch {
            return false
        }
    }

    /// Captures the server-established principal independently of token rotation.
    /// Expired credentials may still identify an offline fact; sending separately
    /// requires a valid token and backend authorization.
    func observationSourceBinding() -> String? {
        guard currentLinkID == nil, let session = authSession else { return nil }
        let configuration = configurationStore.load()
        guard (try? Self.apiBaseURL(from: configuration.baseURL).absoluteString) == session.baseURL,
              configuration.deviceInstanceID == session.deviceInstanceID,
              configuration.companionPairID == session.companionPairID,
              let userID = session.userID, !userID.isEmpty,
              let accountID = session.accountID, !accountID.isEmpty else { return nil }
        var identity = Data("AEDResponse.watch-source.v1".utf8)
        for component in [session.baseURL, userID, accountID, session.deviceInstanceID, session.companionPairID] {
            let bytes = Data(component.utf8)
            identity.append(Data("\(bytes.count):".utf8))
            identity.append(bytes)
        }
        return SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    }

    func report(_ observation: WatchEmergencyObservation, sourceBinding: String) async throws {
        guard observation.isContractValid else {
            throw WatchAPIError.invalidResponse
        }
        let (data, response) = try await authenticatedRequest(
            observation,
            path: "watch/emergency-observations/\(observation.eventId)",
            expectedSourceBinding: sourceBinding
        )
        guard (200...201).contains(response.statusCode) else {
            throw WatchAPIError.rejected(response.statusCode)
        }
        struct ObservationACK: Decodable { let id: String; let state: EventState }
        let ack = try JSONDecoder.contractDecoder().decode(ObservationACK.self, from: data)
        guard ack.id == observation.eventId else { throw WatchAPIError.invalidResponse }
    }

    func fetchEventState(eventID: String) async throws -> WatchEventStateSnapshot {
        guard UUID(uuidString: eventID) != nil else { throw WatchAPIError.invalidResponse }
        struct NoBody: Encodable {}
        let (data, response) = try await authenticatedRequest(Optional<NoBody>.none,
            path: "watch/events/\(eventID)/state", method: "GET")
        guard response.statusCode == 200 else { throw WatchAPIError.rejected(response.statusCode) }
        let state = try JSONDecoder.contractDecoder().decode(WatchEventStateSnapshot.self, from: data)
        guard state.eventId == eventID, state.isValid else { throw WatchAPIError.invalidResponse }
        return state
    }

    func reportFallbackPosition(
        _ update: WatchFallbackPositionUpdate,
        expectedSourceBinding: String? = nil
    ) async throws -> PositionUpdateResult {
        let (data, response) = try await authenticatedRequest(
            update,
            path: "watch/events/\(update.eventId)/fallback-position/\(update.positionUpdateId)",
            expectedSourceBinding: expectedSourceBinding
        )
        struct Problem: Decodable { let type: String }
        if response.statusCode == 403,
           let problem = try? JSONDecoder().decode(Problem.self, from: data),
           problem.type == "https://aedresponse.invalid/problems/fallback-admission-changed" {
            throw WatchAPIError.fallbackAdmissionChanged
        }
        guard response.statusCode == 200 else {
            throw WatchAPIError.rejected(response.statusCode)
        }
        return try JSONDecoder.contractDecoder().decode(PositionUpdateResult.self, from: data)
    }

    private func authenticatedRequest<Body: Encodable>(
        _ body: Body?,
        path: String,
        method: String = "PUT",
        expectedSourceBinding: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        guard currentLinkID == nil else { throw WatchAPIError.sessionChanged }
        func requireSourceBinding() throws {
            if let expectedSourceBinding, observationSourceBinding() != expectedSourceBinding {
                throw WatchAPIError.sessionChanged
            }
        }
        try requireSourceBinding()
        let requestLinkGeneration = linkGeneration
        let configuration = configurationStore.load()
        let baseURL = try Self.apiBaseURL(from: configuration.baseURL)
        var token = try await validToken(configuration: configuration, baseURL: baseURL)
        try requireSourceBinding()
        guard requestLinkGeneration == linkGeneration, currentLinkID == nil,
              configurationStore.load() == configuration, authSession?.accessToken == token else { throw WatchAPIError.sessionChanged }
        var result = try await send(
            body,
            path: path,
            baseURL: baseURL,
            token: token,
            method: method
        )
        if result.1.statusCode == 401 {
            guard requestLinkGeneration == linkGeneration, currentLinkID == nil,
                  configurationStore.load() == configuration, authSession?.accessToken == token else {
                throw WatchAPIError.sessionChanged
            }
            guard let current = authSession else { throw WatchAPIError.notLinked }
            token = try await refreshSingleFlight(current)
            try requireSourceBinding()
            guard requestLinkGeneration == linkGeneration, currentLinkID == nil,
                  configurationStore.load() == configuration, authSession?.accessToken == token else { throw WatchAPIError.sessionChanged }
            result = try await send(
                body,
                path: path,
                baseURL: baseURL,
                token: token,
                method: method
            )
        }
        guard requestLinkGeneration == linkGeneration, currentLinkID == nil,
                  configurationStore.load() == configuration, authSession?.accessToken == token else {
            throw WatchAPIError.sessionChanged
        }
        try requireSourceBinding()
        return result
    }

    private func validToken(
        configuration: WatchConfiguration,
        baseURL: URL
    ) async throws -> String {
        guard let session = authSession,
              session.baseURL == baseURL.absoluteString,
              session.deviceInstanceID == configuration.deviceInstanceID,
              session.companionPairID == configuration.companionPairID
        else {
            invalidateSession(clearPersisted: true)
            throw WatchAPIError.notLinked
        }
        guard session.expiresAt > now().addingTimeInterval(30) else {
            return try await refreshSingleFlight(session)
        }
        return session.accessToken
    }

    private func refreshSingleFlight(_ session: WatchAuthSession) async throws -> String {
        guard currentLinkID == nil else { throw WatchAPIError.sessionChanged }
        if let refreshTask, refreshTaskSession == session { return try await refreshTask.value.accessToken }
        let operationID = UUID()
        let task = Task<WatchAuthSession, Error> { [weak self] in
            guard let self else { throw WatchAPIError.notLinked }
            return try await self.performRefresh(session)
        }
        refreshTask = task
        refreshTaskID = operationID
        refreshTaskSession = session
        defer {
            if refreshTaskID == operationID { refreshTask = nil; refreshTaskID = nil; refreshTaskSession = nil }
        }
        return try await task.value.accessToken
    }

    private func performRefresh(_ session: WatchAuthSession) async throws -> WatchAuthSession {
        let baseURL = try Self.apiBaseURL(from: session.baseURL)
        let (data, response) = try await post(
            RefreshBody(refreshToken: session.refreshToken),
            path: "watch/session/refresh",
            baseURL: baseURL
        )
        let currentConfiguration = configurationStore.load()
        guard authSession == session,
              (try? Self.apiBaseURL(from: currentConfiguration.baseURL)) == baseURL,
              currentConfiguration.deviceInstanceID == session.deviceInstanceID,
              currentConfiguration.companionPairID == session.companionPairID
        else { throw WatchAPIError.sessionChanged }
        guard response.statusCode == 200 else {
            if [401, 403].contains(response.statusCode) { invalidateSession(clearPersisted: true) }
            throw WatchAPIError.rejected(response.statusCode)
        }
        let refreshed = try sessionFromResponse(
            data,
            baseURL: baseURL,
            deviceInstanceID: session.deviceInstanceID,
            companionPairID: session.companionPairID,
            companionLinkFingerprint: session.companionLinkFingerprint
        )
        guard session.userID.map({ $0 == refreshed.userID }) ?? true,
              session.accountID.map({ $0 == refreshed.accountID }) ?? true
        else { throw WatchAPIError.invalidResponse }
        do {
            try authSessionStore.saveAuthSession(refreshed)
        } catch {
            invalidateSession(clearPersisted: true)
            try? appAttestKeyStore.clearAppAttestKeyID()
            throw WatchAPIError.persistenceFailed
        }
        authSession = refreshed
        return refreshed
    }

    private func sessionFromResponse(
        _ data: Data,
        baseURL: URL,
        deviceInstanceID: String,
        companionPairID: String,
        companionLinkFingerprint: String? = nil
    ) throws -> WatchAuthSession {
        let response = try JSONDecoder.contractDecoder().decode(SessionResponse.self, from: data)
        guard !response.sessionToken.isEmpty,
              !response.refreshToken.isEmpty,
              !response.userId.isEmpty, !response.accountId.isEmpty,
              response.expiresAt > now()
        else {
            throw WatchAPIError.invalidResponse
        }
        return WatchAuthSession(
            accessToken: response.sessionToken,
            refreshToken: response.refreshToken,
            expiresAt: response.expiresAt,
            baseURL: baseURL.absoluteString,
            deviceInstanceID: deviceInstanceID,
            companionPairID: companionPairID,
            companionLinkFingerprint: companionLinkFingerprint,
            userID: response.userId, accountID: response.accountId
        )
    }

    private func post<Body: Encodable>(
        _ body: Body,
        path: String,
        baseURL: URL
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw WatchAPIError.invalidConfiguration
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder.contractEncoder().encode(body)
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw WatchAPIError.invalidResponse
        }
        return (data, response)
    }

    private func send<Body: Encodable>(
        _ body: Body?,
        path: String,
        baseURL: URL,
        token: String,
        method: String
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw WatchAPIError.invalidConfiguration
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try body.map { try JSONEncoder.contractEncoder().encode($0) }
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw WatchAPIError.invalidResponse
        }
        return (data, response)
    }

    private func invalidateSession(clearPersisted: Bool) {
        authSession = nil
        if clearPersisted { try? authSessionStore.clearAuthSession() }
    }

    private static func apiBaseURL(from input: String) throws -> URL {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            throw WatchAPIError.invalidConfiguration
        }
        if scheme == "http" {
            let host = components.host?.lowercased() ?? ""
            let isLoopback = ["localhost", "127.0.0.1", "::1"].contains(host)
            #if AEDRESPONSE_TEST_HOST
            let allowedForDevelopment = isLoopback
            #elseif DEBUG
            let allowedForDevelopment = isLoopback
            #else
            let allowedForDevelopment = false
            #endif
            guard allowedForDevelopment else {
                throw WatchAPIError.invalidConfiguration
            }
        }
        let path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard path.isEmpty || path == "api/v2" else {
            throw WatchAPIError.invalidConfiguration
        }
        components.path = "/api/v2/"
        guard let url = components.url else {
            throw WatchAPIError.invalidConfiguration
        }
        return url
    }
}
