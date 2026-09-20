import Foundation

enum DevicePositioningTier: String, Codable, Equatable, Sendable {
    case standby = "STANDBY"
    case searchRing = "SEARCH_RING"
    case eventParticipant = "EVENT_PARTICIPANT"
}

/// A validated Core Location sample represented without importing
/// CoreLocation.  Keeping the value in the shared model file allows the
/// protected iPhone event draft to be encoded independently of UI/services.
struct DeviceCoordinate: Codable, Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    let observedAt: Date
}

/// Shared adapter-side gate for a Core Location fix.  It deliberately has no
/// product freshness window: an old fix may still be retained as historical
/// evidence, while a non-finite or future timestamp cannot be presented as a
/// fact observed by the current process.
enum LocationFixValidity {
    static func isValid(
        latitude: Double,
        longitude: Double,
        accuracyMeters: Double,
        observedAt: Date,
        now: Date = Date()
    ) -> Bool {
        latitude.isFinite
            && longitude.isFinite
            && (-90...90).contains(latitude)
            && (-180...180).contains(longitude)
            && accuracyMeters.isFinite
            && accuracyMeters > 0
            && observedAt.timeIntervalSince1970.isFinite
            && now.timeIntervalSince1970.isFinite
            && observedAt <= now
    }
}

/// The only value permitted over the iPhone↔Watch WCSession message path.
/// The ticket is intentionally transient: neither side writes this envelope
/// to UserDefaults or any other non-Keychain persistence.
struct CompanionLinkEnvelope: Codable, Equatable, Sendable {
    let baseURL: String
    let companionPairId: String
    let companionLinkTicket: String
    let expiresAt: Date

    init(
        baseURL: String,
        companionPairId: String,
        companionLinkTicket: String,
        expiresAt: Date
    ) {
        self.baseURL = baseURL
        self.companionPairId = companionPairId
        self.companionLinkTicket = companionLinkTicket
        self.expiresAt = expiresAt
    }

    /// Converts to the strict property-list dictionary accepted by
    /// `WCSession.sendMessage`.  Keep this list in lockstep with the decoder
    /// below so a future business field cannot accidentally cross the link.
    func propertyList() -> [String: Any] {
        [
            "baseURL": baseURL,
            "companionPairId": companionPairId,
            "companionLinkTicket": companionLinkTicket,
            "expiresAt": Self.dateString(expiresAt)
        ]
    }

    init?(propertyList: [String: Any]) {
        let expectedKeys: Set<String> = [
            "baseURL", "companionPairId", "companionLinkTicket", "expiresAt"
        ]
        guard Set(propertyList.keys) == expectedKeys,
              let baseURL = propertyList["baseURL"] as? String,
              let companionPairId = propertyList["companionPairId"] as? String,
              let companionLinkTicket = propertyList["companionLinkTicket"] as? String,
              let expiresAtString = propertyList["expiresAt"] as? String,
              !baseURL.isEmpty,
              !companionPairId.isEmpty,
              !companionLinkTicket.isEmpty,
              let expiresAt = Self.date(from: expiresAtString)
        else {
            return nil
        }
        self.init(
            baseURL: baseURL,
            companionPairId: companionPairId,
            companionLinkTicket: companionLinkTicket,
            expiresAt: expiresAt
        )
    }

    private static func dateString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private static func date(from value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: value)
    }
}

enum PositionKind: String, Codable, CaseIterable, Sendable {
    case patient = "P"
    case responder = "R"
    case aed = "A"
}

enum PositionValidationError: Error, Equatable, LocalizedError {
    case invalidLatitude(Double)
    case invalidLongitude(Double)
    case invalidAccuracy(Double)

    var errorDescription: String? {
        switch self {
        case let .invalidLatitude(value):
            "纬度 \(value) 超出 -90...90。"
        case let .invalidLongitude(value):
            "经度 \(value) 超出 -180...180。"
        case let .invalidAccuracy(value):
            "定位精度 \(value) 必须大于 0。"
        }
    }
}

private enum CoordinateValidator {
    static func validate(latitude: Double, longitude: Double, accuracyMeters: Double?) throws {
        guard (-90...90).contains(latitude) else {
            throw PositionValidationError.invalidLatitude(latitude)
        }
        guard (-180...180).contains(longitude) else {
            throw PositionValidationError.invalidLongitude(longitude)
        }
        if let accuracyMeters, accuracyMeters <= 0 {
            throw PositionValidationError.invalidAccuracy(accuracyMeters)
        }
    }
}

struct PatientPosition: Codable, Hashable, Sendable {
    let kind: PositionKind
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double

    init(latitude: Double, longitude: Double, accuracyMeters: Double) throws {
        try CoordinateValidator.validate(
            latitude: latitude,
            longitude: longitude,
            accuracyMeters: accuracyMeters
        )
        kind = .patient
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedKind = try container.decode(PositionKind.self, forKey: .kind)
        guard decodedKind == .patient else {
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "PatientPosition requires kind P."
            )
        }
        try self.init(
            latitude: container.decode(Double.self, forKey: .latitude),
            longitude: container.decode(Double.self, forKey: .longitude),
            accuracyMeters: container.decode(Double.self, forKey: .accuracyMeters)
        )
    }
}

struct ResponderPosition: Codable, Hashable, Sendable {
    let kind: PositionKind
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double

    init(latitude: Double, longitude: Double, accuracyMeters: Double) throws {
        try CoordinateValidator.validate(
            latitude: latitude,
            longitude: longitude,
            accuracyMeters: accuracyMeters
        )
        kind = .responder
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedKind = try container.decode(PositionKind.self, forKey: .kind)
        guard decodedKind == .responder else {
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "ResponderPosition requires kind R."
            )
        }
        try self.init(
            latitude: container.decode(Double.self, forKey: .latitude),
            longitude: container.decode(Double.self, forKey: .longitude),
            accuracyMeters: container.decode(Double.self, forKey: .accuracyMeters)
        )
    }
}

struct AedPosition: Codable, Hashable, Sendable {
    let kind: PositionKind
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double?

    init(latitude: Double, longitude: Double, accuracyMeters: Double? = nil) throws {
        try CoordinateValidator.validate(
            latitude: latitude,
            longitude: longitude,
            accuracyMeters: accuracyMeters
        )
        kind = .aed
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedKind = try container.decode(PositionKind.self, forKey: .kind)
        guard decodedKind == .aed else {
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "AedPosition requires kind A."
            )
        }
        try self.init(
            latitude: container.decode(Double.self, forKey: .latitude),
            longitude: container.decode(Double.self, forKey: .longitude),
            accuracyMeters: container.decodeIfPresent(Double.self, forKey: .accuracyMeters)
        )
    }
}

enum StrictPosition: Codable, Hashable, Sendable {
    case patient(PatientPosition)
    case responder(ResponderPosition)
    case aed(AedPosition)

    var kind: PositionKind {
        switch self {
        case .patient: .patient
        case .responder: .responder
        case .aed: .aed
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: KindCodingKey.self)
        switch try container.decode(PositionKind.self, forKey: .kind) {
        case .patient:
            self = .patient(try PatientPosition(from: decoder))
        case .responder:
            self = .responder(try ResponderPosition(from: decoder))
        case .aed:
            self = .aed(try AedPosition(from: decoder))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case let .patient(position): try position.encode(to: encoder)
        case let .responder(position): try position.encode(to: encoder)
        case let .aed(position): try position.encode(to: encoder)
        }
    }

    private enum KindCodingKey: String, CodingKey {
        case kind
    }
}

struct PatientLocationCard: Codable, Hashable, Sendable {
    let address: String
    let floor: String
    let accessNote: String
}

enum AgreementKind: String, Codable, CaseIterable, Sendable {
    case patient = "PATIENT"
    case volunteerResponder = "VOLUNTEER_RESPONDER"
    case privacyPolicy = "PRIVACY_POLICY"
    case sensitivePersonalInformation = "SENSITIVE_PERSONAL_INFORMATION"

    /// Fallback title used when the bundled document cannot be loaded, so the
    /// gate can still name what is missing.
    var readerTitle: String {
        switch self {
        case .patient: "患者协议"
        case .volunteerResponder: "志愿响应者协议"
        case .privacyPolicy: "隐私政策"
        case .sensitivePersonalInformation: "敏感个人信息使用说明"
        }
    }
}

struct AgreementAcceptance: Codable, Equatable, Sendable {
    let kind: AgreementKind
    let version: String
    let acceptedAt: Date
}

/// One agreement document the user is asked to accept.  App Store guideline
/// 5.1.1(i) requires a privacy policy to be reachable, and a consent gate is
/// meaningless when the user cannot read the text being accepted, so the app
/// carries the document body itself rather than only a one-line summary.
struct AgreementDocument: Codable, Equatable, Sendable, Identifiable {
    struct Section: Codable, Equatable, Sendable {
        let heading: String
        let body: String
    }

    let kind: AgreementKind
    let title: String
    let version: String
    /// One-line summary shown next to the onboarding toggle.
    let summary: String
    let sections: [Section]

    var id: String { kind.rawValue }

    var isReadable: Bool {
        !title.isEmpty && !sections.isEmpty
            && sections.allSatisfy { !$0.heading.isEmpty && !$0.body.isEmpty }
    }
}

