import Foundation
import XCTest
@testable import AEDResponse

@MainActor
final class PushRegistrationTests: XCTestCase {
    private func token(_ value: String) -> PushTokenRequest {
        PushTokenRequest(pushToken: value, pushEnvironment: "SANDBOX", bundleId: "example.test")
    }

    func testTokenWaitsForAuthenticatedSessionAndIsNotUploadedTwice() async throws {
        let client = PushClientStub()
        let coordinator = PushRegistrationCoordinator()
        coordinator.receive(token("first"))
        XCTAssertTrue(client.tokens.isEmpty)
        coordinator.connect(client)
        try await wait { client.tokens.count == 1 }
        coordinator.receive(token("first"))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(client.tokens.map(\.pushToken), ["first"])
        coordinator.disconnect()
        coordinator.receive(token("rotated"))
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(client.tokens.count, 1)
        coordinator.connect(client)
        try await wait { client.tokens.count == 2 }
        XCTAssertEqual(client.tokens.last?.pushToken, "rotated")
    }

    func testRotationIsSerializedAndOldSessionCompletionIsIgnored() async throws {
        let client = PushClientStub()
        client.hold = true
        let coordinator = PushRegistrationCoordinator()
        coordinator.connect(client)
        coordinator.receive(token("first"))
        try await wait { client.continuation != nil }
        coordinator.receive(token("new"))
        XCTAssertEqual(client.tokens.count, 1)
        client.resume()
        try await wait { client.tokens.count == 2 }
        XCTAssertEqual(client.tokens.map(\.pushToken), ["first", "new"])
        coordinator.disconnect()
        let other = PushClientStub()
        coordinator.connect(other)
        try await wait { other.tokens.count == 1 }
        XCTAssertEqual(other.tokens.first?.pushToken, "new")
    }

    func testFailureRemainsRetryableAndDisconnectSuppressesLateErrors() async throws {
        let client = PushClientStub()
        client.fail = true
        let coordinator = PushRegistrationCoordinator()
        var failures = 0
        var successes = 0
        coordinator.onRegistered = { successes += 1 }
        coordinator.onFailure = { _ in failures += 1 }
        coordinator.connect(client)
        coordinator.receive(token("first"))
        try await wait { failures == 1 }
        XCTAssertEqual(successes, 0)
        client.fail = false
        coordinator.retry()
        try await wait { client.tokens.count == 2 && successes == 1 }
        client.hold = true
        coordinator.receive(token("late"))
        try await wait { client.continuation != nil }
        coordinator.disconnect()
        client.fail = true
        client.resume()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(failures, 1)
        XCTAssertEqual(successes, 1)
    }

    func testAPNsEnvironmentComesFromProfileNotBuildConfiguration() throws {
        for (raw, expected) in [("development", "SANDBOX"), ("production", "PRODUCTION")] {
            let plist = try PropertyListSerialization.data(fromPropertyList:
                ["Entitlements": ["aps-environment": raw]], format: .xml, options: 0)
            XCTAssertEqual(RemoteNotificationService.pushEnvironment(profile: Data([0, 1]) + plist + Data([0])), expected)
        }
        XCTAssertNil(RemoteNotificationService.pushEnvironment(profile: Data("invalid".utf8)))
        let missing = try PropertyListSerialization.data(fromPropertyList: ["Entitlements": [:]], format: .xml, options: 0)
        XCTAssertNil(RemoteNotificationService.pushEnvironment(profile: missing))
    }

    func testStoredTokenDoesNotClaimRemoteReadinessWithoutProviderConfiguration() async throws {
        let client = PushClientStub()
        client.configured = false
        let coordinator = PushRegistrationCoordinator()
        var failures = 0, successes = 0
        coordinator.onFailure = { _ in failures += 1 }
        coordinator.onRegistered = { successes += 1 }
        coordinator.connect(client)
        coordinator.receive(token("pending-provider"))
        try await wait { failures == 1 }
        XCTAssertEqual(successes, 0)
        client.configured = true
        coordinator.retry()
        try await wait { successes == 1 }
        XCTAssertEqual(client.tokens.count, 2)
    }

    private func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for push operation")
    }
}

@MainActor
private final class PushClientStub: PushAPIClient {
    var tokens: [PushTokenRequest] = []
    var hold = false
    var fail = false
    var configured = true
    var continuation: CheckedContinuation<Void, Never>?
    func registerPushToken(_ registration: PushTokenRequest) async throws -> PushRegistrationStatus {
        tokens.append(registration)
        if hold { await withCheckedContinuation { continuation = $0 } }
        if fail { throw URLError(.notConnectedToInternet) }
        return PushRegistrationStatus(providerConfigured: configured)
    }
    func notificationRoute(messageID: String) async throws -> PushNotificationRoute {
        PushNotificationRoute(messageId: messageID, eventId: nil, actionable: false)
    }
    func resume() {
        hold = false
        continuation?.resume()
        continuation = nil
    }
}
