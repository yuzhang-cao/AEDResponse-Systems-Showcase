import Foundation
import XCTest
@testable import AEDResponse

@MainActor
final class AuthSessionRefreshCoordinatorTests: XCTestCase {
    private func session(_ token: String = "old", loginID: String = "login-one") -> AuthSession {
        AuthSession(accessToken: token, refreshToken: "refresh-\(token)",
                    expiresAt: Date(timeIntervalSince1970: 1_800_000_000), userId: "same-user",
                    method: .apple, serviceBaseURL: "https://example.test/api/v2/", loginID: loginID)
    }

    func testRotationIsPersistedBeforeReturningWithoutAnyUIObserver() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        let result = try await coordinator.refresh(previous) { _ in updated }
        XCTAssertEqual(result, updated)
        XCTAssertEqual(try store.loadRecoverable(), updated)
    }

    func testConcurrentClientsShareOneRotation() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        let probe = RefreshProbe(updated)
        let results = try await withThrowingTaskGroup(of: AuthSession.self) { group in
            for _ in 0..<12 {
                group.addTask { try await coordinator.refresh(previous) { try await probe.rotate($0) } }
            }
            var values: [AuthSession] = []
            for try await value in group { values.append(value) }
            return values
        }
        let count = await probe.count
        XCTAssertEqual(count, 1)
        XCTAssertEqual(results, Array(repeating: updated, count: 12))
    }

    func testReconnectWithOldSnapshotDoesNotReplayConsumedRefreshToken() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        _ = try await coordinator.refresh(previous) { _ in updated }
        let result = try await coordinator.refresh(previous) { _ in throw RefreshTestFailure.unexpectedNetwork }
        XCTAssertEqual(result, updated)
    }

    func testSaveFailureRetriesNewCredentialWithoutAnotherNetworkRotation() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        store.failNextWrite()
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        do {
            _ = try await coordinator.refresh(previous) { _ in updated }
            XCTFail("A failed durable commit must not look successful")
        } catch { XCTAssertEqual(error as? AuthError, .persistenceFailed) }
        XCTAssertEqual(try store.loadRecoverable(), previous)
        let result = try await coordinator.refresh(previous) { _ in throw RefreshTestFailure.unexpectedNetwork }
        XCTAssertEqual(result, updated)
        XCTAssertEqual(try store.loadRecoverable(), updated)
    }

    func testTemporarilyLockedStoreDoesNotDiscardCredentialsOrSendRefresh() async throws {
        let previous = session()
        let store = RefreshTestStore(previous)
        store.failNextRead()
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        do {
            _ = try await coordinator.refresh(previous) { _ in throw RefreshTestFailure.unexpectedNetwork }
            XCTFail("Protected storage must be readable first")
        } catch { XCTAssertEqual(error as? AuthError, .persistenceFailed) }
        XCTAssertEqual(try store.loadRecoverable(), previous)
    }

    func testTransportFailureKeepsStoredLoginForRetry() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        do {
            _ = try await coordinator.refresh(previous) { _ in throw URLError(.notConnectedToInternet) }
            XCTFail("Offline refresh must not claim success")
        } catch { XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet) }
        XCTAssertEqual(try store.loadRecoverable(), previous)
        let result = try await coordinator.refresh(previous) { _ in updated }
        XCTAssertEqual(result, updated)
    }

    func testLogoutRejectsLateRotationWithoutRestoringLogin() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        let probe = RefreshProbe(updated, blocked: true)
        let task = Task { try await coordinator.refresh(previous) { try await probe.rotate($0) } }
        try await waitUntilStarted(probe)
        store.suspendRefreshWrites()
        try store.clear()
        await probe.release()
        do { _ = try await task.value; XCTFail("Logout must win") }
        catch { XCTAssertEqual(error as? AuthError, .sessionSuperseded) }
        XCTAssertNil(try store.loadRecoverable())
    }

    func testLogoutIntentBlocksRotationEvenBeforeCredentialDeletion() async throws {
        let previous = session(), updated = session("new")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        let probe = RefreshProbe(updated, blocked: true)
        let task = Task { try await coordinator.refresh(previous) { try await probe.rotate($0) } }
        try await waitUntilStarted(probe)
        store.suspendRefreshWrites()
        await probe.release()
        do { _ = try await task.value; XCTFail("A durable logout intent must not be bypassed") }
        catch { XCTAssertEqual(error as? AuthError, .sessionSuperseded) }
        XCTAssertEqual(try store.loadRecoverable(), previous)
    }

    func testSameUserSigningInAgainRejectsPreviousLoginCompletion() async throws {
        let previous = session(), rotatedOld = session("old-rotated")
        let freshLogin = session("new-login", loginID: "login-two")
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        let probe = RefreshProbe(rotatedOld, blocked: true)
        let task = Task { try await coordinator.refresh(previous) { try await probe.rotate($0) } }
        try await waitUntilStarted(probe)
        try store.save(freshLogin)
        await probe.release()
        do { _ = try await task.value; XCTFail("Old login must not overwrite the fresh login") }
        catch { XCTAssertEqual(error as? AuthError, .sessionSuperseded) }
        XCTAssertEqual(try store.loadRecoverable(), freshLogin)
    }

    func testDifferentIdentityInRotationResponseIsRejected() async throws {
        let previous = session()
        let changed = AuthSession(accessToken: "different", refreshToken: "other", expiresAt: .distantFuture,
                                  userId: "other-user", method: .apple, serviceBaseURL: previous.serviceBaseURL,
                                  loginID: previous.loginID)
        let store = RefreshTestStore(previous)
        let coordinator = AuthSessionRefreshCoordinator(store: store)
        do {
            _ = try await coordinator.refresh(previous) { _ in changed }
            XCTFail("Refresh cannot change user identity")
        } catch { XCTAssertEqual(error as? AuthError, .invalidResponse) }
        XCTAssertEqual(try store.loadRecoverable(), previous)
    }

    func testRestartAfterTwoHoursUsesLastPersistedRefreshCredential() async throws {
        let previous = session(), first = session("first"), second = session("second")
        let store = RefreshTestStore(previous)
        let originalProcess = AuthSessionRefreshCoordinator(store: store)
        _ = try await originalProcess.refresh(previous) { _ in first }
        let afterTwoHours = first.expiresAt!.addingTimeInterval(7_200)
        let restored = try XCTUnwrap(store.loadRecoverable())
        XCTAssertLessThan(try XCTUnwrap(restored.expiresAt), afterTwoHours)
        let restartedProcess = AuthSessionRefreshCoordinator(store: store)
        let result = try await restartedProcess.refresh(restored) { candidate in
            guard candidate.refreshToken == first.refreshToken else { throw RefreshTestFailure.unexpectedNetwork }
            return second
        }
        XCTAssertEqual(result, second)
        XCTAssertEqual(try store.loadRecoverable(), second)
    }

    func testLegacySessionDecodesWithoutLoginIdentifierAndMigrationPreservesTokens() throws {
        let legacy = AuthSession(accessToken: "old", refreshToken: "refresh", expiresAt: .distantFuture,
                                 userId: "same-user", method: .apple, serviceBaseURL: "https://example.test/api/v2/")
        let data = try JSONEncoder().encode(legacy)
        let decoded = try JSONDecoder().decode(AuthSession.self, from: data)
        XCTAssertNil(decoded.loginID)
        let identified = decoded.identifyingLogin("migrated-login")
        XCTAssertEqual(identified.accessToken, decoded.accessToken)
        XCTAssertEqual(identified.refreshToken, decoded.refreshToken)
        XCTAssertEqual(identified.replacing(serviceBaseURL: decoded.serviceBaseURL).loginID, "migrated-login")
    }

    private func waitUntilStarted(_ probe: RefreshProbe) async throws {
        for _ in 0..<200 {
            if await probe.isBlocked { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("Rotation did not enter the controlled wait")
    }
}

private enum RefreshTestFailure: Error { case unexpectedNetwork }

private actor RefreshProbe {
    private let result: AuthSession
    private let blocked: Bool
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var count = 0
    var isBlocked: Bool { continuation != nil }
    init(_ result: AuthSession, blocked: Bool = false) { self.result = result; self.blocked = blocked }
    func rotate(_ previous: AuthSession) async throws -> AuthSession {
        count += 1
        if blocked { await withCheckedContinuation { continuation = $0 } }
        else { try await Task.sleep(for: .milliseconds(20)) }
        return result
    }
    func release() { continuation?.resume(); continuation = nil }
}

private final class RefreshTestStore: @unchecked Sendable, AuthSessionPersisting {
    private let lock = NSLock()
    private var session: AuthSession?
    private var readFailures = 0
    private var writeFailures = 0
    private var writesAllowed = true
    init(_ session: AuthSession) { self.session = session }
    func load() -> AuthSession? { try? loadRecoverable() }
    func loadRecoverable() throws -> AuthSession? {
        try lock.withLock {
            if readFailures > 0 { readFailures -= 1; throw AuthError.persistenceFailed }
            return session
        }
    }
    func save(_ session: AuthSession) throws { lock.withLock { self.session = session; writesAllowed = true } }
    func clear() throws { lock.withLock { session = nil } }
    func suspendRefreshWrites() { lock.withLock { writesAllowed = false } }
    func failNextRead() { lock.withLock { readFailures += 1 } }
    func failNextWrite() { lock.withLock { writeFailures += 1 } }
    func replace(_ updated: AuthSession, ifMatching previous: AuthSession) throws -> Bool {
        try lock.withLock {
            guard writesAllowed else { return false }
            if writeFailures > 0 { writeFailures -= 1; throw AuthError.persistenceFailed }
            if session == updated { return true }
            guard session == previous else { return false }
            session = updated
            return true
        }
    }
}