/// The agreement set bundled with the app.  `privacyPolicyURL` and
/// `contactEmail` are the two fields that must carry the operator's real hosted
/// policy and contact address before submission; `isReadyForSubmission` stays
/// false until they do, so an unfinished legal surface cannot ship silently.
struct AgreementDocuments: Codable, Equatable, Sendable {
    let schemaVersion: String
    let privacyPolicyURL: String
    let contactEmail: String
    let documents: [AgreementDocument]

    func document(for kind: AgreementKind) -> AgreementDocument? {
        documents.first { $0.kind == kind }
    }

    var isReadyForSubmission: Bool {
        guard let url = URL(string: privacyPolicyURL),
              url.scheme == "https",
              url.host?.isEmpty == false
        else { return false }
        let trimmedEmail = contactEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedEmail.contains("@")
            && trimmedEmail.contains(".")
            && !trimmedEmail.lowercased().contains("example.")
    }
}

struct AgreementVersions: Codable, Equatable, Sendable {
    let patient: String
    let volunteerResponder: String
    let privacyPolicy: String
    let sensitivePersonalInformation: String

    init(
        patient: String,
        volunteerResponder: String,
        privacyPolicy: String = "2.0",
        sensitivePersonalInformation: String = "2.0"
    ) {
        self.patient = patient
        self.volunteerResponder = volunteerResponder
        self.privacyPolicy = privacyPolicy
        self.sensitivePersonalInformation = sensitivePersonalInformation
    }

    private enum CodingKeys: String, CodingKey {
        case patient
        case volunteerResponder
        case privacyPolicy
        case sensitivePersonalInformation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        patient = try container.decode(String.self, forKey: .patient)
        volunteerResponder = try container.decode(String.self, forKey: .volunteerResponder)
        // v2.0 fixtures predate the two privacy gates.  They migrate to the
        // first explicit consent revision until the fixture is versioned.
        privacyPolicy = try container.decodeIfPresent(String.self, forKey: .privacyPolicy) ?? "2.0"
        sensitivePersonalInformation = try container.decodeIfPresent(
            String.self,
            forKey: .sensitivePersonalInformation
        ) ?? "2.0"
    }
}

struct DeviceCapabilities: Codable, Equatable, Sendable {
    let notificationAuthorized: Bool
    let locationAuthorized: Bool
}

struct DevicePresenceUpdate: Codable, Equatable, Sendable {
    let presenceUpdateId: String
    let occurredAt: Date
    let availableForResponse: Bool
    let capabilities: DeviceCapabilities
}

enum PhonePosition: Codable, Hashable, Sendable {
    case patient(PatientPosition)
    case responder(ResponderPosition)

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: KindCodingKey.self)
        switch try container.decode(PositionKind.self, forKey: .kind) {
        case .patient:
            self = .patient(try PatientPosition(from: decoder))
        case .responder:
            self = .responder(try ResponderPosition(from: decoder))
        case .aed:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "LatestDevicePosition only accepts P or R."
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case let .patient(position): try position.encode(to: encoder)
        case let .responder(position): try position.encode(to: encoder)
        }
    }

    private enum KindCodingKey: String, CodingKey {
        case kind
    }
}

struct LatestDevicePosition: Codable, Hashable, Sendable {
    let positionUpdateId: String
    let position: PhonePosition
    let eventId: String?
    let observedAt: Date
    let serverReceivedAt: Date

    init(
        positionUpdateId: String,
        position: PhonePosition,
        eventId: String?,
        observedAt: Date,
        serverReceivedAt: Date
    ) throws {
        switch position {
        case .patient:
            guard let eventId, !eventId.isEmpty else {
                throw PositionLinkValidationError.patientRequiresEventID
            }
        case .responder:
            guard eventId == nil else {
                throw PositionLinkValidationError.responderForbidsEventID
            }
        }
        self.positionUpdateId = positionUpdateId
        self.position = position
        self.eventId = eventId
        self.observedAt = observedAt
        self.serverReceivedAt = serverReceivedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            positionUpdateId: container.decode(String.self, forKey: .positionUpdateId),
            position: container.decode(PhonePosition.self, forKey: .position),
            eventId: container.decodeIfPresent(String.self, forKey: .eventId),
            observedAt: container.decode(Date.self, forKey: .observedAt),
            serverReceivedAt: container.decode(Date.self, forKey: .serverReceivedAt)
        )
    }

    private enum CodingKeys: String, CodingKey {
        case positionUpdateId, position, eventId, observedAt, serverReceivedAt
    }
}

enum PositionLinkValidationError: Error, Equatable {
    case patientRequiresEventID
    case responderForbidsEventID
}

/// Whether `position` may be treated as the device's current location.
///
/// `UNAVAILABLE` also covers a coordinate whose timestamp could not be
/// interpreted, so it is never safe to infer freshness from the coordinate alone.
///
/// Decoding is deliberately forward-compatible: a verdict this build does not
/// recognise is preserved as `unrecognized` instead of failing the whole
/// `DevicePresence` decode.  An unknown verdict is never promoted to current —
/// `permitsCurrentLocation` is only true for `fresh`, so the failure mode is
/// "show nothing" rather than "show a stale coordinate as live".
enum PositionFreshness: Equatable, Sendable {
    case fresh
    case stale
    case unavailable
    case unrecognized(String)

    /// The single authority for whether `position` may be used as current.
    var permitsCurrentLocation: Bool { self == .fresh }

