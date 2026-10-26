import Foundation
import XCTest
#if canImport(AEDResponse)
@testable import AEDResponse
#else
@testable import AEDResponseEndLogic
#endif

@MainActor
final class EventEndCoordinatorTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_000_100.125456)
    private var context: EventEndContext {
        EventEndContext(serviceNamespace: "http://127.0.0.1/api/v2/", userID: "test-user",
            authenticationMethod: "PHONE", deviceID: "test-device", eventID: "test-event")
    }

    private func coordinator(_ store: any EventEndIntentPersisting, id: String = "resolution-one") -> EventEndCoordinator {
        EventEndCoordinator(persistence: store, makeID: { id }, now: { self.now })
    }

    private func event(_ state: EventState) -> EmergencyEvent {
        EmergencyEvent(id: context.eventID, state: state, recruitmentState: state == .resolved ? .completed : .stopped,
            canPublishEventPosition: false, triggerSource: nil, fallDetectedAt: nil, fallResolution: nil,
            callFirstObservedAt: nil, patientPosition: nil, patientLocationCard: nil, viewerRelationship: .neutral,
            coordination: nil, createdAt: now.addingTimeInterval(-30), resolvedAt: state.isTerminal ? now : nil,
            pendingResponseRequest: nil, currentAssignment: nil)
    }

    func testDiskRestartReusesIdentityAndCannotOverwriteOtherAccountIntents() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("intents.json")
        let first = coordinator(ProtectedEventEndIntentStore(fileURL: url))
        let intent = try first.prepare(context: context, actor: .patient, reason: .falseAlarm)
        let restored = coordinator(ProtectedEventEndIntentStore(fileURL: url), id: "different-id")
        XCTAssertEqual(try restored.prepare(context: context, actor: .patient, reason: .falseAlarm), intent)
        let other = EventEndContext(serviceNamespace: context.serviceNamespace, userID: "another-user",
            authenticationMethod: context.authenticationMethod, deviceID: context.deviceID, eventID: context.eventID)
        let another = try restored.prepare(context: other, actor: .patient, reason: .problemResolved)
        XCTAssertNotEqual(another.request.resolutionId, intent.request.resolutionId)
        XCTAssertEqual(try ProtectedEventEndIntentStore(fileURL: url).load().count, 2)
        XCTAssertThrowsError(try restored.prepare(context: context, actor: .patient, reason: .problemResolved))
        XCTAssertThrowsError(try ProtectedEventEndIntentStore(fileURL: url).save([:]))
    }

    func testTransientFailureRetainsExactIntentAndLaterSubmission() async throws {
        let storage = MemoryEventEndIntentStore()
        let subject = coordinator(storage)
        let intent = try subject.prepare(context: context, actor: .patient, reason: .problemResolved)
        let client = EndClient(active: event(.active), terminal: event(.resolved))
        await client.setFailure(.unexpectedStatus(503), commit: false)
        do { _ = try await subject.submit(intent, using: client, isCurrent: { true }); XCTFail("Expected unavailable response") }
        catch { XCTAssertEqual(error as? APIClientError, .unexpectedStatus(503)) }
        XCTAssertEqual(try subject.pending(context: context)?.request, intent.request)
        _ = try await subject.submit(intent, using: client, isCurrent: { true })
        let attempts = await client.requests
        XCTAssertEqual(attempts, [intent.request, intent.request])
        XCTAssertEqual(try storage.load()[context.key]?.phase, .terminalObserved)
    }

    func testLostResponseRecoversActualTerminalWithoutClaimingRequestedReason() async throws {
        let storage = MemoryEventEndIntentStore()
        let subject = coordinator(storage)
        let intent = try subject.prepare(context: context, actor: .patient, reason: .falseAlarm)
        let client = EndClient(active: event(.active), terminal: event(.closedUnconfirmedNoResponse))
        await client.setFailure(.unexpectedStatus(409), commit: true)
        let result = try await subject.submit(intent, using: client, isCurrent: { true })
        XCTAssertEqual(result?.event.state, .closedUnconfirmedNoResponse)
        XCTAssertEqual(try storage.load()[context.key]?.observedTerminalState, .closedUnconfirmedNoResponse)
        let count = await client.requests.count
        XCTAssertEqual(count, 1)
    }

    func testPermissionAndConflictPauseAutomaticRetriesWithoutDeletingIntents() async throws {
        for status in [403, 409] {
            let storage = MemoryEventEndIntentStore()
            let subject = coordinator(storage)
            let intent = try subject.prepare(context: context, actor: .patient, reason: .problemResolved)
            let client = EndClient(active: event(.active), terminal: event(.resolved))
            await client.setFailure(.unexpectedStatus(status), commit: false)
            do { _ = try await subject.submit(intent, using: client, isCurrent: { true }); XCTFail("Expected rejection") }
            catch { XCTAssertEqual(error as? APIClientError, .unexpectedStatus(status)) }
            XCTAssertNil(try subject.pending(context: context))
            XCTAssertEqual(try storage.load()[context.key]?.request, intent.request)
            XCTAssertEqual(try storage.load()[context.key]?.phase, .requiresAttention)
            XCTAssertEqual(try subject.prepare(context: context, actor: .patient, reason: .problemResolved).request, intent.request)
        }
    }

    func testOldGenerationAndConcurrentButtonsCannotPublishAnotherResult() async throws {
        let storage = MemoryEventEndIntentStore()
        let subject = coordinator(storage)
        let intent = try subject.prepare(context: context, actor: .patient, reason: .problemResolved)
        let client = EndClient(active: event(.active), terminal: event(.resolved))
        await client.suspendNextRequest()
        var current = true
        let pending = Task { try await subject.submit(intent, using: client, isCurrent: { current }) }
        for _ in 0..<200 {
            if await client.isSuspended { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let suspended = await client.isSuspended
        XCTAssertTrue(suspended)
        let duplicate = try await subject.submit(intent, using: client, isCurrent: { true })
        XCTAssertNil(duplicate)
        current = false
        subject.invalidateInFlight()
        await client.resume()
        do { _ = try await pending.value; XCTFail("Old generation must not return a projection") }
        catch { XCTAssertTrue(error is CancellationError) }
        let count = await client.requests.count
        XCTAssertEqual(count, 1)
        XCTAssertEqual(try storage.load()[context.key]?.phase, .pending)
    }

    func testPersistenceFailureStopsNewRequestButCannotHideKnownServerTerminal() async throws {
        let storage = FailingEndStore()
        let subject = coordinator(storage)
        storage.failSave = true
        XCTAssertThrowsError(try subject.prepare(context: context, actor: .patient, reason: .problemResolved))
        XCTAssertTrue(try storage.load().isEmpty)
        storage.failSave = false
        let intent = try subject.prepare(context: context, actor: .patient, reason: .problemResolved)
        storage.failSave = true
        let client = EndClient(active: event(.active), terminal: event(.resolved))
        let result = try await subject.submit(intent, using: client, isCurrent: { true })
        XCTAssertEqual(result?.event.state, .resolved)
        XCTAssertNotNil(result?.persistenceError)
        XCTAssertEqual(try storage.load()[context.key]?.phase, .pending)
    }

    func testCorruptJournalRemainsByteForByteIntact() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("intents.json")
        let bytes = Data("{damaged unconfirmed record".utf8)
        try bytes.write(to: url)
        let subject = coordinator(ProtectedEventEndIntentStore(fileURL: url))
        XCTAssertThrowsError(try subject.prepare(context: context, actor: .patient, reason: .problemResolved))
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }
}

