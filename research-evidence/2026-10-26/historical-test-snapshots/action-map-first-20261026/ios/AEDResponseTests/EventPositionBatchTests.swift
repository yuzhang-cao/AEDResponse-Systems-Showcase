import Foundation
import XCTest
@testable import AEDResponse

final class EventPositionBatchTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_000_000)

    func testNoNewFixNeverEncodesAStalePosition() throws {
        let record = try EventPositionRecord.noNewFix(
            recordID: "record-1",
            slotAt: now,
            gapReason: .noFix
        )
        let data = try JSONEncoder.contractEncoder().encode(record)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["gapReason", "recordId", "slotAt", "status"])
        XCTAssertEqual(object["status"] as? String, "NO_NEW_FIX")
        XCTAssertNil(object["position"])
        XCTAssertNil(object["fixObservedAt"])
        XCTAssertEqual(object["gapReason"] as? String, "NO_FIX")
    }

    func testFixEncodesSlotAndActualInSlotFixTime() throws {
        let position = try PatientPosition(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8
        )
        let record = try EventPositionRecord.fix(
            recordID: "record-fix",
            slotAt: now,
            fixObservedAt: now.addingTimeInterval(0.75),
            position: .patient(position)
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: JSONEncoder.contractEncoder().encode(record)
            ) as? [String: Any]
        )
        XCTAssertEqual(
            Set(object.keys),
            ["fixObservedAt", "position", "recordId", "slotAt", "status"]
        )
        XCTAssertEqual(object["status"] as? String, "FIX")
        XCTAssertEqual(object["fixObservedAt"] as? String, "2026-08-29T10:40:00.750Z")
        XCTAssertNil(object["gapReason"])
        let decoded = try JSONDecoder.contractDecoder().decode(EventPositionRecord.self, from: JSONEncoder.contractEncoder().encode(record))
        XCTAssertEqual(decoded.slotAt, now)
        XCTAssertEqual(decoded.fixObservedAt, now.addingTimeInterval(0.75))
    }

    func testContractEncoderTruncatesSubmillisecondsWithoutCrossingSlotBoundary() throws {
        let position = try PatientPosition(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8
        )
        for fraction in [0.9995, 0.9996] {
            let record = try EventPositionRecord.fix(
                recordID: "record-fix-\(fraction)",
                slotAt: now,
                fixObservedAt: now.addingTimeInterval(fraction),
                position: .patient(position)
            )
            let data = try JSONEncoder.contractEncoder().encode(record)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: data) as? [String: Any]
            )
            XCTAssertEqual(object["fixObservedAt"] as? String, "2026-08-29T10:40:00.999Z")
            let decoded = try JSONDecoder.contractDecoder().decode(
                EventPositionRecord.self,
                from: data
            )
            XCTAssertEqual(decoded.slotAt, now)
            let decodedFixObservedAt = try XCTUnwrap(decoded.fixObservedAt)
            // The wire string above is the exact millisecond contract. Date
            // uses binary floating point, so compare the decoded instant with
            // sub-millisecond tolerance instead of bit-for-bit equality.
            XCTAssertEqual(
                decodedFixObservedAt.timeIntervalSince1970,
                now.addingTimeInterval(0.999).timeIntervalSince1970,
                accuracy: 0.000_001
            )
            XCTAssertLessThan(decodedFixObservedAt, now.addingTimeInterval(1))
        }
    }

    func testFixOutsideItsUTCSecondIsRejected() throws {
        let position = try PatientPosition(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8
        )
        XCTAssertThrowsError(try EventPositionRecord.fix(
            recordID: "record-fix-outside",
            slotAt: now,
            fixObservedAt: now.addingTimeInterval(1),
            position: .patient(position)
        )) { error in
            XCTAssertEqual(
                error as? EventPositionBatchValidationError,
                .fixObservedAtOutsideSlot
            )
        }
    }

    func testSlotMustBeAnExactUTCSecond() throws {
        XCTAssertThrowsError(try EventPositionRecord.noNewFix(
            recordID: "record-fractional-slot",
            slotAt: now.addingTimeInterval(0.001),
            gapReason: .noFix
        )) { error in
            XCTAssertEqual(error as? EventPositionBatchValidationError, .invalidSlot)
        }
    }

    func testRecordUnionRejectsForbiddenFieldsAndUnknownFields() throws {
        let forbidden = """
        {"recordId":"record-1","slotAt":"2026-08-29T10:40:00.000Z","status":"NO_NEW_FIX","gapReason":"NO_FIX","position":{"kind":"P","latitude":22.1,"longitude":113.5,"accuracyMeters":8}}
        """
        XCTAssertThrowsError(
            try JSONDecoder.contractDecoder().decode(
                EventPositionRecord.self,
                from: Data(forbidden.utf8)
            )
        )
        let unknown = """
        {"recordId":"record-1","slotAt":"2026-08-29T10:40:00.000Z","status":"NO_NEW_FIX","gapReason":"NO_FIX","patientPosition":null}
        """
        XCTAssertThrowsError(
            try JSONDecoder.contractDecoder().decode(
                EventPositionRecord.self,
                from: Data(unknown.utf8)
            )
        )
    }

    func testEventBatchRejectsMoreThanFiveRecordsAndDuplicateIDs() throws {
        let records = try (0..<5).map { index in
            try EventPositionRecord.noNewFix(
                recordID: "record-\(index)",
                slotAt: now.addingTimeInterval(TimeInterval(index)),
                gapReason: .noFix
            )
        }
        XCTAssertNoThrow(try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-1",
            records: records
        ))
        XCTAssertThrowsError(try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-1",
            records: records + [try EventPositionRecord.noNewFix(
                recordID: "record-5",
                slotAt: now.addingTimeInterval(5),
                gapReason: .noFix
            )]
        )) { error in
            XCTAssertEqual(error as? EventPositionBatchValidationError, .invalidRecordCount)
        }
        XCTAssertThrowsError(try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-1",
            records: [records[0], records[0]]
        )) { error in
            XCTAssertEqual(error as? EventPositionBatchValidationError, .duplicateRecordID)
        }
        XCTAssertThrowsError(try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-1",
            records: [
                records[0],
                try EventPositionRecord.noNewFix(
                    recordID: "record-same-slot",
                    slotAt: records[0].slotAt,
                    gapReason: .noFix
                )
            ]
        )) { error in
            XCTAssertEqual(error as? EventPositionBatchValidationError, .duplicateSlot)
        }
        XCTAssertThrowsError(try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-gap",
            records: [
                records[0],
                try EventPositionRecord.noNewFix(
                    recordID: "record-gap",
                    slotAt: now.addingTimeInterval(2),
                    gapReason: .noFix
                )
            ]
        )) { error in
            XCTAssertEqual(error as? EventPositionBatchValidationError, .nonContiguousSlots)
        }
        XCTAssertThrowsError(try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-reversed",
            records: [records[1], records[0]]
        )) { error in
            XCTAssertEqual(error as? EventPositionBatchValidationError, .nonContiguousSlots)
        }
    }

    func testAPIClientUsesExactEventPositionBatchEndpointAndBody() async throws {
        let fixedNow = now
        let batchID = "REDACTED-SUPPLEMENT-ID-16fcf7083963"
        let eventID = "REDACTED-SUPPLEMENT-ID-1e9aaf3e8363"
        let recordID = "REDACTED-SUPPLEMENT-ID-569a69fa206b"
        let record = try EventPositionRecord.noNewFix(
            recordID: recordID,
            slotAt: now,
            gapReason: .noFix
        )
        let batch = try EventPositionBatch(eventId: eventID, batchId: batchID, records: [record])
        let formatter = ISO8601DateFormatter()
        let responseBody = """
        {"schemaVersion":"2.0","eventId":"\(eventID)","batchId":"\(batchID)","acceptedRecordCount":1,"idempotent":false,"acknowledgedAt":"\(formatter.string(from: now))","records":[{"recordId":"\(recordID)","persisted":true,"appliedToLatest":false,"ignoredAsStale":false,"serverReceivedAt":"\(formatter.string(from: now))"}]}
        """
        let transport = EventBatchTransport(
            responses: [
                .init(statusCode: 201, body: """
                {"sessionId":"REDACTED-SUPPLEMENT-ID-f1e06336fd0a","sessionToken":"device-token","expiresAt":"\(formatter.string(from: now.addingTimeInterval(3600)))","scopes":["position:write"]}
                """),
                .init(statusCode: 200, body: responseBody)
            ]
        )
        let client = APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { fixedNow },
            authSession: AuthSession(
                accessToken: "account-token",
                refreshToken: "account-refresh",
                expiresAt: now.addingTimeInterval(3600),
                userId: "user-1",
                method: .apple,
                serviceBaseURL: "https://example.test/api/v2/"
            )
        )

        _ = try await client.bootstrapSession(request: DeviceSessionBootstrapRequest(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-5ac7b016d3bf",
            deviceKind: .iPhone,
            companionPairId: "REDACTED-SUPPLEMENT-ID-b7ff69fb7469",
            agreementAcceptances: nil
        ))
        let ack = try await client.sendEventPositionBatch(
            eventID: eventID,
            batchID: batchID,
            batch: batch
        )
        XCTAssertTrue(ack.validates(request: batch))

        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.path), [
            "/api/v2/session/bootstrap",
            "/api/v2/events/\(eventID)/position-batches/\(batchID)"
        ])
        XCTAssertEqual(requests[1].authorization, "Bearer [REDACTED]")
        let body = try XCTUnwrap(requests[1].jsonBody)
        XCTAssertEqual(Set(body.keys), ["batchId", "eventId", "records", "schemaVersion"])
        XCTAssertEqual(body["eventId"] as? String, eventID)
        let encodedRecord = try XCTUnwrap((body["records"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(encodedRecord.keys), ["gapReason", "recordId", "slotAt", "status"])
        XCTAssertEqual(encodedRecord["status"] as? String, "NO_NEW_FIX")
        XCTAssertEqual(encodedRecord["gapReason"] as? String, "NO_FIX")
    }

    func testBatchAckAcceptsServerObservedAtOrdering() throws {
        let first = try EventPositionRecord.noNewFix(
            recordID: "record-1",
            slotAt: now,
            gapReason: .noFix
        )
        let second = try EventPositionRecord.noNewFix(
            recordID: "record-2",
            slotAt: now.addingTimeInterval(1),
            gapReason: .noFix
        )
        let batch = try EventPositionBatch(
            eventId: "event-1",
            batchId: "batch-1",
            records: [first, second]
        )
        let ack = EventPositionBatchAck(
            schemaVersion: "2.0",
            eventId: "event-1",
            batchId: "batch-1",
            acceptedRecordCount: 2,
            idempotent: false,
            acknowledgedAt: now,
            records: [
                EventPositionRecordAck(
                    recordId: second.recordId,
                    persisted: true,
                    appliedToLatest: false,
                    ignoredAsStale: false,
                    serverReceivedAt: now
                ),
                EventPositionRecordAck(
                    recordId: first.recordId,
                    persisted: true,
                    appliedToLatest: false,
                    ignoredAsStale: false,
                    serverReceivedAt: now
                )
            ]
        )
        XCTAssertTrue(ack.validates(request: batch))
    }

    func testAPIClientPostsContinueStatusConfirmationContract() async throws {
        let fixedNow = now
        let confirmationID = "REDACTED-SUPPLEMENT-ID-d00c4a6d44de"
        let eventID = "REDACTED-SUPPLEMENT-ID-aede87316c49"
        let formatter = ISO8601DateFormatter()
        let transport = EventBatchTransport(responses: [
            .init(statusCode: 201, body: """
            {"sessionId":"REDACTED-SUPPLEMENT-ID-5ba773ae78d4","sessionToken":"device-token","expiresAt":"\(formatter.string(from: now.addingTimeInterval(3600)))","scopes":["events:write"]}
            """),
            .init(statusCode: 200, body: """
            {"confirmationId":"\(confirmationID)","response":"CONTINUE","respondedAt":"\(formatter.string(from: now))","nextCheckAt":"\(formatter.string(from: now.addingTimeInterval(1800)))","idempotent":false}
            """)
        ])
        let client = APIClient(
            configuration: try APIConfiguration(userEnteredURL: "https://example.test"),
            transport: transport,
            now: { fixedNow },
            authSession: AuthSession(
                accessToken: "account-token",
                refreshToken: "account-refresh",
                expiresAt: now.addingTimeInterval(3600),
                userId: "user-1",
                method: .apple,
                serviceBaseURL: "https://example.test/api/v2/"
            )
        )
        _ = try await client.bootstrapSession(request: DeviceSessionBootstrapRequest(
            deviceInstanceId: "REDACTED-SUPPLEMENT-ID-6fa81791370f",
            deviceKind: .iPhone,
            companionPairId: nil,
            agreementAcceptances: nil
        ))

        let result = try await client.continueStatusConfirmation(
            eventID: eventID,
            confirmationID: confirmationID,
            respondedAt: now
        )
        XCTAssertEqual(result.response, .continueRescue)
        let requests = await transport.requests()
        XCTAssertEqual(requests.last?.path,
                       "/api/v2/events/\(eventID)/status-confirmation")
        XCTAssertEqual(requests.last?.jsonBody?["confirmationId"] as? String, confirmationID)
        XCTAssertEqual(requests.last?.jsonBody?["response"] as? String, "CONTINUE")
    }

    func testProtectedQueuePreservesAllUnacknowledgedBatchesAndCorruption() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("aedresponse-event-position-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("queue.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ProtectedEventPositionQueueStore(fileURL: fileURL)
        let records = try (0..<6).map { index in
            try EventPositionRecord.noNewFix(
                recordID: "record-\(index)",
                slotAt: now.addingTimeInterval(TimeInterval(index)),
                gapReason: .noFix
            )
        }
        let batches = try (0..<6).map { index in
            try PersistedEventPositionBatch(
                serviceNamespace: "https://example.test/api/v2/",
                userId: "user-1",
                deviceInstanceId: "device-1",
                eventId: "event-\(index)",
                role: .patient,
                generation: index + 1,
                windowStartedAt: now,
                batch: try EventPositionBatch(
                    eventId: "event-\(index)",
                    batchId: "batch-\(index)",
                    records: [records[index]]
                )
            )
        }
        try store.save(EventPositionQueueState(pendingBatches: batches))
        XCTAssertEqual(try store.load().pendingBatches.count, 6)

        try Data("corrupt".utf8).write(to: fileURL, options: [.atomic])
        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? EventPositionQueuePersistenceError, .corrupted)
        }
        XCTAssertEqual(try Data(contentsOf: fileURL), Data("corrupt".utf8))
    }

    func testPersistedBatchCarriesIdentityEventRoleAndGenerationIsolation() throws {
        let patientRecord = try EventPositionRecord.noNewFix(
            recordID: "record-patient",
            slotAt: now,
            gapReason: .noFix
        )
        let responderRecord = try EventPositionRecord.noNewFix(
            recordID: "record-responder",
            slotAt: now,
            gapReason: .noFix
        )
        let patient = try PersistedEventPositionBatch(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-a",
            deviceInstanceId: "device-a",
            eventId: "event-a",
            role: .patient,
            generation: 1,
            windowStartedAt: now,
            batch: try EventPositionBatch(
                eventId: "event-a",
                batchId: "batch-patient",
                records: [patientRecord]
            )
        )
        let responder = try PersistedEventPositionBatch(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-b",
            deviceInstanceId: "device-b",
            eventId: "event-b",
            role: .responder,
            generation: 2,
            windowStartedAt: now,
            batch: try EventPositionBatch(
                eventId: "event-b",
                batchId: "batch-responder",
                records: [responderRecord]
            )
        )
        let state = EventPositionQueueState(pendingBatches: [patient, responder])
        let roundTrip = try JSONDecoder.contractDecoder().decode(
            EventPositionQueueState.self,
            from: JSONEncoder.contractEncoder().encode(state)
        )
        XCTAssertEqual(roundTrip.pendingBatches, [patient, responder])
        XCTAssertEqual(roundTrip.pendingBatches.first?.serviceNamespace, "https://example.test/api/v2/")
        XCTAssertEqual(roundTrip.pendingBatches.first?.role, .patient)
        XCTAssertEqual(roundTrip.pendingBatches.last?.generation, 2)
    }

    func testOpenDraftPersistsClockedSlotsAndLatestCandidateByIssuer() throws {
        let candidate = DeviceCoordinate(
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 8,
            observedAt: now.addingTimeInterval(0.8)
        )
        let namespace = "https://example.test/api/v2/"
        let key = "\(namespace)|user-a|device-a|P|event-a"
        let draft = try EventPositionOpenDraft(
            serviceNamespace: namespace,
            userId: "user-a",
            deviceInstanceId: "device-a",
            eventId: "event-a",
            role: .patient,
            generation: 3,
            openSlots: [now],
            clockedSlots: [now],
            candidates: [EventPositionSlotCandidate(slotAt: now, coordinate: candidate)]
        )
        let state = EventPositionQueueState(openDraftsByContext: [key: draft])
        let roundTrip = try JSONDecoder.contractDecoder().decode(
            EventPositionQueueState.self,
            from: JSONEncoder.contractEncoder().encode(state)
        )
        XCTAssertEqual(roundTrip.openDraftsByContext[key], draft)
        XCTAssertEqual(roundTrip.openDraftsByContext[key]?.clockedSlots, [now])
        XCTAssertEqual(
            roundTrip.openDraftsByContext[key]?.candidates.first?.coordinate.observedAt,
            candidate.observedAt
        )
    }

    func testQueueRoundTripPreservesGapClassificationAndQuarantinedImmutableRecord() throws {
        let record = try EventPositionRecord.noNewFix(
            recordID: "record-quarantined",
            slotAt: now,
            gapReason: .noFix
        )
        let evidence = QuarantinedEventPositionEvidence(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-a",
            deviceInstanceId: "device-a",
            eventId: "event-a",
            role: .patient,
            generation: 3,
            originalBatchId: "batch-original",
            slotAt: now,
            record: record,
            coordinate: nil,
            wasClocked: true,
            reason: .participationEnded,
            quarantinedAt: now.addingTimeInterval(10)
        )
        let draft = try EventPositionOpenDraft(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-a",
            deviceInstanceId: "device-a",
            eventId: "event-a",
            role: .patient,
            generation: 3,
            openSlots: [now.addingTimeInterval(1)],
            clockedSlots: [now.addingTimeInterval(1)],
            appNotRunningSlots: [now.addingTimeInterval(1)],
            candidates: []
        )
        let state = EventPositionQueueState(
            openDraftsByContext: ["context": draft],
            quarantinedEvidence: [evidence]
        )
        let roundTrip = try JSONDecoder.contractDecoder().decode(
            EventPositionQueueState.self,
            from: JSONEncoder.contractEncoder().encode(state)
        )
        XCTAssertEqual(roundTrip.openDraftsByContext["context"]?.appNotRunningSlots,
                       [now.addingTimeInterval(1)])
        XCTAssertEqual(roundTrip.quarantinedEvidence, [evidence])
    }

    func testProtectedQueueRejectsRemovalOrRewriteOfQuarantinedEvidence() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("aedresponse-quarantine-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("queue.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ProtectedEventPositionQueueStore(fileURL: fileURL)
        let record = try EventPositionRecord.noNewFix(
            recordID: "record-quarantined",
            slotAt: now,
            gapReason: .noFix
        )
        let evidence = QuarantinedEventPositionEvidence(
            serviceNamespace: "https://example.test/api/v2/",
            userId: "user-a",
            deviceInstanceId: "device-a",
            eventId: "event-a",
            role: .patient,
            generation: 1,
            originalBatchId: "batch-original",
            slotAt: now,
            record: record,
            coordinate: nil,
            wasClocked: true,
            reason: .participationEnded,
            quarantinedAt: now.addingTimeInterval(1)
        )
        try store.save(EventPositionQueueState(quarantinedEvidence: [evidence]))
        let secondRecord = try EventPositionRecord.noNewFix(
            recordID: "record-quarantined-2",
            slotAt: now.addingTimeInterval(1),
            gapReason: .appNotRunning
        )
        let secondEvidence = QuarantinedEventPositionEvidence(
            serviceNamespace: evidence.serviceNamespace,
            userId: evidence.userId,
            deviceInstanceId: evidence.deviceInstanceId,
            eventId: evidence.eventId,
            role: evidence.role,
            generation: evidence.generation,
            originalBatchId: "batch-original-2",
            slotAt: secondRecord.slotAt,
            record: secondRecord,
            coordinate: nil,
            wasClocked: true,
            reason: .participationEnded,
            quarantinedAt: now.addingTimeInterval(2)
        )
        XCTAssertNoThrow(try store.save(EventPositionQueueState(
            quarantinedEvidence: [evidence, secondEvidence]
        )))

        XCTAssertThrowsError(try store.save(EventPositionQueueState())) { error in
            XCTAssertEqual(error as? EventPositionQueuePersistenceError, .appendOnlyViolation)
        }
        let rewritten = QuarantinedEventPositionEvidence(
            serviceNamespace: evidence.serviceNamespace,
            userId: evidence.userId,
            deviceInstanceId: evidence.deviceInstanceId,
            eventId: evidence.eventId,
            role: evidence.role,
            generation: evidence.generation,
            originalBatchId: evidence.originalBatchId,
            slotAt: evidence.slotAt,
            record: evidence.record,
            coordinate: evidence.coordinate,
            wasClocked: evidence.wasClocked,
            reason: .beforeParticipationStart,
            quarantinedAt: evidence.quarantinedAt
        )
        XCTAssertThrowsError(try store.save(
            EventPositionQueueState(quarantinedEvidence: [rewritten, secondEvidence])
        )) { error in
            XCTAssertEqual(error as? EventPositionQueuePersistenceError, .appendOnlyViolation)
        }
        XCTAssertEqual(try store.load().quarantinedEvidence, [evidence, secondEvidence])
    }
}