    /// Whole-second display age is not sufficient to re-derive this verdict: at
    /// 600.001 s the server still reports ageSeconds 600 while the verdict is
    /// already stale.  Always read `freshness`.
    static func from(rawValue: String) -> PositionFreshness {
        switch rawValue {
        case "FRESH": return .fresh
        case "STALE": return .stale
        case "UNAVAILABLE": return .unavailable
        default: return .unrecognized(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .fresh: return "FRESH"
        case .stale: return "STALE"
        case .unavailable: return "UNAVAILABLE"
        case .unrecognized(let raw): return raw
        }
    }
}

extension PositionFreshness: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = PositionFreshness.from(rawValue: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// A coordinate reported as a *last known* position, together with the time it
/// was sampled. Retained past the server's freshness window on purpose.
struct LastKnownPosition: Codable, Equatable, Sendable {
    let coordinate: LastKnownCoordinate
    let observedAt: Date
}

/// The coordinate as the presence endpoint reports it: a strict P or R sample,
/// without a sampling timestamp of its own (that is `LastKnownPosition.observedAt`).
struct LastKnownCoordinate: Codable, Equatable, Sendable {
    let kind: PositionKind
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
}

struct DevicePresence: Codable, Equatable, Sendable {
    let deviceInstanceId: String
    let deviceKind: String
    let lastSeenAt: Date
    let lastPresenceUpdateId: String?
    let lastPresenceOccurredAt: Date?
    let availableForResponse: Bool
    let capabilities: DeviceCapabilities
    let position: LastKnownPosition?
    /// The only field that authorises treating `position` as current. Use this,
    /// never the coordinate's presence, and never `ageSeconds`.
    let freshness: PositionFreshness
    /// Whole-second display value; not sufficient to re-derive `freshness`.
    let ageSeconds: Int?
    let currentEventId: String?
    let currentAssignmentId: String?
}

struct ResponderPositionUpdate: Codable, Equatable, Sendable {
    let positionUpdateId: String
    let responderPosition: ResponderPosition
    let observedAt: Date
}

struct PatientPositionUpdate: Codable, Equatable, Sendable {
    let positionUpdateId: String
    let patientPosition: PatientPosition
    let observedAt: Date
}

struct PositionUpdateResult: Codable, Equatable, Sendable {
    let positionUpdateId: String
    let applied: Bool
    let idempotent: Bool
    let ignoredAsStale: Bool
    let positionObservedAt: Date
    let serverReceivedAt: Date
    /// Optional for older servers; an ACK is not permission to publish event evidence.
    var positioningTier: DevicePositioningTier? = nil
}

enum EventPositionRecordStatus: String, Codable, Equatable, Sendable {
    case fix = "FIX"
    case noNewFix = "NO_NEW_FIX"
}

enum EventPositionGapReason: String, Codable, Equatable, Sendable {
    case noFix = "NO_FIX"
    case appNotRunning = "APP_NOT_RUNNING"
}

/// Returns the UTC second containing a date.  Event evidence uses this value
/// as its stable slot key; the source Core Location timestamp is retained
/// separately on FIX records.
func utcSecondStart(_ date: Date) -> Date {
    Date(timeIntervalSince1970: date.timeIntervalSince1970.rounded(.down))
}

/// Returns the first UTC whole second that is not earlier than `date`.
/// An already-whole second is preserved; a fractional participation start
/// advances to the next slot because the backend validates the slot key, not
/// just an in-slot fix timestamp.
func utcSecondCeiling(_ date: Date) -> Date {
    let seconds = date.timeIntervalSince1970
    guard seconds.isFinite else { return date }
    let lower = seconds.rounded(.down)
    if abs(seconds - lower) < 0.000_000_001 {
        return Date(timeIntervalSince1970: lower)
    }
    return Date(timeIntervalSince1970: lower + 1)
}

private func isUTCWholeSecond(_ date: Date) -> Bool {
    let seconds = date.timeIntervalSince1970
    return seconds.isFinite && abs(seconds - seconds.rounded(.down)) < 0.000_000_001
}

/// One event-participant fact for one client-side one-second slot.
///
/// The wire shape is a strict discriminated union.  A `FIX` carries the real
/// OS fix time, while `NO_NEW_FIX` carries only the reason for the gap.
struct EventPositionRecord: Codable, Equatable, Sendable {
    let recordId: String
    let slotAt: Date
    let status: EventPositionRecordStatus
    let position: PhonePosition?
    let fixObservedAt: Date?
    let gapReason: EventPositionGapReason?

    init(
        recordId: String,
        slotAt: Date,
        status: EventPositionRecordStatus,
        position: PhonePosition? = nil,
        fixObservedAt: Date? = nil,
        gapReason: EventPositionGapReason? = nil
    ) throws {
        guard !recordId.isEmpty else {
            throw EventPositionBatchValidationError.emptyRecordID
        }
        guard isUTCWholeSecond(slotAt) else {
            throw EventPositionBatchValidationError.invalidSlot
        }
        switch (status, position, fixObservedAt, gapReason) {
        case let (.fix, .some, .some(fixObservedAt), nil):
            let slotSeconds = slotAt.timeIntervalSince1970
            let fixSeconds = fixObservedAt.timeIntervalSince1970
            guard fixSeconds.isFinite,
                  fixSeconds >= slotSeconds,
                  fixSeconds < slotSeconds + 1
            else {
                throw EventPositionBatchValidationError.fixObservedAtOutsideSlot
            }
            break
        case (.fix, _, nil, _):
            throw EventPositionBatchValidationError.fixRequiresPosition
        case (.fix, .none, .some, _):
            throw EventPositionBatchValidationError.fixRequiresPosition
        case (.fix, _, _, .some):
            throw EventPositionBatchValidationError.fixForbidsGapReason
        case (.noNewFix, nil, nil, .some):
            break
        case (.noNewFix, .some, _, _):
            throw EventPositionBatchValidationError.noNewFixForbidsPosition
        case (.noNewFix, nil, .some, _):
            throw EventPositionBatchValidationError.noNewFixForbidsFixTimestamp
        case (.noNewFix, nil, nil, nil):
            throw EventPositionBatchValidationError.noNewFixRequiresGapReason
        }
        self.recordId = recordId
        self.slotAt = slotAt
        self.status = status
        self.position = position
        self.fixObservedAt = fixObservedAt
        self.gapReason = gapReason
    }

    static func fix(
        recordID: String,
        slotAt: Date,
        fixObservedAt: Date,
        position: PhonePosition
    ) throws -> EventPositionRecord {
        try EventPositionRecord(
            recordId: recordID,
            slotAt: slotAt,
            status: .fix,
            position: position,
            fixObservedAt: fixObservedAt
        )
    }

    static func noNewFix(
        recordID: String,
        slotAt: Date,
        gapReason: EventPositionGapReason = .noFix
    ) throws -> EventPositionRecord {
        try EventPositionRecord(
            recordId: recordID,
            slotAt: slotAt,
            status: .noNewFix,
            gapReason: gapReason
        )
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case recordId, slotAt, status, position, fixObservedAt, gapReason
    }

    init(from decoder: Decoder) throws {
        let rawContainer = try decoder.container(keyedBy: EventPositionRecordCodingKey.self)
        let allowedKeys = Set(CodingKeys.allCases.map(\.stringValue))
        guard Set(rawContainer.allKeys.map(\.stringValue)).isSubset(of: allowedKeys) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unknown event position record field.")
            )
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(EventPositionRecordStatus.self, forKey: .status)
        switch status {
        case .fix:
            guard container.contains(.position),
                  container.contains(.fixObservedAt),
                  !container.contains(.gapReason)
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .status,
                    in: container,
                    debugDescription: "FIX requires position/fixObservedAt and forbids gapReason."
                )
            }
        case .noNewFix:
            guard container.contains(.gapReason),
                  !container.contains(.position),
                  !container.contains(.fixObservedAt)
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .status,
                    in: container,
                    debugDescription: "NO_NEW_FIX requires gapReason and forbids position/fixObservedAt."
                )
            }
        }
        try self.init(
            recordId: container.decode(String.self, forKey: .recordId),
            slotAt: container.decode(Date.self, forKey: .slotAt),
            status: status,
            position: container.decodeIfPresent(PhonePosition.self, forKey: .position),
            fixObservedAt: container.decodeIfPresent(Date.self, forKey: .fixObservedAt),
            gapReason: container.decodeIfPresent(EventPositionGapReason.self, forKey: .gapReason)
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(recordId, forKey: .recordId)
        try container.encode(slotAt, forKey: .slotAt)
        try container.encode(status, forKey: .status)
        switch status {
        case .fix:
            try container.encode(position, forKey: .position)
            try container.encode(fixObservedAt, forKey: .fixObservedAt)
        case .noNewFix:
            try container.encode(gapReason, forKey: .gapReason)
        }
    }
}

private struct EventPositionRecordCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

enum EventPositionBatchValidationError: Error, Equatable, LocalizedError {
    case emptyBatchID
    case emptyRecordID
    case invalidRecordCount
    case duplicateRecordID
    case duplicateSlot
    case nonContiguousSlots
    case invalidSlot
    case fixRequiresPosition
    case fixObservedAtOutsideSlot
    case fixForbidsGapReason
    case noNewFixForbidsPosition
    case noNewFixForbidsFixTimestamp
    case noNewFixRequiresGapReason
    case positionKindMismatch
    case responseMismatch

    var errorDescription: String? {
        switch self {
        case .emptyBatchID: "事件位置批次缺少 batchId。"
        case .emptyRecordID: "事件位置记录缺少 recordId。"
        case .invalidRecordCount: "事件位置批次必须包含 1–5 条记录。"
        case .duplicateRecordID: "事件位置批次中的 recordId 必须唯一。"
        case .duplicateSlot: "事件位置批次中的 slotAt 必须唯一。"
        case .nonContiguousSlots: "事件位置批次中的 slotAt 必须按连续整秒排列。"
        case .invalidSlot: "slotAt 必须是 UTC 整秒时间戳。"
        case .fixRequiresPosition: "FIX 记录必须包含位置。"
        case .fixObservedAtOutsideSlot: "FIX 的 fixObservedAt 必须位于对应整秒 slot 内。"
        case .fixForbidsGapReason: "FIX 记录不得包含 gapReason。"
        case .noNewFixForbidsPosition: "NO_NEW_FIX 记录不得包含位置。"
        case .noNewFixForbidsFixTimestamp: "NO_NEW_FIX 记录不得包含 fixObservedAt。"
        case .noNewFixRequiresGapReason: "NO_NEW_FIX 记录必须包含 gapReason。"
        case .positionKindMismatch: "事件位置记录的角色与当前位置类型不匹配。"
        case .responseMismatch: "服务端位置批次 ACK 与请求不匹配。"
        }
    }
}

struct EventPositionBatch: Codable, Equatable, Sendable {
    let schemaVersion: String
    let eventId: String
    let batchId: String
    let records: [EventPositionRecord]

    init(
        eventId: String,
        batchId: String,
        records: [EventPositionRecord],
        schemaVersion: String = "2.0"
    ) throws {
        guard schemaVersion == "2.0",
              !eventId.isEmpty,
              !batchId.isEmpty
        else { throw EventPositionBatchValidationError.emptyBatchID }
        guard (1...5).contains(records.count) else {
            throw EventPositionBatchValidationError.invalidRecordCount
        }
        var recordIDs = Set<String>()
        var slots = Set<Date>()
        for record in records {
            guard recordIDs.insert(record.recordId).inserted else {
                throw EventPositionBatchValidationError.duplicateRecordID
            }
            guard slots.insert(record.slotAt).inserted else {
                throw EventPositionBatchValidationError.duplicateSlot
            }
        }
        let orderedSlots = records.map(\.slotAt)
        guard orderedSlots == orderedSlots.sorted(),
              zip(orderedSlots, orderedSlots.dropFirst()).allSatisfy({ previous, current in
                  current.timeIntervalSince(previous) == 1
              })
        else {
            throw EventPositionBatchValidationError.nonContiguousSlots
        }
        self.schemaVersion = schemaVersion
        self.eventId = eventId
        self.batchId = batchId
        self.records = records
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            eventId: container.decode(String.self, forKey: .eventId),
            batchId: container.decode(String.self, forKey: .batchId),
            records: container.decode([EventPositionRecord].self, forKey: .records),
            schemaVersion: container.decode(String.self, forKey: .schemaVersion)
        )
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, eventId, batchId, records
    }
}

struct EventPositionRecordAck: Codable, Equatable, Sendable {
    let recordId: String
    let persisted: Bool
    let appliedToLatest: Bool
    let ignoredAsStale: Bool
    let serverReceivedAt: Date
}

struct EventPositionBatchAck: Codable, Equatable, Sendable {
    let schemaVersion: String
    let eventId: String
    let batchId: String
    let acceptedRecordCount: Int
    let idempotent: Bool
    let acknowledgedAt: Date
    let records: [EventPositionRecordAck]

    func validates(request: EventPositionBatch) -> Bool {
        let requestedIDs = Set(request.records.map(\.recordId))
        let acknowledgedIDs = Set(records.map(\.recordId))
        return schemaVersion == "2.0"
            && eventId == request.eventId
            && batchId == request.batchId
            && acceptedRecordCount == request.records.count
            && records.count == request.records.count
            && requestedIDs.count == request.records.count
            && acknowledgedIDs == requestedIDs
            && records.allSatisfy(\.persisted)
    }
}

