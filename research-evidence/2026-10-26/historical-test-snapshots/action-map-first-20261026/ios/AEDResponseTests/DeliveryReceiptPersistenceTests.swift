import Foundation
import Security
import XCTest
@testable import AEDResponse

@MainActor
final class DeliveryReceiptPersistenceTests: XCTestCase {
    func testReceiptQueueRestoresAcrossCoordinatorAndAcknowledgesOnlyExactFact() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "aedresponse-delivery-receipts-\(UUID().uuidString)",
                isDirectory: true
            )
        let fileURL = directory.appendingPathComponent("receipts.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let context = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let delivered = PendingDeliveryReceipt(
            context: context,
            eventID: "event-1",
            deliveryID: "delivery-1",
            status: .delivered,
            occurredAt: Date(timeIntervalSince1970: 100)
        )
        let viewed = PendingDeliveryReceipt(
            context: context,
            eventID: "event-1",
            deliveryID: "delivery-1",
            status: .viewed,
            occurredAt: Date(timeIntervalSince1970: 101)
        )

        let first = DeliveryReceiptQueuePersistenceCoordinator(
            store: ProtectedDeliveryReceiptQueueStore(fileURL: fileURL)
        )
        XCTAssertTrue(first.load())
        XCTAssertTrue(first.append(delivered))
        XCTAssertTrue(first.append(viewed))

        first.reset()
        let reopened = DeliveryReceiptQueuePersistenceCoordinator(
            store: ProtectedDeliveryReceiptQueueStore(fileURL: fileURL)
        )
        XCTAssertTrue(reopened.load())
        XCTAssertEqual(reopened.pending(for: context), [delivered, viewed])
        XCTAssertTrue(reopened.acknowledge(delivered))
        XCTAssertEqual(reopened.pending(for: context), [viewed])

        reopened.reset()
        let afterAck = DeliveryReceiptQueuePersistenceCoordinator(
            store: ProtectedDeliveryReceiptQueueStore(fileURL: fileURL)
        )
        XCTAssertTrue(afterAck.load())
        XCTAssertEqual(afterAck.pending(for: context), [viewed])
    }

    func testReceiptQueueKeepsAccountsIsolatedAndDoesNotOverwriteCorruptFile() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "aedresponse-delivery-receipts-corrupt-\(UUID().uuidString)",
                isDirectory: true
            )
        let fileURL = directory.appendingPathComponent("receipts.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let accountA = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let accountB = DeliveryReceiptQueueContext(
            serviceNamespace: accountA.serviceNamespace,
            userID: "user-b",
            deviceInstanceID: "device-a"
        )
        let receipt = PendingDeliveryReceipt(
            context: accountA,
            eventID: "event-a",
            deliveryID: "delivery-a",
            status: .viewed,
            occurredAt: Date(timeIntervalSince1970: 200)
        )

        let coordinator = DeliveryReceiptQueuePersistenceCoordinator(
            store: ProtectedDeliveryReceiptQueueStore(fileURL: fileURL)
        )
        XCTAssertTrue(coordinator.load())
        XCTAssertTrue(coordinator.append(receipt))
        XCTAssertEqual(coordinator.pending(for: accountB), [])
        coordinator.reset()
        XCTAssertTrue(coordinator.load())
        XCTAssertEqual(coordinator.pending(for: accountA), [receipt])

        let corrupt = Data("corrupt receipt queue".utf8)
        try corrupt.write(to: fileURL, options: .atomic)
        coordinator.reset()
        XCTAssertFalse(coordinator.load())
        XCTAssertTrue(coordinator.isUnavailable)
        XCTAssertTrue(coordinator.isBlocked)
        XCTAssertEqual(try Data(contentsOf: fileURL), corrupt)
    }

    func testReceiptQueueRetainsFactWhenAcknowledgementPersistenceFails() {
        let store = FailingDeliveryReceiptStore()
        let coordinator = DeliveryReceiptQueuePersistenceCoordinator(store: store)
        let context = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let receipt = PendingDeliveryReceipt(
            context: context,
            eventID: "event-1",
            deliveryID: "delivery-1",
            status: .delivered,
            occurredAt: Date(timeIntervalSince1970: 300)
        )

        XCTAssertTrue(coordinator.load())
        XCTAssertTrue(coordinator.append(receipt))
        store.failSaves = true
        XCTAssertFalse(coordinator.acknowledge(receipt))
        XCTAssertTrue(coordinator.isBlocked)
        XCTAssertEqual(coordinator.pending(for: context), [])
        // A blocked owner exposes no writable queue; the store itself still
        // contains the unacknowledged fact for a later reload.
        XCTAssertEqual(store.records, [receipt])
    }

    func testLegacyQueueWithoutIsolationFieldStillLoads() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "aedresponse-delivery-receipts-legacy-\(UUID().uuidString)",
                isDirectory: true
            )
        let fileURL = directory.appendingPathComponent("receipts.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // A queue written before `blockedReason` existed. The newer decoder
        // must read the absent field as "not isolated" instead of failing, so a
        // rollback or an upgrade cannot strand already-queued receipts.
        let legacy = """
        [
          {
            "context": {
              "serviceNamespace": "https://api.example.test/api/v2/",
              "userID": "user-a",
              "deviceInstanceID": "device-a"
            },
            "eventID": "event-legacy",
            "deliveryID": "delivery-legacy",
            "status": "VIEWED",
            "occurredAt": "2026-08-31T01:02:00.000Z"
          }
        ]
        """
        try Data(legacy.utf8).write(to: fileURL, options: .atomic)

        let coordinator = DeliveryReceiptQueuePersistenceCoordinator(
            store: ProtectedDeliveryReceiptQueueStore(fileURL: fileURL)
        )
        XCTAssertTrue(coordinator.load())
        let context = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let pending = coordinator.pending(for: context)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending.first?.deliveryID, "delivery-legacy")
        XCTAssertNil(pending.first?.blockedReason)
        XCTAssertEqual(coordinator.isolated(for: context), [])
    }

    func testIsolatedReceiptStopsSendingWithoutBlockingLaterReceipts() {
        let store = MemoryDeliveryReceiptQueueStore()
        let coordinator = DeliveryReceiptQueuePersistenceCoordinator(store: store)
        let context = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let rejected = PendingDeliveryReceipt(
            context: context,
            eventID: "event-1",
            deliveryID: "delivery-rejected",
            status: .delivered,
            occurredAt: Date(timeIntervalSince1970: 500)
        )
        let following = PendingDeliveryReceipt(
            context: context,
            eventID: "event-1",
            deliveryID: "delivery-following",
            status: .viewed,
            occurredAt: Date(timeIntervalSince1970: 501)
        )

        XCTAssertTrue(coordinator.load())
        XCTAssertTrue(coordinator.append(rejected))
        XCTAssertTrue(coordinator.append(following))
        // The rejected fact is the queue head; before isolation it is the one
        // the drain loop would retry forever.
        XCTAssertEqual(coordinator.pending(for: context).first, rejected)

        XCTAssertTrue(coordinator.isolate(rejected, reason: "HTTP 403"))
        XCTAssertEqual(coordinator.pending(for: context), [following])
        XCTAssertEqual(coordinator.isolated(for: context).count, 1)
        XCTAssertEqual(coordinator.isolated(for: context).first?.blockedReason, "HTTP 403")
        XCTAssertFalse(coordinator.hasPending(deliveryID: rejected.deliveryID, context: context))
        XCTAssertTrue(coordinator.hasPending(deliveryID: following.deliveryID, context: context))

        // Isolation is durable: the fact is retained for reconciliation but is
        // never selected again after a reload.
        let expectedIsolated = coordinator.isolated(for: context)
        coordinator.reset()
        let reopened = DeliveryReceiptQueuePersistenceCoordinator(store: store)
        XCTAssertTrue(reopened.load())
        XCTAssertEqual(reopened.pending(for: context), [following])
        XCTAssertEqual(reopened.isolated(for: context), expectedIsolated)

        // Isolating twice is idempotent and keeps the original reason.
        XCTAssertTrue(reopened.isolate(rejected, reason: "HTTP 409"))
        XCTAssertEqual(reopened.isolated(for: context).first?.blockedReason, "HTTP 403")
    }

    func testBlockedAppendIsRetainedUntilTheQueueCanBeRecovered() {
        let store = FailingDeliveryReceiptStore()
        let coordinator = DeliveryReceiptQueuePersistenceCoordinator(store: store)
        let context = DeliveryReceiptQueueContext(
            serviceNamespace: "https://api.example.test/api/v2/",
            userID: "user-a",
            deviceInstanceID: "device-a"
        )
        let receipt = PendingDeliveryReceipt(
            context: context,
            eventID: "event-recovery",
            deliveryID: "delivery-recovery",
            status: .viewed,
            occurredAt: Date(timeIntervalSince1970: 400)
        )

        XCTAssertTrue(coordinator.load())
        store.failSaves = true
        XCTAssertFalse(coordinator.append(receipt))
        XCTAssertTrue(coordinator.isBlocked)
        XCTAssertEqual(coordinator.pending(for: context), [])
        XCTAssertEqual(store.records, [])

        store.failSaves = false
        XCTAssertTrue(coordinator.recover())
        XCTAssertFalse(coordinator.isBlocked)
        XCTAssertEqual(coordinator.pending(for: context), [receipt])
        XCTAssertEqual(store.records, [receipt])
    }
}