final class MemoryEventPositionQueueStore: @unchecked Sendable, EventPositionQueuePersisting {
    private let lock = NSLock()
    private var state: EventPositionQueueState
    private var shouldFailLoad = false
    private var shouldFailSave = false

    init(state: EventPositionQueueState = EventPositionQueueState()) {
        self.state = state
    }

    func load() throws -> EventPositionQueueState {
        lock.lock()
        defer { lock.unlock() }
        if shouldFailLoad { throw EventPositionQueuePersistenceError.readFailed }
        return state
    }

    func save(_ state: EventPositionQueueState) throws {
        lock.lock()
        defer { lock.unlock() }
        if shouldFailSave { throw EventPositionQueuePersistenceError.writeFailed }
        self.state = state
    }

    func setFailLoad(_ value: Bool) {
        lock.lock()
        shouldFailLoad = value
        lock.unlock()
    }

    func setFailSave(_ value: Bool) {
        lock.lock()
        shouldFailSave = value
        lock.unlock()
    }
}

private actor EventBatchTransport: APIHTTPTransport {
    struct Response: Sendable {
        let statusCode: Int
        let body: Data

        init(statusCode: Int, body: String) {
            self.statusCode = statusCode
            self.body = Data(body.utf8)
        }
    }

    struct Request: Sendable {
        let path: String
        let authorization: String?
        let body: Data?

        var jsonBody: [String: Any]? {
            guard let body,
                  let object = try? JSONSerialization.jsonObject(with: body)
            else { return nil }
            return object as? [String: Any]
        }
    }

    private var responses: [Response]
    private var recordedRequests: [Request] = []

    init(responses: [Response]) {
        self.responses = responses
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        recordedRequests.append(
            Request(
                path: request.url?.path ?? "",
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                body: request.httpBody
            )
        )
        guard !responses.isEmpty else { throw APIClientError.invalidResponse }
        let response = responses.removeFirst()
        guard let url = request.url,
              let httpResponse = HTTPURLResponse(
                url: url,
                statusCode: response.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
              )
        else { throw APIClientError.invalidResponse }
        return (response.body, httpResponse)
    }

    func requests() -> [Request] { recordedRequests }
}