enum EventParticipantRole: String, Codable, Equatable, Sendable {
    case patient = "P"
    case responder = "R"
}

/// Metadata is kept with each batch so a restored queue is always sent with
/// the same authenticated user, device, event and participant role context.
/// `generation` is a local capture generation used to invalidate stale tasks;
/// it is never sent to the backend.
struct PersistedEventPositionBatch: Codable, Equatable, Sendable {
    let serviceNamespace: String
    let userId: String
    let deviceInstanceId: String
    let eventId: String
    let role: EventParticipantRole
    let generation: Int
    let windowStartedAt: Date
    let batch: EventPositionBatch
    let anchorPosition: PhonePosition?
    /// A permanent 4xx is isolated instead of blocking unrelated event
    /// batches.  The payload remains persisted for explicit reconciliation.
    let blockedReason: String?

    init(
        serviceNamespace: String,
        userId: String,
        deviceInstanceId: String,
        eventId: String,
        role: EventParticipantRole,
        generation: Int,
        windowStartedAt: Date,
        batch: EventPositionBatch,
        anchorPosition: PhonePosition? = nil,
        blockedReason: String? = nil
    ) throws {
        guard !serviceNamespace.isEmpty,
              !userId.isEmpty,
              !deviceInstanceId.isEmpty,
              eventId == batch.eventId,
              !eventId.isEmpty,
              generation > 0,
              roleMatchesRecords(role, batch.records, anchorPosition: anchorPosition)
        else { throw EventPositionBatchValidationError.responseMismatch }
        self.serviceNamespace = serviceNamespace
        self.userId = userId
        self.deviceInstanceId = deviceInstanceId
        self.eventId = eventId
        self.role = role
        self.generation = generation
        self.windowStartedAt = windowStartedAt
        self.batch = batch
        self.anchorPosition = anchorPosition
        self.blockedReason = blockedReason
    }

    private enum CodingKeys: String, CodingKey {
        case serviceNamespace, userId, deviceInstanceId, eventId, role, generation, windowStartedAt, batch,
             anchorPosition, blockedReason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            serviceNamespace: container.decode(String.self, forKey: .serviceNamespace),
            userId: container.decode(String.self, forKey: .userId),
            deviceInstanceId: container.decode(String.self, forKey: .deviceInstanceId),
            eventId: container.decode(String.self, forKey: .eventId),
            role: container.decode(EventParticipantRole.self, forKey: .role),
            generation: container.decode(Int.self, forKey: .generation),
            windowStartedAt: container.decode(Date.self, forKey: .windowStartedAt),
            batch: container.decode(EventPositionBatch.self, forKey: .batch),
            anchorPosition: container.decodeIfPresent(PhonePosition.self, forKey: .anchorPosition),
            blockedReason: container.decodeIfPresent(String.self, forKey: .blockedReason)
        )
    }
}

/// Draft state is persisted before a slot/callback mutation is acknowledged
/// in memory.  It is deliberately separate from sealed batches so a crash in
/// the five-second window can resume candidate selection after restart.
struct EventPositionSlotCandidate: Codable, Equatable, Sendable {
    let slotAt: Date
    let coordinate: DeviceCoordinate
}

struct EventPositionOpenDraft: Codable, Equatable, Sendable {
    let serviceNamespace: String
    let userId: String
    let deviceInstanceId: String
    let eventId: String
    let role: EventParticipantRole
    let generation: Int
    let openSlots: [Date]
    let clockedSlots: [Date]
    /// Slots synthesized after the five-second restart grace.  A restored
    /// clocked slot is deliberately absent and remains a normal NO_FIX gap.
    let appNotRunningSlots: [Date]
    let candidates: [EventPositionSlotCandidate]

    init(
        serviceNamespace: String,
        userId: String,
        deviceInstanceId: String,
        eventId: String,
        role: EventParticipantRole,
        generation: Int,
        openSlots: [Date],
        clockedSlots: [Date],
        appNotRunningSlots: [Date] = [],
        candidates: [EventPositionSlotCandidate]
    ) throws {
        guard !serviceNamespace.isEmpty,
              !userId.isEmpty,
              !deviceInstanceId.isEmpty,
              !eventId.isEmpty,
              generation > 0,
              openSlots == openSlots.sorted(),
              Set(openSlots).count == openSlots.count,
              openSlots.allSatisfy({ isUTCWholeSecond($0) }),
              clockedSlots == clockedSlots.sorted(),
              clockedSlots.allSatisfy({ isUTCWholeSecond($0) }),
              Set(clockedSlots).isSubset(of: Set(openSlots)),
              appNotRunningSlots == appNotRunningSlots.sorted(),
              appNotRunningSlots.allSatisfy({ isUTCWholeSecond($0) }),
              Set(appNotRunningSlots).isSubset(of: Set(clockedSlots)),
              Set(candidates.map(\.slotAt)).count == candidates.count,
              candidates.allSatisfy({
                  openSlots.contains($0.slotAt)
                      && utcSecondStart($0.coordinate.observedAt) == $0.slotAt
              })
        else { throw EventPositionBatchValidationError.responseMismatch }
        self.serviceNamespace = serviceNamespace
        self.userId = userId
        self.deviceInstanceId = deviceInstanceId
        self.eventId = eventId
        self.role = role
        self.generation = generation
        self.openSlots = openSlots
        self.clockedSlots = clockedSlots
        self.appNotRunningSlots = appNotRunningSlots
        self.candidates = candidates
    }

    private enum CodingKeys: String, CodingKey {
        case serviceNamespace, userId, deviceInstanceId, eventId, role, generation,
             openSlots, clockedSlots, appNotRunningSlots, candidates
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            serviceNamespace: container.decode(String.self, forKey: .serviceNamespace),
            userId: container.decode(String.self, forKey: .userId),
            deviceInstanceId: container.decode(String.self, forKey: .deviceInstanceId),
            eventId: container.decode(String.self, forKey: .eventId),
            role: container.decode(EventParticipantRole.self, forKey: .role),
            generation: container.decode(Int.self, forKey: .generation),
            openSlots: container.decode([Date].self, forKey: .openSlots),
            clockedSlots: container.decode([Date].self, forKey: .clockedSlots),
            appNotRunningSlots: container.decodeIfPresent(
                [Date].self,
                forKey: .appNotRunningSlots
            ) ?? [],
            candidates: container.decode([EventPositionSlotCandidate].self, forKey: .candidates)
        )
    }
}

enum EventPositionQuarantineReason: String, Codable, Equatable, Sendable {
    case beforeParticipationStart = "BEFORE_PARTICIPATION_START"
    case participationEnded = "PARTICIPATION_ENDED"
    case fixOutsideParticipationWindow = "FIX_OUTSIDE_PARTICIPATION_WINDOW"
}

/// Local append-only evidence excluded from transport after a later REST
/// projection supplies the authoritative participation window.  A sealed
/// record is retained byte-for-model-field with its original recordId and
/// payload; an open draft retains its source coordinate and clocked state.
struct QuarantinedEventPositionEvidence: Codable, Equatable, Sendable {
    let serviceNamespace: String
    let userId: String
    let deviceInstanceId: String
    let eventId: String
    let role: EventParticipantRole
    let generation: Int
    let originalBatchId: String?
    let slotAt: Date
    let record: EventPositionRecord?
    let coordinate: DeviceCoordinate?
    let wasClocked: Bool
    let reason: EventPositionQuarantineReason
    let quarantinedAt: Date
}

private func roleMatchesRecords(
    _ role: EventParticipantRole,
    _ records: [EventPositionRecord],
    anchorPosition: PhonePosition? = nil
) -> Bool {
    if let anchorPosition {
        switch (role, anchorPosition) {
        case (.patient, .patient), (.responder, .responder): break
        default: return false
        }
    }
    return records.allSatisfy { record in
        guard let position = record.position else { return true }
        switch (role, position) {
        case (.patient, .patient), (.responder, .responder): return true
        default: return false
        }
    }
}

struct EventPositionQueueState: Codable, Equatable, Sendable {
    var pendingBatches: [PersistedEventPositionBatch]
    var activeContextKey: String?
    var activeGeneration: Int?
    var generationsByContext: [String: Int]
    var lastFixByContext: [String: PhonePosition]
    /// The greatest slot that has been sealed into a persisted batch for each
    /// capture context.  A later Core Location callback may never rewrite a
    /// slot at or below this value.
    var lastFinalizedSlotAtByContext: [String: Date]
    /// Non-sensitive operational telemetry for discarded late callbacks.
    var lateFixDiscardCountByContext: [String: Int]
    var openDraftsByContext: [String: EventPositionOpenDraft]
    /// Out-of-window evidence that the server has NOT yet been confirmed to hold.
    /// Nothing may ever delete from here: it is the client's only copy.
    var quarantinedEvidence: [QuarantinedEventPositionEvidence]
    /// Quarantine rows whose fact the server has been confirmed to hold.
    ///
    /// Closed contexts keep producing quarantine rows (a permission change or an
    /// exit can exclude a long stretch of slots), and their only consumer is an
    /// audit, so they move here once they are sealed.  Moving — not deleting — is
    /// what keeps growth bounded without ever discarding the client's copy of a
    /// fact: both arrays are persisted, and the append-only rule below spans the
    /// pair.
    var sealedQuarantineEvidence: [QuarantinedEventPositionEvidence]
    /// How many sealed rows have been compacted away because the sealed budget
    /// was exceeded.  Recorded so "bounded" never has to mean "silently gone":
    /// the count is in every snapshot and is reported to the user when growth is
    /// refused.
    var compactedSealedEvidenceCount: Int
    /// Server-authoritative exclusive end times learned from a successful
    /// responder exit ACK.  Persisting these bounds lets a later process
    /// safely reconcile pre-exit evidence even when GET /events/{id} is 404.
    var authoritativeEndedAtByContext: [String: Date]