private final class FailingDeliveryReceiptStore: @unchecked Sendable, DeliveryReceiptQueuePersisting {
    private let lock = NSLock()
    private var storedRecords: [PendingDeliveryReceipt] = []
    var failSaves = false

    var records: [PendingDeliveryReceipt] {
        lock.lock()
        defer { lock.unlock() }
        return storedRecords
    }

    func load() throws -> [PendingDeliveryReceipt] {
        lock.lock()
        defer { lock.unlock() }
        return storedRecords
    }

    func save(_ records: [PendingDeliveryReceipt]) throws {
        lock.lock()
        defer { lock.unlock() }
        if failSaves {
            throw DeliveryReceiptQueuePersistenceError.writeFailed
        }
        storedRecords = records
    }
}


@MainActor
final class SessionRevocationRecoveryTests: XCTestCase {
    func testDeviceFailureRetriesWithoutRepeatingAcknowledgedAccountRevocation() async throws {
        let client = RetryLogoutClient()
        let recovery = SessionRevocationRecovery()
        recovery.enqueue(client, device: true, account: true)
        for _ in 0..<200 {
            if await client.deviceCount >= 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let device = await client.deviceCount
        let account = await client.accountCount
        XCTAssertEqual(device, 2)
        XCTAssertEqual(account, 1)
    }
}

private actor RetryLogoutClient: SessionLogoutClient {
    var deviceCount = 0
    var accountCount = 0
    func revokeDeviceSession() async throws {
        deviceCount += 1
        if deviceCount == 1 { throw URLError(.notConnectedToInternet) }
    }
    func revokeAccountSession() async throws { accountCount += 1 }
}


@MainActor
final class DurableRevocationTests: XCTestCase {
    func testKeychainIntentSurvivesStoreRecreationAndDrainsOnlyAfterAck() async throws {
        let name = "aed-revocation-test-" + UUID().uuidString
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                               kSecAttrService as String: name] as CFDictionary) }
        let store = KeychainSessionRevocationStore(service: name)
        let record = PendingSessionRevocation(id: UUID(), baseURL: "https://example.test/api/v2/",
            bearer: "synthetic-logout-only", isAccount: true)
        let first = DurableSessionRevocationRecovery(store: store, send: { _ in })
        try first.prepare([record])
        try first.prepare([record])
        let reopened = KeychainSessionRevocationStore(service: name)
        XCTAssertEqual(try reopened.loadRevocations(), [record])
        let second = DurableSessionRevocationRecovery(store: reopened, send: { value in
            XCTAssertEqual(value, record)
        })
        second.resume()
        for _ in 0..<100 {
            if try reopened.loadRevocations().isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(try reopened.loadRevocations().isEmpty)
    }

    func testAckStorageFailureRetainsLogoutCredential() async throws {
        let store = FailingRevocationStore()
        let record = PendingSessionRevocation(id: UUID(), baseURL: "https://example.test/api/v2/",
            bearer: "synthetic", isAccount: false)
        let recovery = DurableSessionRevocationRecovery(store: store, send: { _ in })
        try recovery.prepare([record])
        store.fail = true
        recovery.resume()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(try store.loadRevocations(), [record])
    }

    func testExpiredCredentialWaitsForOriginalAccountBeforeRecovery() async throws {
        let store = FailingRevocationStore()
        let probe = ReauthenticationProbe()
        let recovery = DurableSessionRevocationRecovery(store: store, send: { _ in
            await probe.rejectedSend()
            throw SessionRevocationFailure.reauthenticationRequired
        })
        var record = PendingSessionRevocation(id: UUID(), baseURL: "https://example.test/api/v2/",
            bearer: "old", isAccount: true)
        record.ownerUserID = "owner"
        record.requestedAt = Date(timeIntervalSince1970: 100)
        try recovery.prepare([record])
        recovery.recover = { _, session in
            XCTAssertEqual(session.userId, "owner")
            await probe.recovered()
        }
        recovery.resume()
        for _ in 0..<100 {
            if try store.loadRevocations().first?.requiresReauthentication == true { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(try store.loadRevocations().first?.requiresReauthentication, true)
        let wrong = AuthSession(accessToken: "wrong", refreshToken: "wrong-refresh", expiresAt: nil,
            userId: "other", method: .apple, serviceBaseURL: record.baseURL)
        recovery.currentSession = { wrong }
        try await Task.sleep(for: .milliseconds(1100))
        let wrongCount = await probe.recoveryCount
        XCTAssertEqual(wrongCount, 0)
        let owner = AuthSession(accessToken: "fresh", refreshToken: "fresh-refresh", expiresAt: nil,
            userId: "owner", method: .apple, serviceBaseURL: record.baseURL)
        recovery.currentSession = { owner }
        for _ in 0..<400 {
            if try store.loadRevocations().isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(try store.loadRevocations().isEmpty)
        let sends = await probe.sendCount
        let recovered = await probe.recoveryCount
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(recovered, 1)
    }

    func testCorruptKeychainIsNotOverwrittenByPrepare() throws {
        let name = "aed-revocation-corrupt-" + UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: name, kSecAttrAccount as String: "pending-session-revocations-v1"]
        defer { SecItemDelete(query as CFDictionary) }
        var item = query
        item[kSecValueData as String] = Data("invalid-json".utf8)
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        let store = KeychainSessionRevocationStore(service: name)
        let recovery = DurableSessionRevocationRecovery(store: store, send: { _ in })
        XCTAssertThrowsError(try recovery.prepare([]))
        XCTAssertThrowsError(try store.loadRevocations())
    }
}

private final class FailingRevocationStore: @unchecked Sendable, SessionRevocationPersisting {
    var fail = false
    private var records: [PendingSessionRevocation] = []
    func loadRevocations() throws -> [PendingSessionRevocation] { records }
    func saveRevocations(_ records: [PendingSessionRevocation]) throws {
        if fail { throw AuthError.persistenceFailed }
        self.records = records
    }
}

private actor ReauthenticationProbe {
    var sendCount = 0
    var recoveryCount = 0
    func rejectedSend() { sendCount += 1 }
    func recovered() { recoveryCount += 1 }
}