@MainActor
private final class FailingEndStore: EventEndIntentPersisting {
    var failSave = false
    private let memory = MemoryEventEndIntentStore()
    func load() throws -> [String: EventEndIntent] { try memory.load() }
    func save(_ records: [String: EventEndIntent]) throws {
        if failSave { throw EventEndError.persistenceFailed }
        try memory.save(records)
    }
}

private actor EndClient: EventEndAPIClient {
    private let active: EmergencyEvent
    private let terminal: EmergencyEvent
    private var committed = false
    private var failure: APIClientError?
    private var commitOnFailure = false
    private var suspend = false
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var requests: [EventEndRequest] = []
    var isSuspended: Bool { continuation != nil }
    init(active: EmergencyEvent, terminal: EmergencyEvent) { self.active = active; self.terminal = terminal }
    func setFailure(_ error: APIClientError, commit: Bool) { failure = error; commitOnFailure = commit }
    func suspendNextRequest() { suspend = true }
    func resume() { continuation?.resume(); continuation = nil }
    func event(id: String) async throws -> EmergencyEvent { committed ? terminal : active }
    func submitEnd(eventID: String, request: EventEndRequest) async throws -> EmergencyEvent {
        requests.append(request)
        if let error = failure {
            failure = nil
            committed = commitOnFailure
            throw error
        }
        if suspend {
            suspend = false
            await withCheckedContinuation { continuation = $0 }
        }
        committed = true
        return terminal
    }
}