    init(
        pendingBatches: [PersistedEventPositionBatch] = [],
        activeContextKey: String? = nil,
        activeGeneration: Int? = nil,
        generationsByContext: [String: Int] = [:],
        lastFixByContext: [String: PhonePosition] = [:],
        lastFinalizedSlotAtByContext: [String: Date] = [:],
        lateFixDiscardCountByContext: [String: Int] = [:],
        openDraftsByContext: [String: EventPositionOpenDraft] = [:],
        quarantinedEvidence: [QuarantinedEventPositionEvidence] = [],
        sealedQuarantineEvidence: [QuarantinedEventPositionEvidence] = [],
        compactedSealedEvidenceCount: Int = 0,
        authoritativeEndedAtByContext: [String: Date] = [:]
    ) {
        self.pendingBatches = pendingBatches
        self.activeContextKey = activeContextKey
        self.activeGeneration = activeGeneration
        self.generationsByContext = generationsByContext
        self.lastFixByContext = lastFixByContext
        self.lastFinalizedSlotAtByContext = lastFinalizedSlotAtByContext
        self.lateFixDiscardCountByContext = lateFixDiscardCountByContext
        self.openDraftsByContext = openDraftsByContext
        self.quarantinedEvidence = quarantinedEvidence
        self.sealedQuarantineEvidence = sealedQuarantineEvidence
        self.compactedSealedEvidenceCount = compactedSealedEvidenceCount
        self.authoritativeEndedAtByContext = authoritativeEndedAtByContext
    }

    private enum CodingKeys: String, CodingKey {
        case pendingBatches, activeContextKey, activeGeneration, generationsByContext, lastFixByContext
        case lastFinalizedSlotAtByContext, lateFixDiscardCountByContext
        case openDraftsByContext
        case quarantinedEvidence, sealedQuarantineEvidence, compactedSealedEvidenceCount
        case authoritativeEndedAtByContext
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            pendingBatches: try container.decodeIfPresent(
                [PersistedEventPositionBatch].self,
                forKey: .pendingBatches
            ) ?? [],
            activeContextKey: try container.decodeIfPresent(String.self, forKey: .activeContextKey),
            activeGeneration: try container.decodeIfPresent(Int.self, forKey: .activeGeneration),
            generationsByContext: try container.decodeIfPresent(
                [String: Int].self,
                forKey: .generationsByContext
            ) ?? [:],
            lastFixByContext: try container.decodeIfPresent(
                [String: PhonePosition].self,
                forKey: .lastFixByContext
            ) ?? [:],
            lastFinalizedSlotAtByContext: try container.decodeIfPresent(
                [String: Date].self,
                forKey: .lastFinalizedSlotAtByContext
            ) ?? [:],
            lateFixDiscardCountByContext: try container.decodeIfPresent(
                [String: Int].self,
                forKey: .lateFixDiscardCountByContext
            ) ?? [:],
            openDraftsByContext: try container.decodeIfPresent(
                [String: EventPositionOpenDraft].self,
                forKey: .openDraftsByContext
            ) ?? [:],
            quarantinedEvidence: try container.decodeIfPresent(
                [QuarantinedEventPositionEvidence].self,
                forKey: .quarantinedEvidence
            ) ?? [],
            // Absent in a queue file written before sealed evidence existed; an
            // older file simply has nothing sealed yet.
            sealedQuarantineEvidence: try container.decodeIfPresent(
                [QuarantinedEventPositionEvidence].self,
                forKey: .sealedQuarantineEvidence
            ) ?? [],
            compactedSealedEvidenceCount: try container.decodeIfPresent(
                Int.self,
                forKey: .compactedSealedEvidenceCount
            ) ?? 0,
            authoritativeEndedAtByContext: try container.decodeIfPresent(
                [String: Date].self,
                forKey: .authoritativeEndedAtByContext
            ) ?? [:]
        )
    }
}

enum EventState: String, Codable, CaseIterable, Sendable {
    case active = "ACTIVE"
    case cancelledConfirmedFalseAlarm = "CANCELLED_CONFIRMED_FALSE_ALARM"
    case cancelledAssistanceWithdrawn = "CANCELLED_ASSISTANCE_WITHDRAWN"
    case resolved = "RESOLVED"
    case closedUnconfirmedNoResponse = "CLOSED_UNCONFIRMED_NO_RESPONSE"

    var isTerminal: Bool { self != .active }
}

enum StatusConfirmationPrompt: String, Codable, Equatable, Hashable, Sendable {
    case stillInProgress = "STILL_IN_PROGRESS"
}

enum StatusConfirmationResponseValue: String, Codable, Equatable, Sendable {
    case continueRescue = "CONTINUE"
}

struct StatusConfirmation: Codable, Equatable, Hashable, Sendable {
    let confirmationId: String
    let prompt: StatusConfirmationPrompt
    let sentAt: Date
    let responseDeadlineAt: Date
}

struct StatusConfirmationHint: Equatable, Sendable {
    let confirmationId: String
    let prompt: StatusConfirmationPrompt
    let responseDeadlineAt: Date
}

struct StatusConfirmationResult: Codable, Equatable, Sendable {
    let confirmationId: String
    let response: StatusConfirmationResponseValue
    let respondedAt: Date
    let nextCheckAt: Date
    let idempotent: Bool
}

struct ParticipantExitRequest: Codable, Equatable, Sendable {
    let exitId: String
    let exitedAt: Date
    let reason: String?
    /// Ordinary one-confirmation exits omit this field.  Only the completed
    /// three-confirmation sole-responder flow sends true.
    let soleResponderConfirmed: Bool?

    init(
        exitId: String,
        exitedAt: Date,
        reason: String? = nil,
        soleResponderConfirmed: Bool? = nil
    ) {
        self.exitId = exitId
        self.exitedAt = exitedAt
        self.reason = reason
        self.soleResponderConfirmed = soleResponderConfirmed == true ? true : nil
    }
}

struct ParticipantExitResult: Codable, Equatable, Sendable {
    let exitId: String
    let eventId: String
    /// Server-authoritative effective exit time; exclusive for event-position
    /// evidence.
    let exitedAt: Date
    let idempotent: Bool
}

enum RecruitmentState: String, Codable, CaseIterable, Sendable {
    case recruiting = "RECRUITING"
    case stopped = "STOPPED"
    case completed = "COMPLETED"
}

enum TriggerSource: String, Codable, CaseIterable, Sendable {
    case simulatedTest = "SIMULATED_TEST"
    case watchFallHelpConfirmed = "WATCH_FALL_HELP_CONFIRMED"
    case watchFallNoResponseOutgoingCallObserved =
        "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED"
    /// A person reported the patient they found.  Not a fall: the case carries a
    /// position and a time, so the UI must not present it as fall-detected.
    case userReportedPatient = "USER_REPORTED_PATIENT"

    /// Whether this trigger claims a fall was detected by a Watch.
    var isWatchFallDetection: Bool {
        self == .watchFallHelpConfirmed || self == .watchFallNoResponseOutgoingCallObserved
    }
}

enum PatientPositionSource: String, Codable, CaseIterable, Sendable {
    case watchTriggerSnapshot = "WATCH_TRIGGER_SNAPSHOT"
    case iPhonePrimary = "IPHONE_PRIMARY"
    case watchFallback = "WATCH_FALLBACK"
}

enum FallResolution: String, Codable, CaseIterable, Sendable {
    case confirmed = "CONFIRMED"
    case dismissed = "DISMISSED"
    case rejected = "REJECTED"
    case unresponsive = "UNRESPONSIVE"
    case unknown = "UNKNOWN"
}

enum ViewerRelationship: String, Codable, CaseIterable, Sendable {
    case neutral = "NEUTRAL"
    case patient = "PATIENT"
    case responder = "RESPONDER"
}

enum DeliveryStatus: String, Codable, CaseIterable, Sendable {
    case sent = "SENT"
    case delivered = "DELIVERED"
    case viewed = "VIEWED"
    case accepted = "ACCEPTED"
    case refused = "REFUSED"
    case expired = "EXPIRED"

    var isTerminal: Bool {
        switch self {
        case .accepted, .refused, .expired: true
        case .sent, .delivered, .viewed: false
        }
    }
}

enum PendingDeliveryStatus: String, Codable, CaseIterable, Sendable {
    case sent = "SENT"
    case delivered = "DELIVERED"
    case viewed = "VIEWED"

    var deliveryStatus: DeliveryStatus {
        switch self {
        case .sent: .sent
        case .delivered: .delivered
        case .viewed: .viewed
        }
    }
}

