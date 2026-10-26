import Foundation
import XCTest
@testable import AEDResponseWatchLogic

@MainActor
final class CompanionBackgroundMailboxTests: XCTestCase {
    func testPendingFallAndSimulationSkipIntroAcrossMailboxRestart() throws {
        for method in [CompanionRPCMethod.observation, .simulationObservation] {
            let disk = MailboxMemoryStore()
            let mailbox = CompanionBackgroundMailbox(persistence: disk)
            XCTAssertFalse(mailbox.hasPendingEmergencyWork)
            let fact = CompanionRelayObservation(binding: CompanionRelayReference(
                deviceInstanceId: UUID().uuidString, companionPairId: UUID().uuidString, bindingId: UUID().uuidString),
                observationData: Data("test-only-observation".utf8), digest: "test-only-digest")
            let message = try CompanionRPCRequest(method: method, body: fact)
            try mailbox.receive(message)
            XCTAssertTrue(mailbox.hasPendingEmergencyWork)
            let restarted = CompanionBackgroundMailbox(persistence: disk)
            XCTAssertTrue(restarted.hasPendingEmergencyWork)
            try restarted.recordResponse(CompanionRPCReply(request: message, status: .ok))
            XCTAssertTrue(restarted.hasPendingEmergencyWork, "A queued reply is still unfinished transport work")
            try restarted.responseTransferred(message.requestID)
            XCTAssertFalse(restarted.hasPendingEmergencyWork)
        }
    }

    func testPendingEventRecoveryAlsoSkipsIntro() throws {
        let mailbox = CompanionBackgroundMailbox(persistence: MailboxMemoryStore())
        let body = CompanionRelayEventRequest(binding: CompanionRelayReference(
            deviceInstanceId: UUID().uuidString, companionPairId: UUID().uuidString, bindingId: UUID().uuidString),
            eventId: UUID().uuidString)
        try mailbox.receive(CompanionRPCRequest(method: .eventState, body: body))
        XCTAssertTrue(mailbox.hasPendingEmergencyWork)
    }

    func testUnreadableOrUnwritableMailboxConservativelySkipsIntro() throws {
        let disk = MailboxMemoryStore()
        disk.failReads = true
        let unreadable = CompanionBackgroundMailbox(persistence: disk)
        XCTAssertTrue(unreadable.hasPendingEmergencyWork)
        disk.failReads = false
        let unwritable = CompanionBackgroundMailbox(persistence: disk)
        disk.failWrites = true
        XCTAssertThrowsError(try unwritable.receive(request()))
        XCTAssertTrue(unwritable.hasPendingEmergencyWork)
    }

    func testOrdinaryBindingQueueDoesNotPretendToBeEmergencyWork() throws {
        let mailbox = CompanionBackgroundMailbox(persistence: MailboxMemoryStore())
        try mailbox.receive(request())
        XCTAssertFalse(mailbox.hasPendingEmergencyWork)
    }

    private func request(_ index: Int = 1) throws -> CompanionRPCRequest {
        try CompanionRPCRequest(method: .bind, body: CompanionRelayBindRequest(
            deviceInstanceId: String(format: "00000000-0000-4000-8000-%012d", index),
            companionPairId: "REDACTED-SUPPLEMENT-ID-ceda2d1223b2"))
    }

    func testRetriesAndProcessRestartsKeepOriginalRequestIdentity() throws {
        let disk = MailboxMemoryStore()
        let first = CompanionBackgroundMailbox(persistence: disk)
        let original = try first.prepare(request())
        let duplicate = try first.prepare(request())
        XCTAssertEqual(original.requestID, duplicate.requestID)
        let restarted = CompanionBackgroundMailbox(persistence: disk)
        XCTAssertEqual(try restarted.prepare(request()).requestID, original.requestID)
        XCTAssertEqual(disk.snapshot.outgoing.count, 1)
    }

