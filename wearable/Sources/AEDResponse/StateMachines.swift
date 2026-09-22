import Foundation

enum StateTransitionError: Error, Equatable, LocalizedError {
    case invalidEventTransition(from: EventState, action: String)
    case invalidReceiptTransition(from: DeliveryStatus, to: DeliveryStatus)
    case invalidAcceptedCount(Int)
    case conflictingAedReceipt(String)

    var errorDescription: String? {
        switch self {
        case let .invalidEventTransition(state, action):
            "事件状态 \(state.rawValue) 不允许执行 \(action)。"
        case let .invalidReceiptTransition(current, next):
            "回执不允许从 \(current.rawValue) 变更为 \(next.rawValue)。"
        case let .invalidAcceptedCount(count):
            "有效接受人数 \(count) 不能小于 0。"
        case let .conflictingAedReceipt(receiptID):
            "AED 获取回执 \(receiptID) 与已记录内容冲突。"
        }
    }
}

enum PassiveFollowUpObservation: String, CaseIterable, Sendable {
    case recoveredMotion = "RECOVERED_MOTION"
    case heartRateRecovered = "HEART_RATE_RECOVERED"
    case callEnded = "CALL_ENDED"
    case watchUnreachable = "WATCH_UNREACHABLE"
}

enum ResolutionActor: String, Codable, Sendable {
    case patient = "PATIENT"
    case onSceneResponder = "ON_SCENE_RESPONDER"
    case authorizedOperator = "AUTHORIZED_OPERATOR"
}

struct EmergencyEventMachine: Sendable {
    private(set) var event: EmergencyEvent

    init(event: EmergencyEvent) {
        self.event = event
    }

    mutating func confirmFalseAlarm(at date: Date) throws {
        guard event.state == .active else {
            throw StateTransitionError.invalidEventTransition(
                from: event.state,
                action: "CONFIRM_FALSE_ALARM"
            )
        }
        event.state = .cancelledConfirmedFalseAlarm
        event.recruitmentState = .stopped
        event.resolvedAt = date
    }

    mutating func resolve(by _: ResolutionActor, at date: Date) throws {
        guard event.state == .active else {
            throw StateTransitionError.invalidEventTransition(
                from: event.state,
                action: "RESOLVE"
            )
        }
        event.state = .resolved
        event.recruitmentState = .completed
        event.resolvedAt = date
    }

    @discardableResult
    mutating func observePassive(_ observation: PassiveFollowUpObservation) -> Bool {
        _ = observation
        return false
    }
}

struct DeliveryReceiptMachine: Sendable {
    private(set) var status: DeliveryStatus

    init(status: DeliveryStatus = .sent) {
        self.status = status
    }

    @discardableResult
    mutating func advance(to next: DeliveryStatus) throws -> Bool {
        if next == status { return false }

        let allowed: Bool = switch (status, next) {
        case (.sent, .delivered), (.delivered, .viewed): true
        case (.viewed, .accepted), (.viewed, .refused): true
        default: false
        }
        guard allowed else {
            throw StateTransitionError.invalidReceiptTransition(from: status, to: next)
        }
        status = next
        return true
    }

    mutating func expire() throws {
        guard !status.isTerminal else {
            throw StateTransitionError.invalidReceiptTransition(from: status, to: .expired)
        }
        status = .expired
    }
}

struct AssignmentPlan: Equatable, Sendable {
    let acceptedCount: Int
    let patientCount: Int
    let aedCount: Int

    func count(for role: AssignmentRole) -> Int {
        switch role {
        case .goToPatient: patientCount
        case .fetchAed: aedCount
        }
    }
}

enum AssignmentPlanner {
    static func plan(forAcceptedCount acceptedCount: Int) throws -> AssignmentPlan {
        guard acceptedCount >= 0 else {
            throw StateTransitionError.invalidAcceptedCount(acceptedCount)
        }
        let aedCount = Int(floor(Double(acceptedCount) / 3.0 + 0.5))
        let patientCount = acceptedCount - aedCount
        return AssignmentPlan(
            acceptedCount: acceptedCount,
            patientCount: patientCount,
            aedCount: aedCount
        )
    }
}

enum AedReceiptRecordResult: Equatable, Sendable {
    case recorded(AedAcquiredReceipt)
    case idempotent(AedAcquiredReceipt)
}

struct AedAcquiredReceiptMachine: Sendable {
    private var byReceiptID: [String: AedAcquiredReceipt] = [:]
    private var byBusinessKey: [String: AedAcquiredReceipt] = [:]

    mutating func record(_ receipt: AedAcquiredReceipt) throws -> AedReceiptRecordResult {
        if let existing = byReceiptID[receipt.receiptId] {
            guard existing == receipt else {
                throw StateTransitionError.conflictingAedReceipt(receipt.receiptId)
            }
            return .idempotent(byBusinessKey[existing.businessKey] ?? existing)
        }
        if let existing = byBusinessKey[receipt.businessKey] {
            // Preserve the exact request for this ID while returning the
            // original business receipt for every equivalent request.
            byReceiptID[receipt.receiptId] = receipt
            return .idempotent(existing)
        }
        byReceiptID[receipt.receiptId] = receipt
        byBusinessKey[receipt.businessKey] = receipt
        return .recorded(receipt)
    }
}