enum ResponseEventType: String, Codable, CaseIterable, Sendable {
    case fallAssistance = "FALL_ASSISTANCE"

    var displayText: String {
        switch self {
        case .fallAssistance: "跌倒救助"
        }
    }
}

enum ResponsePositioningTier: String, Codable, CaseIterable, Sendable {
    case searchRing = "SEARCH_RING"
}

enum ResponseDistanceRange: String, Codable, CaseIterable, Sendable {
    case zeroTo500Meters = "DISTANCE_0_500M"
    case from500To1000Meters = "DISTANCE_500_1000M"
    case from1000To1500Meters = "DISTANCE_1000_1500M"
    case from1500To2000Meters = "DISTANCE_1500_2000M"
    case over2000Meters = "DISTANCE_OVER_2000M"

    var displayText: String {
        switch self {
        case .zeroTo500Meters: "0–500 米"
        case .from500To1000Meters: "500–1000 米"
        case .from1000To1500Meters: "1000–1500 米"
        case .from1500To2000Meters: "1500–2000 米"
        case .over2000Meters: "超过 2000 米"
        }
    }
}

enum ResponseEtaRange: String, Codable, CaseIterable, Sendable {
    case zeroTo5Minutes = "ETA_0_5_MIN"
    case from5To10Minutes = "ETA_5_10_MIN"
    case from10To15Minutes = "ETA_10_15_MIN"
    case over15Minutes = "ETA_OVER_15_MIN"

    var displayText: String {
        switch self {
        case .zeroTo5Minutes: "0–5 分钟"
        case .from5To10Minutes: "5–10 分钟"
        case .from10To15Minutes: "10–15 分钟"
        case .over15Minutes: "超过 15 分钟"
        }
    }
}

enum ResponseOfferExpirationReason: String, Codable, Sendable {
    case offerExpired = "OFFER_EXPIRED"
    case noLongerEligible = "OFFER_NO_LONGER_ELIGIBLE"
}

struct ResponseOfferExpired: Codable, Equatable, Sendable {
    let eventId: String
    let deliveryId: String
    let expiresAt: Date
    let reason: ResponseOfferExpirationReason
}

enum ResponseDecision: String, Codable, CaseIterable, Sendable {
    case accept = "ACCEPT"
    case refuse = "REFUSE"
}

enum AssignmentRole: String, Codable, CaseIterable, Sendable {
    case goToPatient = "GO_TO_PATIENT"
    case fetchAed = "FETCH_AED"
}

enum AssignmentStatus: String, Codable, CaseIterable, Sendable {
    case assigned = "ASSIGNED"
    case enRoute = "EN_ROUTE"
    case arrivedAtAed = "ARRIVED_AT_AED"
    case aedAcquired = "AED_ACQUIRED"
    case enRouteToPatient = "EN_ROUTE_TO_PATIENT"
    case arrivedAtPatient = "ARRIVED_AT_PATIENT"
    case completed = "COMPLETED"
    case aedUnavailable = "AED_UNAVAILABLE"
    case timedOut = "TIMED_OUT"
    case cancelled = "CANCELLED"

    var isTerminal: Bool {
        [.completed, .aedUnavailable, .timedOut, .cancelled].contains(self)
    }

    /// The backend keeps COMPLETED and AED_UNAVAILABLE responders in the
    /// active event projection.  Only an explicit timeout or cancellation
    /// ends this device's event participation and position-batch authority.
    var endsEventParticipation: Bool {
        self == .timedOut || self == .cancelled
    }
}

struct SimulationMarker: Codable, Hashable, Sendable {
    enum Label: String, Codable, Sendable {
        case simulatedTest = "SIMULATED_TEST"
    }
    let runId: UUID
    let label: Label
}

struct EmergencyEvent: Codable, Identifiable, Hashable, Sendable {
    var simulation: SimulationMarker? = nil
    let id: String
    var state: EventState
    var recruitmentState: RecruitmentState
    /// Server-authoritative permission for this authenticated device to write
    /// the event position stream.  This is deliberately non-optional: an
    /// omitted flag must fail closed during decoding.
    let canPublishEventPosition: Bool
    /// Trigger details are omitted by the server for responder projections;
    /// the iPhone client only needs them in the patient's projection.
    let triggerSource: TriggerSource?
    let fallDetectedAt: Date?
    let fallResolution: FallResolution?
    let callFirstObservedAt: Date?
    let patientPosition: PatientPosition?
    let patientPositionSource: PatientPositionSource?
    let patientPositionObservedAt: Date?
    let patientPositionServerReceivedAt: Date?
    let patientLocationCard: PatientLocationCard?
    let viewerRelationship: ViewerRelationship
    /// Coordination is intentionally absent from a pre-acceptance offer.
    let coordination: CoordinationSummary?
    let createdAt: Date
    var resolvedAt: Date?
    /// Device-specific, server-authoritative event-position write window.
    /// Both keys are present in the v2 projection and decode to nil for a
    /// viewer/device without event-position authority.  `endedAt` is
    /// exclusive.
    let eventPositionParticipationStartedAt: Date?
    let eventPositionParticipationEndedAt: Date?
    let pendingResponseRequest: ResponseRequest?
    let statusConfirmation: StatusConfirmation?
    let currentAssignment: Assignment?

    init(
        id: String,
        state: EventState,
        recruitmentState: RecruitmentState,
        canPublishEventPosition: Bool,
        triggerSource: TriggerSource?,
        fallDetectedAt: Date?,
        fallResolution: FallResolution?,
        callFirstObservedAt: Date?,
        patientPosition: PatientPosition?,
        patientPositionSource: PatientPositionSource? = nil,
        patientPositionObservedAt: Date? = nil,
        patientPositionServerReceivedAt: Date? = nil,
        patientLocationCard: PatientLocationCard?,
        viewerRelationship: ViewerRelationship,
        coordination: CoordinationSummary? = .empty,
        createdAt: Date,
        resolvedAt: Date?,
        eventPositionParticipationStartedAt: Date? = nil,
        eventPositionParticipationEndedAt: Date? = nil,
        pendingResponseRequest: ResponseRequest?,
        statusConfirmation: StatusConfirmation? = nil,
        currentAssignment: Assignment?
    ) {
        self.id = id
        self.state = state
        self.recruitmentState = recruitmentState
        self.canPublishEventPosition = canPublishEventPosition
        self.triggerSource = triggerSource
        self.fallDetectedAt = fallDetectedAt
        self.fallResolution = fallResolution
        self.callFirstObservedAt = callFirstObservedAt
        self.patientPosition = patientPosition
        self.patientPositionSource = patientPositionSource
        self.patientPositionObservedAt = patientPositionObservedAt
        self.patientPositionServerReceivedAt = patientPositionServerReceivedAt
        self.patientLocationCard = patientLocationCard
        self.viewerRelationship = viewerRelationship
        self.coordination = coordination
        self.createdAt = createdAt
        self.resolvedAt = resolvedAt
        self.eventPositionParticipationStartedAt = eventPositionParticipationStartedAt
        self.eventPositionParticipationEndedAt = eventPositionParticipationEndedAt
        self.pendingResponseRequest = pendingResponseRequest
        self.statusConfirmation = statusConfirmation
        self.currentAssignment = currentAssignment
    }