    func testQueuedTransportDoesNotProduceBusinessAcknowledgment() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        let request = try mailbox.prepare(request())
        XCTAssertTrue(try mailbox.shouldSubmit(request, now: Date(timeIntervalSince1970: 100)))
        XCTAssertNil(try mailbox.completedReply(for: request))
        XCTAssertTrue(mailbox.contains(request))
        XCTAssertFalse(try mailbox.shouldSubmit(request, now: Date(timeIntervalSince1970: 105)))
        XCTAssertTrue(try mailbox.shouldSubmit(request, now: Date(timeIntervalSince1970: 130)))
    }

    func testLateReplySurvivesRestartAndOnlyMatchesOriginalNonce() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        let original = try mailbox.prepare(request())
        let wrong = try CompanionRPCReply(request: request(2), body: CompanionRPCEmpty())
        XCTAssertFalse(try mailbox.receive(wrong))
        let reply = try CompanionRPCReply(request: original, body: CompanionRPCEmpty())
        XCTAssertTrue(try mailbox.receive(reply))
        let restarted = CompanionBackgroundMailbox(persistence: disk)
        let resumed = try restarted.prepare(request())
        XCTAssertEqual(try restarted.completedReply(for: resumed)?.requestID, original.requestID)
        XCTAssertFalse(restarted.contains(resumed))
        XCTAssertFalse(try restarted.receive(reply), "Duplicate/unknown ACK must not create a grant")
    }

    func testClockRollbackDoesNotFreezeBackgroundRetry() throws {
        let mailbox = CompanionBackgroundMailbox(persistence: MailboxMemoryStore())
        let request = try mailbox.prepare(request())
        XCTAssertTrue(try mailbox.shouldSubmit(request, now: Date(timeIntervalSince1970: 100)))
        XCTAssertTrue(try mailbox.shouldSubmit(request, now: Date(timeIntervalSince1970: 50)))
    }

    func testIncomingRequestIsDurableAndConflictingReuseIsRejected() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        let original = try request()
        try mailbox.receive(original)
        try mailbox.receive(original)
        var changed = try request(2).propertyList()
        changed["requestId"] = original.requestID
        XCTAssertThrowsError(try mailbox.receive(XCTUnwrap(CompanionRPCRequest(propertyList: changed))))
        let restarted = CompanionBackgroundMailbox(persistence: disk)
        XCTAssertEqual(restarted.incoming.count, 1)
        XCTAssertEqual(restarted.incoming.first?.request.payload, original.payload)
    }

    func testPhoneResponsePersistsUntilSystemTransferCompletes() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        let request = try request()
        try mailbox.receive(request)
        try mailbox.recordResponse(CompanionRPCReply(request: request, status: .bindingMismatch))
        let restarted = CompanionBackgroundMailbox(persistence: disk)
        XCTAssertEqual(restarted.incoming.first?.reply?.status, .bindingMismatch)
        try restarted.responseTransferred(request.requestID)
        XCTAssertTrue(restarted.incoming.isEmpty)
    }

    func testPersistenceFailureDoesNotAdvanceOrDiscardQueue() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        disk.failWrites = true
        let candidate = try request()
        XCTAssertThrowsError(try mailbox.prepare(candidate))
        XCTAssertFalse(mailbox.contains(candidate))
        disk.failWrites = false
        let accepted = try mailbox.prepare(candidate)
        XCTAssertTrue(try mailbox.receive(CompanionRPCReply(request: accepted, status: .ok)))
        disk.failWrites = true
        XCTAssertThrowsError(try mailbox.completedReply(for: accepted))
        XCTAssertTrue(mailbox.contains(accepted))
        disk.failWrites = false
        XCTAssertNotNil(try mailbox.completedReply(for: accepted))
    }

    func testUnreadableStorageIsNotAnEmptyQueueAndCanRecover() throws {
        let disk = MailboxMemoryStore()
        let original = try CompanionBackgroundMailbox(persistence: disk).prepare(request())
        disk.failReads = true
        let locked = CompanionBackgroundMailbox(persistence: disk)
        XCTAssertFalse(locked.readable)
        XCTAssertThrowsError(try locked.prepare(request()))
        disk.failReads = false
        XCTAssertEqual(try locked.prepare(request()).requestID, original.requestID)
    }

    func testLogoutControlRetiresOldRepliesAndCannotBeReversedByOldControl() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        let owner = CompanionServiceControl.owner(userID: "first", deviceID: "phone", pairID: "pair")
        let available = CompanionServiceControl(installationID: UUID().uuidString, revision: 1, owner: owner, authorized: true)
        XCTAssertTrue(try mailbox.receive(available))
        let request = try mailbox.prepare(request())
        let lateGrant = try CompanionRPCReply(request: request, body: CompanionRPCEmpty())
        XCTAssertTrue(try mailbox.receive(lateGrant))
        let logout = CompanionServiceControl(installationID: available.installationID, revision: 2, owner: owner, authorized: false)
        XCTAssertTrue(try mailbox.receive(logout))
        XCTAssertFalse(mailbox.contains(request))
        XCTAssertFalse(try mailbox.receive(lateGrant))
        XCTAssertFalse(try mailbox.receive(available))
        XCTAssertEqual(mailbox.peerControl?.authorized, false)
    }

    func testOwnerChangeClearsOldPhoneVerificationAndGrantReplies() throws {
        let mailbox = CompanionBackgroundMailbox(persistence: MailboxMemoryStore())
        let first = try mailbox.setLocalControl(owner: "first-owner", authorized: true)
        try mailbox.recordVerified(at: Date())
        let request = try request()
        try mailbox.receive(request)
        try mailbox.recordResponse(CompanionRPCReply(request: request, status: .ok))
        let next = try mailbox.setLocalControl(owner: "second-owner", authorized: true)
        XCTAssertGreaterThan(next.revision, first.revision)
        XCTAssertNil(mailbox.verifiedAt)
        XCTAssertNil(mailbox.incoming.first?.reply)
        XCTAssertEqual(try mailbox.setLocalControl(owner: "second-owner", authorized: true), next)
    }

    func testMailboxBoundRejectsOverflowWithoutTruncatingEvidence() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        for index in 1...128 { _ = try mailbox.prepare(request(index)) }
        XCTAssertThrowsError(try mailbox.prepare(request(129)))
        XCTAssertEqual(disk.snapshot.outgoing.count, 128)
    }

    func testTransientAppAttestTicketNeverEntersBackgroundMailbox() throws {
        let disk = MailboxMemoryStore()
        let mailbox = CompanionBackgroundMailbox(persistence: disk)
        let reference = CompanionRelayReference(deviceInstanceId: UUID().uuidString,
            companionPairId: UUID().uuidString, bindingId: UUID().uuidString)
        let ticket = try CompanionRPCRequest(method: .fallbackTicket, body: reference)
        _ = try mailbox.prepare(ticket)
        XCTAssertTrue(disk.snapshot.outgoing.isEmpty)
        XCTAssertThrowsError(try mailbox.receive(ticket))
        XCTAssertNil(CompanionBackgroundPacket.readRequest(CompanionBackgroundPacket.request(ticket)))
    }

    func testBackgroundPacketRejectsExtraKeys() throws {
        let request = try request()
        var packet = CompanionBackgroundPacket.request(request)
        packet["bearer"] = "must-not-cross"
        XCTAssertNil(CompanionBackgroundPacket.readRequest(packet))
        XCTAssertThrowsError(try CompanionRPCRequest(method: .context, body: ["token": "not-allowed"]))
    }

    func testProtectedFileRoundTripAndCorruptionPreservesOriginal() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("relay-mailbox-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("state.json")
        let disk = ProtectedCompanionMailboxStore(url: url)
        let original = try CompanionBackgroundMailbox(persistence: disk).prepare(request())
        XCTAssertEqual(try CompanionBackgroundMailbox(persistence: disk).prepare(request()).requestID, original.requestID)
        let invalid = Data("not-json".utf8)
        try invalid.write(to: url)
        let broken = CompanionBackgroundMailbox(persistence: disk)
        XCTAssertFalse(broken.readable)
        XCTAssertThrowsError(try broken.prepare(request()))
        XCTAssertEqual(try Data(contentsOf: url), invalid)
    }
}

private final class MailboxMemoryStore: CompanionMailboxPersisting, @unchecked Sendable {
    private let lock = NSLock()
    private var value = CompanionMailboxState()
    var failWrites = false
    var failReads = false
    var snapshot: CompanionMailboxState { lock.withLock { value } }
    func load() throws -> CompanionMailboxState {
        try lock.withLock {
            if failReads { throw CompanionRPCError.persistenceFailed }
            return value
        }
    }
    func save(_ state: CompanionMailboxState) throws {
        try lock.withLock {
            if failWrites { throw CompanionRPCError.persistenceFailed }
            value = state
        }
    }
}