    private enum CodingKeys: String, CodingKey {
        case id, state, recruitmentState, canPublishEventPosition
        case triggerSource, fallDetectedAt, fallResolution, callFirstObservedAt
        case patientPosition, patientPositionSource, patientPositionObservedAt
        case patientPositionServerReceivedAt, patientLocationCard, viewerRelationship
        case coordination, createdAt, resolvedAt
        case eventPositionParticipationStartedAt, eventPositionParticipationEndedAt
        case pendingResponseRequest, statusConfirmation, currentAssignment
        case simulation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.eventPositionParticipationStartedAt),
              container.contains(.eventPositionParticipationEndedAt)
        else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "EmergencyEvent requires both device-specific participation-window keys."
                )
            )
        }
        let canPublish = try container.decode(Bool.self, forKey: .canPublishEventPosition)
        let participationStart = try container.decodeIfPresent(
            Date.self,
            forKey: .eventPositionParticipationStartedAt
        )
        let participationEnd = try container.decodeIfPresent(
            Date.self,
            forKey: .eventPositionParticipationEndedAt
        )
        guard !canPublish || participationStart != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .eventPositionParticipationStartedAt,
                in: container,
                debugDescription: "canPublishEventPosition=true requires a non-null participation start."
            )
        }
        self.init(
            id: try container.decode(String.self, forKey: .id),
            state: try container.decode(EventState.self, forKey: .state),
            recruitmentState: try container.decode(RecruitmentState.self, forKey: .recruitmentState),
            canPublishEventPosition: canPublish,
            triggerSource: try container.decodeIfPresent(TriggerSource.self, forKey: .triggerSource),
            fallDetectedAt: try container.decodeIfPresent(Date.self, forKey: .fallDetectedAt),
            fallResolution: try container.decodeIfPresent(FallResolution.self, forKey: .fallResolution),
            callFirstObservedAt: try container.decodeIfPresent(Date.self, forKey: .callFirstObservedAt),
            patientPosition: try container.decodeIfPresent(PatientPosition.self, forKey: .patientPosition),
            patientPositionSource: try container.decodeIfPresent(
                PatientPositionSource.self,
                forKey: .patientPositionSource
            ),
            patientPositionObservedAt: try container.decodeIfPresent(
                Date.self,
                forKey: .patientPositionObservedAt
            ),
            patientPositionServerReceivedAt: try container.decodeIfPresent(
                Date.self,
                forKey: .patientPositionServerReceivedAt
            ),
            patientLocationCard: try container.decodeIfPresent(
                PatientLocationCard.self,
                forKey: .patientLocationCard
            ),
            viewerRelationship: try container.decode(
                ViewerRelationship.self,
                forKey: .viewerRelationship
            ),
            coordination: try container.decodeIfPresent(
                CoordinationSummary.self,
                forKey: .coordination
            ),
            createdAt: try container.decode(Date.self, forKey: .createdAt),
            resolvedAt: try container.decodeIfPresent(Date.self, forKey: .resolvedAt),
            eventPositionParticipationStartedAt: participationStart,
            eventPositionParticipationEndedAt: participationEnd,
            pendingResponseRequest: try container.decodeIfPresent(
                ResponseRequest.self,
                forKey: .pendingResponseRequest
            ),
            statusConfirmation: try container.decodeIfPresent(
                StatusConfirmation.self,
                forKey: .statusConfirmation
            ),
            currentAssignment: try container.decodeIfPresent(
                Assignment.self,
                forKey: .currentAssignment
            )
        )
        simulation = try container.decodeIfPresent(SimulationMarker.self, forKey: .simulation)
        guard simulation == nil || simulation?.runId == UUID(uuidString: id),
              triggerSource != .simulatedTest || simulation != nil,
              simulation == nil || triggerSource == nil || triggerSource == .simulatedTest,
              simulation == nil || (fallDetectedAt == nil && fallResolution == nil && callFirstObservedAt == nil)
        else {
            throw DecodingError.dataCorruptedError(forKey: .simulation, in: container,
                debugDescription: "Simulation must be explicit, event-bound, and contain no system Fall evidence.")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(state, forKey: .state)
        try container.encode(recruitmentState, forKey: .recruitmentState)
        try container.encode(canPublishEventPosition, forKey: .canPublishEventPosition)
        try container.encodeIfPresent(simulation, forKey: .simulation)
        try container.encodeIfPresent(triggerSource, forKey: .triggerSource)
        try container.encodeIfPresent(fallDetectedAt, forKey: .fallDetectedAt)
        try container.encodeIfPresent(fallResolution, forKey: .fallResolution)
        try container.encodeIfPresent(callFirstObservedAt, forKey: .callFirstObservedAt)
        try container.encodeIfPresent(patientPosition, forKey: .patientPosition)
        try container.encodeIfPresent(patientPositionSource, forKey: .patientPositionSource)
        try container.encodeIfPresent(patientPositionObservedAt, forKey: .patientPositionObservedAt)
        try container.encodeIfPresent(
            patientPositionServerReceivedAt,
            forKey: .patientPositionServerReceivedAt
        )
        try container.encodeIfPresent(patientLocationCard, forKey: .patientLocationCard)
        try container.encode(viewerRelationship, forKey: .viewerRelationship)
        try container.encodeIfPresent(coordination, forKey: .coordination)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(resolvedAt, forKey: .resolvedAt)
        // Unlike ordinary optional projection fields these two keys are a
        // required nullable contract. Explicit Optional encoding preserves
        // JSON null instead of omitting a missing authority boundary.
        try container.encode(
            eventPositionParticipationStartedAt,
            forKey: .eventPositionParticipationStartedAt
        )
        try container.encode(
            eventPositionParticipationEndedAt,
            forKey: .eventPositionParticipationEndedAt
        )
        try container.encodeIfPresent(pendingResponseRequest, forKey: .pendingResponseRequest)
        try container.encodeIfPresent(statusConfirmation, forKey: .statusConfirmation)
        try container.encodeIfPresent(currentAssignment, forKey: .currentAssignment)
    }
}

struct CoordinationSummary: Codable, Hashable, Sendable {
    let revision: Int
    let nearbyCandidateCount: Int
    let pendingOfferCount: Int
    let acceptedResponderCount: Int
    let goToPatientCount: Int
    let fetchAedCount: Int
    let enRouteCount: Int
    let arrivedAtAedCount: Int
    let arrivedAtPatientCount: Int
    let aedAcquiredCount: Int
    let completedAssignmentCount: Int

    static let empty = CoordinationSummary(
        revision: 1,
        nearbyCandidateCount: 0,
        pendingOfferCount: 0,
        acceptedResponderCount: 0,
        goToPatientCount: 0,
        fetchAedCount: 0,
        enRouteCount: 0,
        arrivedAtAedCount: 0,
        arrivedAtPatientCount: 0,
        aedAcquiredCount: 0,
        completedAssignmentCount: 0
    )
}

struct Aed: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let aedPosition: AedPosition
    let openFrom: String
    let openUntil: String
    let floor: String
    let floorTransferSeconds: Int
    let accessNote: String
    let accessDelaySeconds: Int
    let verificationSeconds: Int
    let available: Bool
}

struct AedRoute: Codable, Hashable, Sendable {
    let aedId: String
    let responderPosition: ResponderPosition
    let aedPosition: AedPosition
    let patientPosition: PatientPosition
    let etaSeconds: Int
    let walkingSeconds: Int
    let overheadSeconds: Int

    var pathKinds: [PositionKind] { [.responder, .aed, .patient] }

    private enum CodingKeys: String, CodingKey {
        case aedId, path, etaSeconds, walkingSeconds, overheadSeconds
    }

    init(
        aedId: String,
        responderPosition: ResponderPosition,
        aedPosition: AedPosition,
        patientPosition: PatientPosition,
        etaSeconds: Int,
        walkingSeconds: Int,
        overheadSeconds: Int
    ) {
        self.aedId = aedId
        self.responderPosition = responderPosition
        self.aedPosition = aedPosition
        self.patientPosition = patientPosition
        self.etaSeconds = etaSeconds
        self.walkingSeconds = walkingSeconds
        self.overheadSeconds = overheadSeconds
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let path = try container.decode([StrictPosition].self, forKey: .path)
        guard path.count == 3,
              case let .responder(responderPosition) = path[0],
              case let .aed(aedPosition) = path[1],
              case let .patient(patientPosition) = path[2]
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .path,
                in: container,
                debugDescription: "AED route path must be exactly R -> A -> P."
            )
        }
        self.init(
            aedId: try container.decode(String.self, forKey: .aedId),
            responderPosition: responderPosition,
            aedPosition: aedPosition,
            patientPosition: patientPosition,
            etaSeconds: try container.decode(Int.self, forKey: .etaSeconds),
            walkingSeconds: try container.decode(Int.self, forKey: .walkingSeconds),
            overheadSeconds: try container.decode(Int.self, forKey: .overheadSeconds)
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(aedId, forKey: .aedId)
        try container.encode(
            [
                StrictPosition.responder(responderPosition),
                StrictPosition.aed(aedPosition),
                StrictPosition.patient(patientPosition)
            ],
            forKey: .path
        )
        try container.encode(etaSeconds, forKey: .etaSeconds)
        try container.encode(walkingSeconds, forKey: .walkingSeconds)
        try container.encode(overheadSeconds, forKey: .overheadSeconds)
    }
}

struct ResponseRequest: Codable, Hashable, Sendable {
    var simulation: SimulationMarker? = nil
    let schemaVersion: String
    let messageId: String
    let eventId: String
    let deliveryId: String
    let deliveryStatus: PendingDeliveryStatus
    let occurredAt: Date
    let eventType: ResponseEventType
    let positioningTier: ResponsePositioningTier
    let distanceRange: ResponseDistanceRange
    let etaRange: ResponseEtaRange
    let currentRecruitmentRadiusMeters: Int
    let expiresAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case simulation
        case schemaVersion
        case messageId
        case eventId
        case deliveryId
        case deliveryStatus
        case occurredAt
        case eventType
        case positioningTier
        case distanceRange
        case etaRange
        case currentRecruitmentRadiusMeters
        case expiresAt
    }

    private struct AnyCodingKey: CodingKey {
        let stringValue: String
        let intValue: Int?

        init?(stringValue: String) {
            self.stringValue = stringValue
            intValue = nil
        }

        init?(intValue: Int) {
            stringValue = String(intValue)
            self.intValue = intValue
        }
    }

    init(
        schemaVersion: String,
        messageId: String,
        eventId: String,
        deliveryId: String,
        deliveryStatus: PendingDeliveryStatus,
        occurredAt: Date,
        eventType: ResponseEventType,
        positioningTier: ResponsePositioningTier,
        distanceRange: ResponseDistanceRange,
        etaRange: ResponseEtaRange,
        currentRecruitmentRadiusMeters: Int,
        expiresAt: Date
    ) {
        self.schemaVersion = schemaVersion
        self.messageId = messageId
        self.eventId = eventId
        self.deliveryId = deliveryId
        self.deliveryStatus = deliveryStatus
        self.occurredAt = occurredAt
        self.eventType = eventType
        self.positioningTier = positioningTier
        self.distanceRange = distanceRange
        self.etaRange = etaRange
        self.currentRecruitmentRadiusMeters = currentRecruitmentRadiusMeters
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let rawContainer = try decoder.container(keyedBy: AnyCodingKey.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let allowedKeys = Set(CodingKeys.allCases.map(\.stringValue))
        let unknownKeys = rawContainer.allKeys
            .map(\.stringValue)
            .filter { !allowedKeys.contains($0) }
        guard unknownKeys.isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "ResponseRequest contains fields unavailable before acceptance: \(unknownKeys.joined(separator: ", "))."
                )
            )
        }
        let schemaVersion = try container.decode(String.self, forKey: .schemaVersion)
        let messageId = try container.decode(String.self, forKey: .messageId)
        let eventId = try container.decode(String.self, forKey: .eventId)
        let deliveryId = try container.decode(String.self, forKey: .deliveryId)
        guard schemaVersion == "2.0",
              !messageId.isEmpty,
              !eventId.isEmpty,
              !deliveryId.isEmpty
        else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "ResponseRequest identity or schema is invalid."
                )
            )
        }
        let eventType = try container.decode(ResponseEventType.self, forKey: .eventType)
        let positioningTier = try container.decode(
            ResponsePositioningTier.self,
            forKey: .positioningTier
        )
        guard eventType == .fallAssistance, positioningTier == .searchRing else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "ResponseRequest event type or positioning tier is invalid."
                )
            )
        }
        let radius = try container.decode(Int.self, forKey: .currentRecruitmentRadiusMeters)
        guard [1_000, 1_500, 2_000].contains(radius) else {
            throw DecodingError.dataCorruptedError(
                forKey: .currentRecruitmentRadiusMeters,
                in: container,
                debugDescription: "Recruitment radius is outside the v2 contract."
            )
        }
        self.init(
            schemaVersion: schemaVersion,
            messageId: messageId,
            eventId: eventId,
            deliveryId: deliveryId,
            deliveryStatus: try container.decode(
                PendingDeliveryStatus.self,
                forKey: .deliveryStatus
            ),
            occurredAt: try container.decode(Date.self, forKey: .occurredAt),
            eventType: eventType,
            positioningTier: positioningTier,
            distanceRange: try container.decode(
                ResponseDistanceRange.self,
                forKey: .distanceRange
            ),
            etaRange: try container.decode(ResponseEtaRange.self, forKey: .etaRange),
            currentRecruitmentRadiusMeters: radius,
            expiresAt: try container.decode(Date.self, forKey: .expiresAt)
        )
        simulation = try container.decodeIfPresent(SimulationMarker.self, forKey: .simulation)
        guard simulation == nil || simulation?.runId == UUID(uuidString: eventId) else {
            throw DecodingError.dataCorruptedError(forKey: .simulation, in: container,
                debugDescription: "Simulation marker must match this response request event.")
        }
    }

    func isExpired(at date: Date) -> Bool {
        date > expiresAt
    }
}

struct AedAcquiredReceipt: Codable, Identifiable, Hashable, Sendable {
    let receiptId: String
    let eventId: String
    let assignmentId: String
    let aedId: String
    let acquiredAt: Date

    var id: String { receiptId }

    var businessKey: String {
        "\(eventId)|\(assignmentId)|\(aedId)"
    }
}

struct Assignment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let eventId: String
    let role: AssignmentRole
    var status: AssignmentStatus
    let revision: Int
    let route: AedRoute?
    var aedAcquiredReceipt: AedAcquiredReceipt?
}

enum TimelineEntryKind: String, Codable, Sendable {
    case watchFallHelpConfirmed = "WATCH_FALL_HELP_CONFIRMED"
    case watchFallNoResponseOutgoingCallObserved =
        "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED"
    case eventActivated = "EVENT_ACTIVATED"
    case responseRequested = "RESPONSE_REQUESTED"
    case receiptAdvanced = "RECEIPT_ADVANCED"
    case responseAccepted = "RESPONSE_ACCEPTED"
    case responseRefused = "RESPONSE_REFUSED"
    case assignmentCreated = "ASSIGNMENT_CREATED"
    case assignmentUpdated = "ASSIGNMENT_UPDATED"
    case aedAcquired = "AED_ACQUIRED"
    case aedUnavailable = "AED_UNAVAILABLE"
    case assignmentTimedOut = "ASSIGNMENT_TIMED_OUT"
    case falseAlarmConfirmed = "FALSE_ALARM_CONFIRMED"
    case eventResolved = "EVENT_RESOLVED"
    case passiveObservation = "PASSIVE_OBSERVATION"
    case connection = "CLIENT_CONNECTION"
}

struct TimelineEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let eventId: String
    let occurredAt: Date
    let kind: TimelineEntryKind
    let message: String
}

enum WatchObservationKind: String, Codable, Sendable {
    case fallContext = "FALL_CONTEXT"
}

enum WatchAppHelpResponse: String, Codable, Sendable {
    case needsHelp = "NEEDS_HELP"
    case noResponse = "NO_RESPONSE"
}

enum CallObservationSemantics: String, Codable, Sendable {
    case firstObservedOutgoingState = "FIRST_OBSERVED_OUTGOING_STATE"
}

struct WatchEmergencyObservation: Codable, Hashable, Sendable {
    let schemaVersion: String
    let eventId: String
    let observationKind: WatchObservationKind
    let fallDetectedAt: Date
    let fallResolution: FallResolution
    let appHelpResponse: WatchAppHelpResponse
    let callFirstObservedAt: Date?
    let callObservationSemantics: CallObservationSemantics?
    let patientPosition: PatientPosition?
    let patientPositionObservedAt: Date?
    let locationUnavailableReason: String?

    init(
        eventId: String,
        fallDetectedAt: Date,
        fallResolution: FallResolution,
        appHelpResponse: WatchAppHelpResponse,
        callFirstObservedAt: Date? = nil,
        patientPosition: PatientPosition?,
        patientPositionObservedAt: Date? = nil,
        locationUnavailableReason: String?
    ) {
        schemaVersion = "2.0"
        self.eventId = eventId
        observationKind = .fallContext
        self.fallDetectedAt = fallDetectedAt
        self.fallResolution = fallResolution
        self.appHelpResponse = appHelpResponse
        self.callFirstObservedAt = callFirstObservedAt
        self.callObservationSemantics = appHelpResponse == .noResponse
            ? .firstObservedOutgoingState
            : nil
        self.patientPosition = patientPosition
        self.patientPositionObservedAt = patientPositionObservedAt
        self.locationUnavailableReason = locationUnavailableReason
    }

    var isContractValid: Bool {
        guard schemaVersion == "2.0",
              observationKind == .fallContext,
              patientPosition != nil || locationUnavailableReason != nil
        else { return false }
        if let patientPositionObservedAt {
            guard patientPosition != nil, patientPositionObservedAt.timeIntervalSince1970.isFinite
            else { return false }
        }
        switch appHelpResponse {
        case .needsHelp:
            return callFirstObservedAt == nil && callObservationSemantics == nil
        case .noResponse:
            guard let callFirstObservedAt,
                  callObservationSemantics == .firstObservedOutgoingState
            else { return false }
            let interval = callFirstObservedAt.timeIntervalSince(fallDetectedAt)
            return interval >= 0 && interval <= 120
        }
    }
}

struct DemoScenario: Codable, Sendable {
    struct Patient: Codable, Sendable {
        let id: String
        let patientPosition: PatientPosition
        let patientLocationCard: PatientLocationCard
    }

    struct Responder: Codable, Sendable {
        let id: String
        let responderPosition: ResponderPosition
    }

    struct ExpectedRoleCounts: Codable, Equatable, Sendable {
        let goToPatient: Int
        let fetchAed: Int
    }

    let schemaVersion: String
    let agreementVersions: AgreementVersions
    let safeTestNumber: String
    let watchObservation: WatchEmergencyObservation
    let patient: Patient
    let responders: [Responder]
    let aeds: [Aed]
    let expectedRoleCountsByAcceptedCount: [String: ExpectedRoleCounts]
    let expectedAedPathKinds: [PositionKind]
    let aedAcquiredReceipt: AedAcquiredReceipt
}

/// A formatter is expensive to construct. Reuse it within a codec operation,
/// with locking so date callbacks never concurrently mutate Foundation state.
private final class ContractTimestampCodec: @unchecked Sendable {
    private let lock = NSLock()
    private let fractional = ISO8601DateFormatter()
    private let whole = ISO8601DateFormatter()

    init() {
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        whole.formatOptions = [.withInternetDateTime]
    }

    func date(from value: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        return fractional.date(from: value) ?? whole.date(from: value)
    }

    func string(from date: Date) -> String {
        lock.lock()
        defer { lock.unlock() }
        return fractional.string(from: date)
    }
}

extension JSONDecoder {
    static func contractDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        let timestamps = ContractTimestampCodec()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = timestamps.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO-8601 timestamp."
            )
        }
        return decoder
    }
}

extension JSONEncoder {
    static func contractEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        let timestamps = ContractTimestampCodec()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            // ISO8601DateFormatter rounds to milliseconds.  A source fix at
            // .9995/.9996 would therefore cross into the next second and no
            // longer match its immutable slotAt.  Truncate first so transport
            // and protected-queue round trips can never move a fact forward
            // across a slot boundary.
            let milliseconds = floor(date.timeIntervalSince1970 * 1_000)
            let wireDate = Date(timeIntervalSince1970: milliseconds / 1_000)
            var container = encoder.singleValueContainer()
            try container.encode(timestamps.string(from: wireDate))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
