import Foundation
import XCTest
@testable import AEDResponse

final class ArchitectureBoundaryTests: XCTestCase {
    override func setUpWithError() throws {
        let marker = repositoryRoot.appending(path: "ios/project.yml")
        guard FileManager.default.fileExists(atPath: marker.path) else {
            throw XCTSkip("源码边界检查需要本机仓库；真机只运行可移植的领域与契约测试。")
        }
    }

    func testDomainHasNoPlatformOrAdapterImports() throws {
        let source = try combinedSwiftSource(in: repositoryRoot.appending(path: "ios/AEDResponse/Domain"))
        for forbidden in ["SwiftUI", "UIKit", "CoreLocation", "CoreMotion", "CallKit", "SocketIO"] {
            XCTAssertFalse(source.contains("import \(forbidden)"), "Domain 不得导入 \(forbidden)")
        }
    }

    func testIPhoneSourceCannotObserveFallOrCallsForTriggering() throws {
        let source = try recursiveSwiftSource(in: repositoryRoot.appending(path: "ios/AEDResponse"))
        for forbidden in [
            "import CoreMotion",
            "import CallKit",
            "CMFallDetectionManager",
            "CXCallObserver(",
            "import CoreBluetooth",
            "import MultipeerConnectivity",
            "import NearbyInteraction",
            "func startSOS(",
            "PENDING_CANCEL",
            "GUIDE_AMBULANCE"
        ] {
            XCTAssertFalse(source.contains(forbidden), "iPhone v2 不得包含触发能力：\(forbidden)")
        }
        XCTAssertTrue(source.contains("import WatchConnectivity"))
        for forbiddenTransfer in [
            ".sendMessageData(",
            ".transferUserInfo(",
            ".updateApplicationContext(",
            ".transferFile("
        ] {
            XCTAssertFalse(
                source.contains(forbiddenTransfer),
                "WCSession 仅激活可达性，不得传输业务数据：\(forbiddenTransfer)"
            )
        }
        XCTAssertTrue(source.contains("CompanionLinkTransferring"))
        XCTAssertTrue(source.contains("sendCompanionLink"))
        XCTAssertTrue(source.contains("envelope.propertyList()"))
        XCTAssertTrue(source.contains("nonisolated func session("))
        XCTAssertTrue(source.contains("Task { @MainActor [weak self] in"))
    }

    func testIPhonePositionTruthUsesTypedRestAndSocketIsNotificationOnly() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let latestPositionCoordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/LatestPositionUploadCoordinator.swift"
            ),
            encoding: .utf8
        )
        let latestPositionPolicy = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Domain/LatestPositionUploadPolicy.swift"
            ),
            encoding: .utf8
        )
        let ports = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Application/Ports.swift"),
            encoding: .utf8
        )
        let socket = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Networking/SocketIOEventStream.swift"
            ),
            encoding: .utf8
        )
        let apiClient = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Networking/APIClient.swift"
            ),
            encoding: .utf8
        )

        XCTAssertTrue(appStore.contains("LatestPositionUploadCoordinator"))
        XCTAssertTrue(latestPositionCoordinator.contains("updateResponderPosition"))
        XCTAssertFalse(appStore.contains("drainPositionUploads"))
        XCTAssertFalse(latestPositionPolicy.contains("EmergencyAPIClient"))
        XCTAssertFalse(latestPositionPolicy.contains("IntegrationDiagnostics"))
        XCTAssertTrue(appStore.contains("captureEventPositionSlot"))
        XCTAssertFalse(appStore.contains("sendEventPositionBatch"))
        XCTAssertTrue(appStore.contains("eventPositionBatchUploadCoordinator"))
        XCTAssertTrue(appStore.contains("eventPositionQueueStore"))
        XCTAssertTrue(appStore.contains("canPublishEventPosition"))
        XCTAssertTrue(appStore.contains("viewerRelationship == .patient"))
        XCTAssertTrue(appStore.contains("gapReason: .noFix"))
        XCTAssertTrue(appStore.contains("eventPositionCandidatesBySlot"))
        XCTAssertTrue(appStore.contains("persistOpenEventPositionDraft"))
        XCTAssertTrue(appStore.contains("lastFinalizedSlotAtByContext"))
        XCTAssertTrue(appStore.contains("cumulativeMovementMeters"))
        XCTAssertTrue(latestPositionCoordinator.contains("positionUpdateId"))
        XCTAssertTrue(appStore.contains("startContinuousUpdates"))
        XCTAssertTrue(ports.contains("updatePresence"))
        XCTAssertFalse(socket.contains("responder:position"))
        XCTAssertFalse(socket.contains("emitResponderPosition"))
        XCTAssertFalse(socket.contains("delivery:receipt"))
        XCTAssertFalse(socket.contains("socket.emit"))
        XCTAssertFalse(ports.contains("emitReceipt"))
        XCTAssertFalse(appStore.contains("pendingDeliveryReceipts"))
        XCTAssertFalse(appStore.contains("try? await apiClient.sendReceipt"))
        XCTAssertTrue(socket.contains("event:patient-position-updated"))
        XCTAssertTrue(socket.contains("event:coordination-updated"))
        XCTAssertTrue(apiClient.contains("position-batches/\\(batchID)"))

        // After the batch-upload and receipt-upload seams, the port and the
        // owning coordinator carry the transport calls, and each coordinator
        // stays the only drain owner instead of AppStore.
        let batchUploadCoordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionBatchUploadCoordinator.swift"
            ),
            encoding: .utf8
        )
        let receiptUploadCoordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/DeliveryReceiptUploadCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(batchUploadCoordinator.contains("func start("))
        XCTAssertTrue(batchUploadCoordinator.contains("sendEventPositionBatch("))
        XCTAssertTrue(receiptUploadCoordinator.contains("func enqueue("))
        XCTAssertTrue(receiptUploadCoordinator.contains("sendReceipt("))
        XCTAssertTrue(ports.contains("func sendEventPositionBatch("))
        XCTAssertTrue(ports.contains("func sendReceipt("))

        let models = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Domain/Models.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(models.contains("let slotAt: Date"))
        XCTAssertTrue(models.contains("let fixObservedAt: Date?"))
        XCTAssertTrue(models.contains("let gapReason: EventPositionGapReason?"))
        XCTAssertTrue(models.contains("case appNotRunning = \"APP_NOT_RUNNING\""))
    }

    func testConnectionRetrySchedulingHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/ConnectionRetryCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("connectionRetryCoordinator"))
        XCTAssertFalse(appStore.contains("reconnectTask"))
        XCTAssertFalse(appStore.contains("reconnectAttempt"))
        XCTAssertFalse(appStore.contains("private var desiredBaseURL"))
        let oldDesiredBaseURLAssignment = appStore.split(separator: "\n").contains { line in
            let line = String(line)
            return line.contains("desiredBaseURL =")
                && !line.contains("==")
                && !line.contains("!=")
        }
        XCTAssertFalse(oldDesiredBaseURLAssignment)
        XCTAssertTrue(coordinator.contains("scheduleIfNeeded"))
        XCTAssertTrue(coordinator.contains("markConnected"))
        XCTAssertTrue(coordinator.contains("func cancel()"))
        XCTAssertTrue(coordinator.contains("establishConnection"))
    }

    func testRestoreSchedulingHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/RestoreCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("restoreCoordinator"))
        for oldField in [
            "restoreRetryTask",
            "restoreAttempt",
            "restoreFollowUpRequested",
            "restoreFollowUpImmediate"
        ] {
            XCTAssertFalse(appStore.contains(oldField), "AppStore 不得继续直接维护恢复调度字段：\(oldField)")
        }
        XCTAssertTrue(coordinator.contains("func schedule(immediate:"))
        XCTAssertTrue(coordinator.contains("func markRestored()"))
        XCTAssertTrue(coordinator.contains("func reset()"))
        XCTAssertTrue(coordinator.contains("func cancelWaiting()"))
        XCTAssertTrue(coordinator.contains("preserving the established backoff attempt"))
        XCTAssertTrue(coordinator.contains("followUpRequested"))
        XCTAssertTrue(coordinator.contains("reconcile"))
    }

    func testEventProjectionMergeHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let reducer = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventProjectionReducer.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("EventProjectionReducer.merge"))
        XCTAssertFalse(appStore.contains("let existingByID = Dictionary(uniqueKeysWithValues:"))
        XCTAssertFalse(appStore.contains("visibleEvents = visibleServerEvents.map"))
        XCTAssertTrue(reducer.contains("suppressedEventIDs"))
        XCTAssertTrue(reducer.contains("state.isTerminal"))
        XCTAssertTrue(reducer.contains("coordination?.revision"))
    }

    func testResponseOfferProjectionHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/ResponseOfferProjectionCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("responseOfferProjectionCoordinator"))
        XCTAssertFalse(appStore.contains("private var receiptMachine"))
        XCTAssertFalse(appStore.contains("responseRequest = request"))
        XCTAssertFalse(appStore.contains("deliveryStatus = authoritativeStatus"))
        XCTAssertTrue(coordinator.contains("func receive("))
        XCTAssertTrue(coordinator.contains("func advance(to status:"))
        XCTAssertTrue(coordinator.contains("func clear()"))
        XCTAssertTrue(coordinator.contains("DeliveryReceiptMachine"))
    }

    func testDeliveryReceiptQueueHasOneDurableOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let environment = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/AppEnvironment.swift"
            ),
            encoding: .utf8
        )
        let persistence = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/DeliveryReceiptQueuePersistenceCoordinator.swift"
            ),
            encoding: .utf8
        )
        let upload = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/DeliveryReceiptUploadCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(environment.contains("deliveryReceiptQueueStore"))
        XCTAssertTrue(appStore.contains("deliveryReceiptUploadCoordinator.recover()"))
        XCTAssertTrue(appStore.contains("loadDeliveryReceiptQueue()"))
        XCTAssertTrue(appStore.contains("deliveryReceiptUploadCoordinator.enqueue("))
        XCTAssertFalse(appStore.contains("sendReceipt("))
        XCTAssertFalse(appStore.contains("private var pendingDeliveryReceipts"))
        XCTAssertFalse(appStore.contains("pendingDeliveryReceipts.removeAll"))
        XCTAssertTrue(persistence.contains("func load()"))
        XCTAssertTrue(persistence.contains("func recover()"))
        XCTAssertTrue(persistence.contains("func append(_ receipt: PendingDeliveryReceipt)"))
        XCTAssertTrue(persistence.contains("func acknowledge(_ receipt: PendingDeliveryReceipt)"))
        XCTAssertTrue(persistence.contains("func reset()"))
        XCTAssertTrue(persistence.contains("isBlocked"))
        XCTAssertTrue(upload.contains("func enqueue("))
        XCTAssertTrue(upload.contains("func startDrain()"))
        XCTAssertTrue(upload.contains("func cancelTransport()"))
        XCTAssertTrue(upload.contains("sendReceipt("))
    }

    func testResponseDecisionCallbacksRecheckRequestAndConnectionGeneration() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("isCurrentResponseDecision"))
        XCTAssertTrue(appStore.contains("let decisionGeneration = connectionGeneration"))
        XCTAssertTrue(appStore.contains("responseRequest?.messageId == request.messageId"))
        XCTAssertTrue(appStore.contains("responseRequest?.deliveryId == request.deliveryId"))
        XCTAssertTrue(appStore.contains("connectionGeneration == expectedGeneration"))
    }

    func testStatusConfirmationCallbacksRecheckEventAndConnectionGeneration() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("isCurrentStatusConfirmationSubmission"))
        XCTAssertTrue(appStore.contains("let capturedConfirmationID = confirmation.confirmationId"))
        XCTAssertTrue(appStore.contains("let capturedGeneration = connectionGeneration"))
        XCTAssertTrue(appStore.contains("event.statusConfirmation?.confirmationId == confirmationID"))
        XCTAssertTrue(appStore.contains("guard self.isCurrentStatusConfirmationSubmission("))
        XCTAssertTrue(appStore.contains("self.lastStatusConfirmationResult = result"))
    }

    func testCompanionTicketCallbacksRespectConnectionGeneration() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("if let self, self.connectionGeneration == generation"))
        XCTAssertTrue(appStore.contains("self.connectionGeneration == generation"))
        XCTAssertTrue(appStore.contains("self.businessServicesActivated"))
        XCTAssertFalse(appStore.contains("self?.lastError = \"Watch 配对凭据申请失败"))
    }

    func testAuthRefreshCallbacksRespectConnectionGenerationAndUser() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("self.connectionGeneration == generation"))
        XCTAssertTrue(appStore.contains("self.authSession?.userId == authSession.userId"))
        XCTAssertTrue(appStore.contains("self.persistRefreshedAuthSession(updatedSession)"))
    }

    func testColdStartAuthRestoreHasCancelableGeneration() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("authenticationRestoreGeneration"))
        XCTAssertTrue(appStore.contains("isCurrentAuthenticationRestore"))
        XCTAssertTrue(appStore.contains("invalidateAuthenticationRestore()"))
        XCTAssertTrue(appStore.contains("!isAuthenticated"))
    }

    func testAssignmentProjectionHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/AssignmentProjectionCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("assignmentProjectionCoordinator"))
        XCTAssertFalse(appStore.contains("private var aedReceiptMachine"))
        XCTAssertFalse(appStore.contains("private var receiptByAssignmentID"))
        XCTAssertFalse(appStore.contains("self.assignment = assignment"))
        XCTAssertFalse(appStore.contains("acceptedResponseEventID = assignment.eventId"))
        XCTAssertTrue(coordinator.contains("func apply("))
        XCTAssertTrue(coordinator.contains("func applyAedReceipt"))
        XCTAssertTrue(coordinator.contains("func prepareAedReceipt"))
        XCTAssertTrue(coordinator.contains("func reset()"))
        XCTAssertTrue(appStore.contains("current.status == captured.status"))
        XCTAssertTrue(appStore.contains("guard self.connectionGeneration == capturedGeneration"))
        XCTAssertTrue(appStore.contains("self.reconcileEvent(eventID: capturedAssignment.eventId)"))
        XCTAssertFalse(appStore.contains("_ = assignmentProjectionCoordinator.markTimedOut"))
        XCTAssertTrue(appStore.contains("等待 REST 真值与重新招募/分配"))
    }

    func testPresenceUploadHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/PresenceUploadCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("presenceUploadCoordinator"))
        XCTAssertFalse(appStore.contains("private var presenceUploadTask"))
        XCTAssertFalse(appStore.contains("private var pendingPresenceUpload"))
        XCTAssertFalse(appStore.contains("private var lastPresenceSignature"))
        XCTAssertFalse(appStore.contains("private func drainPresenceUploads"))
        XCTAssertTrue(coordinator.contains("func enqueue("))
        XCTAssertTrue(coordinator.contains("func reset(resetLastSignature:"))
        XCTAssertTrue(coordinator.contains("updatePresence"))
        XCTAssertTrue(coordinator.contains("lastSignature = upload.signature"))
        XCTAssertTrue(coordinator.contains("isCurrent(sessionGeneration)"))
        XCTAssertTrue(appStore.contains("connectionState == .connected"))
        XCTAssertTrue(appStore.contains("liveSession != nil"))
        XCTAssertTrue(appStore.contains("restoredConnectionGeneration == self.connectionGeneration"))
    }

    func testNearbySummaryQueryHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/NearbyVolunteerSummaryCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("nearbyVolunteerSummaryCoordinator"))
        XCTAssertFalse(appStore.contains("private var nearbyVolunteerRequestGeneration"))
        XCTAssertFalse(appStore.contains("apiClient.fetchNearbyVolunteerSummary()"))
        XCTAssertTrue(coordinator.contains("func clear()"))
        XCTAssertTrue(coordinator.contains("func refresh(sessionGeneration:"))
        XCTAssertTrue(coordinator.contains("fetchNearbyVolunteerSummary"))
        XCTAssertTrue(coordinator.contains("summary.isCurrent(at:"))
        XCTAssertTrue(coordinator.contains("requestGeneration == generation"))
    }

    func testEventPositionSchedulerHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionSchedulerCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("eventPositionSchedulerCoordinator"))
        XCTAssertFalse(appStore.contains("private var eventPositionSchedulerTask"))
        XCTAssertFalse(appStore.contains("eventPositionSchedulerTask = Task"))
        XCTAssertTrue(appStore.contains("captureEventPositionSlot(at:"))
        XCTAssertTrue(coordinator.contains("struct Context"))
        XCTAssertTrue(coordinator.contains("func start(context:"))
        XCTAssertTrue(coordinator.contains("func stop()"))
        XCTAssertTrue(coordinator.contains("utcSecondCeiling"))
        XCTAssertTrue(coordinator.contains("utcSecondStart"))
        XCTAssertTrue(coordinator.contains("self.capture(nextSlot)"))
    }

    func testEventPositionRecoverySchedulerHasOneApplicationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionRecoverySchedulerCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("eventPositionRecoverySchedulerCoordinator"))
        XCTAssertFalse(appStore.contains("private var eventPositionRecoveryTask"))
        XCTAssertFalse(appStore.contains("eventPositionRecoveryTask = Task"))
        XCTAssertTrue(appStore.contains("completeRecoveredEventPositionSlots"))
        XCTAssertTrue(coordinator.contains("func start(context:"))
        XCTAssertTrue(coordinator.contains("func stop()"))
        XCTAssertTrue(coordinator.contains("try await self.sleep(.seconds(5))"))
        XCTAssertTrue(coordinator.contains("self.advance()"))
    }

    func testEventPositionBatchUploadHasOneTransportOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionBatchUploadCoordinator.swift"
            ),
            encoding: .utf8
        )
        let outcome = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionBatchOutcomeCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("eventPositionBatchUploadCoordinator"))
        XCTAssertTrue(appStore.contains("eventPositionBatchOutcomeCoordinator"))
        XCTAssertFalse(appStore.contains("private var eventPositionBatchUploadTask"))
        XCTAssertFalse(appStore.contains("eventPositionBatchUploadTask = Task"))
        XCTAssertFalse(appStore.contains("private var eventPositionRetryAttempt"))
        XCTAssertTrue(appStore.contains("commitEventPositionBatchAck"))
        XCTAssertTrue(appStore.contains("isolateEventPositionBatch"))
        XCTAssertFalse(appStore.contains("guard ack.validates(request: pending.batch)"))
        XCTAssertFalse(appStore.contains("nextState.pendingBatches[index] = try PersistedEventPositionBatch("))
        XCTAssertTrue(coordinator.contains("func start("))
        XCTAssertTrue(coordinator.contains("func scheduleRetry()"))
        XCTAssertTrue(coordinator.contains("func reset()"))
        XCTAssertTrue(coordinator.contains("ack.validates(request: batch.batch)"))
        XCTAssertTrue(coordinator.contains("isCurrent(batch, connectionGeneration)"))
        XCTAssertTrue(outcome.contains("func acknowledge("))
        XCTAssertTrue(outcome.contains("func isolate("))
        XCTAssertTrue(outcome.contains("matches("))
    }

    func testEventPositionQueuePersistenceHasOneIOOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionQueuePersistenceCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("eventPositionQueuePersistenceCoordinator"))
        XCTAssertFalse(appStore.contains("environment.eventPositionQueueStore.load()"))
        XCTAssertFalse(appStore.contains("environment.eventPositionQueueStore.save("))
        XCTAssertTrue(appStore.contains("eventPositionQueuePersistenceCoordinator.load()"))
        XCTAssertTrue(appStore.contains("eventPositionQueuePersistenceCoordinator.save(state)"))
        XCTAssertTrue(appStore.contains("eventPositionQueuePersistenceCoordinator.markBlocked()"))
        XCTAssertTrue(coordinator.contains("func load()"))
        XCTAssertTrue(coordinator.contains("func save(_ state: EventPositionQueueState)"))
        XCTAssertTrue(coordinator.contains("func markBlocked()"))
        XCTAssertTrue(coordinator.contains("func reset()"))
        XCTAssertTrue(coordinator.contains("isUnavailable"))
    }

    func testViewsExposeOnlyPhoneAndAppleLoginBeforeBusinessControls() throws {
        let source = try recursiveSwiftSource(in: repositoryRoot.appending(path: "ios/AEDResponse/Views"))
        for forbidden in [
            "SecureField(",
            "role-picker",
            "manual-sos-button",
            "wearable-mock-button",
            "duty-toggle",
            "demo-responder-order",
            "timeline-list",
            "Label(\"时间线\""
        ] {
            XCTAssertFalse(source.contains(forbidden), "用户界面不得恢复旧入口：\(forbidden)")
        }
        // The append-only event timeline stays internal and must never become a
        // user-facing entry point.  `TimelineView` itself is deliberately not
        // banned here: the responder offer countdown and the nearby-summary
        // expiry tick use it purely as a clock, which is asserted below.
        XCTAssertFalse(source.contains("store.timeline"))
        XCTAssertFalse(source.contains("eventTimeline"))
        XCTAssertFalse(source.contains("timelineEntries"))
        // Every TimelineView use in the views layer must be an explicit periodic
        // clock for an expiry/countdown; an unqualified schedule would mean the
        // old timeline surface is returning.
        XCTAssertEqual(
            source.components(separatedBy: "TimelineView(").count,
            source.components(separatedBy: "TimelineView(.periodic(").count,
            "视图层的 TimelineView 只能作为周期性时钟使用"
        )
        XCTAssertTrue(source.contains("AuthView"))
        XCTAssertTrue(source.contains("SignInWithAppleButton"))
        // PHONE sign-in was removed on 2026-09-13: Apple is the only entry point,
        // and the phone-only controls must not come back through a later edit.
        XCTAssertFalse(source.contains("phone-number-field"))
        XCTAssertFalse(source.contains("phone-verification-code-field"))
        XCTAssertFalse(source.contains("requestPhoneChallenge"))
        XCTAssertFalse(source.contains("verifyPhoneCode"))
        XCTAssertTrue(source.contains("patient-agreement-toggle"))
        XCTAssertTrue(source.contains("responder-agreement-toggle"))
        XCTAssertTrue(source.contains("accept-response-button"))
        XCTAssertTrue(source.contains("aed-acquired-button"))

        let responderView = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Views/ResponderDashboardView.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(responderView.contains("request.eventType.displayText"))
        XCTAssertTrue(responderView.contains("request.distanceRange.displayText"))
        XCTAssertTrue(responderView.contains("request.etaRange.displayText"))
        XCTAssertTrue(responderView.contains("request.currentRecruitmentRadiusMeters"))
        XCTAssertTrue(responderView.contains("剩余接受时间"))
        XCTAssertTrue(responderView.contains("remainingValiditySeconds"))
        XCTAssertFalse(responderView.contains("request.patientPosition"))
        XCTAssertFalse(responderView.contains("request.patientLocationCard"))

        let authView = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/AuthView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(authView.contains("request.requestedScopes = []"))
        XCTAssertTrue(authView.contains("request.nonce"))
        XCTAssertTrue(authView.contains("SecRandomCopyBytes"))
        XCTAssertFalse(authView.contains(".fullName"))
        XCTAssertFalse(authView.contains(".email"))
        XCTAssertFalse(authView.contains("@AppStorage(\"aedresponse.v2.base-url\")"))

        let rootView = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/RootView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(rootView.contains("isBusinessAccessReady"))
        XCTAssertTrue(rootView.contains("PermissionGateView"))
        let appRoot = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AEDResponseApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(appRoot.contains("onChange(of: scenePhase, initial: true)"))
    }

    /// App Store guideline 5.1.1(v): account deletion must be reachable inside the
    /// app, must be distinct from logout, and must state the retention consequence
    /// before the user commits.
    func testAccountDeletionIsReachableAndSeparateFromLogout() throws {        let settings = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/SettingsView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(settings.contains("settings-delete-account-button"))
        XCTAssertTrue(settings.contains("settings-logout-button"))
        XCTAssertTrue(
            settings.contains("store.deleteAccount()"),
            "删除账号必须走服务端裁定，不能在视图层伪造"
        )
        XCTAssertTrue(settings.contains("不可撤销"), "破坏性操作前必须说明后果")
        XCTAssertTrue(
            settings.contains("已形成的急救事件记录按留存规则保留"),
            "必须披露事件证据按留存政策保留，不能暗示全部数据立即消失"
        )
        // An irreversible deletion needs a second, explicit confirmation.
        XCTAssertTrue(settings.contains("isConfirmingAccountDeletion"))
        XCTAssertTrue(settings.contains("confirm-delete-account-button"))

        // The deletion entry point must stay reachable when business permission
        // is missing.  The audit found the gate rendering a screen that offered
        // only "go to iOS Settings" and logout, so a user who refused
        // notifications or location could not delete the account at all — the
        // exact dead end 5.1.1(v) forbids.
        let rootView = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/RootView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(
            rootView.contains("permissionGateApp"),
            "权限门禁必须仍是一个可导航的界面，而不是只指向系统设置的死胡同"
        )
        XCTAssertTrue(
            rootView.contains("SettingsView()"),
            "权限门禁下必须能打开设置，账号删除与法律信息都在其中"
        )
        // Both gate variants must exist: the full app and the restricted one.
        XCTAssertTrue(rootView.contains("if store.isBusinessAccessReady"))
        XCTAssertTrue(
            rootView.contains("PermissionGateView()"),
            "业务权限缺失时行动页仍要显示权限清单"
        )

        // An account exists from sign-in, before any consent.  Deletion must be
        // reachable there too: the onboarding screen used to offer only "签署"
        // and "退出登录", so a user who refused the agreements had no way to
        // delete the account they had just created (5.1.1(v)).
        let onboarding = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/OnboardingView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(
            onboarding.contains("PreAgreementAccountSheet()"),
            "未签协议时也必须能打开账号管理并删除账号"
        )
        XCTAssertTrue(
            onboarding.contains("preagreement-account-management-button"),
            "账号管理入口必须真正渲染在首次使用页面上"
        )
        let preAgreementSheet = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Views/AgreementDocumentView.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(
            preAgreementSheet.contains("store.deleteAccount()"),
            "协议前删除同样必须走服务端裁定，不能在视图层伪造"
        )
        XCTAssertTrue(
            preAgreementSheet.contains("按留存规则保留"),
            "协议前删除也必须披露事件证据按留存政策保留"
        )
        XCTAssertTrue(
            preAgreementSheet.contains("isConfirmingAccountDeletion"),
            "不可撤销的删除同样需要二次确认"
        )
    }

    /// App Store guideline 1.4.1: an app that touches emergency situations must
    /// state that it does not replace emergency services.  The statement has to be
    /// rendered, and no surface may claim a handover this app cannot observe.
    func testEmergencySurfacesDiscloseNoSubstituteForEmergencyServices() throws {
        let rootView = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/RootView.swift"),
            encoding: .utf8
        )
        // The banner must actually be instantiated on the emergency surface, not
        // merely declared as a struct.
        XCTAssertTrue(
            rootView.contains("SafetyBanner()"),
            "1.4.1 免责声明必须真正渲染，不能只是未被使用的 struct"
        )
        XCTAssertTrue(rootView.contains("不能替代专业急救"))
        XCTAssertTrue(rootView.contains("不会自动拨打急救电话"))

        let allViews = try recursiveSwiftSource(
            in: repositoryRoot.appending(path: "ios/AEDResponse/Views")
        )
        for forbidden in [
            "急救已接管",
            "救护车已到",
            "已派车",
            "已报警",
            "已联系急救"
        ] {
            XCTAssertFalse(
                allViews.contains(forbidden),
                "不得声称本 App 无法观测的急救接管：\(forbidden)"
            )
        }

        // The Watch must tell its wearer to call emergency services themselves
        // instead of implying the app will.
        let watch = try recursiveSwiftSource(
            in: repositoryRoot.appending(path: "ios/AEDResponseWatch")
        )
        XCTAssertTrue(watch.contains("watch-emergency-disclaimer"))
        XCTAssertTrue(watch.contains("不替"), "Watch 必须明确说明不会代为报警")
        XCTAssertTrue(watch.contains("自行拨打"), "Watch 必须引导用户自行拨打急救电话")
    }

    /// App Store 5.1.1(i)/5.1.2: the consent gate may only ask a user to accept
    /// documents the app can actually display, and the privacy policy has to
    /// describe this app's real data practices.  The bundled JSON is the evidence.
    func testBundledAgreementsAreReadableAndCoverRequiredDisclosures() throws {
        let data = try Data(
            contentsOf: repositoryRoot.appending(path: "contracts/agreements.json")
        )
        let agreements = try JSONDecoder().decode(AgreementDocuments.self, from: data)

        // Every agreement the consent gate demands must have a readable body and
        // the exact version string that gets recorded as accepted.
        XCTAssertEqual(agreements.schemaVersion, "2.0")
        // Only the version block is needed; the fixture's dates use the contract
        // decoder, so decoding the whole scenario here would fail for an
        // unrelated reason.
        struct ScenarioVersions: Decodable {
            let agreementVersions: AgreementVersions
        }
        let scenario = try JSONDecoder().decode(
            ScenarioVersions.self,
            from: try Data(
                contentsOf: repositoryRoot.appending(
                    path: "contracts/fixtures/demo-scenario.json"
                )
            )
        )
        let expectedVersions: [AgreementKind: String] = [
            .patient: scenario.agreementVersions.patient,
            .volunteerResponder: scenario.agreementVersions.volunteerResponder,
            .privacyPolicy: scenario.agreementVersions.privacyPolicy,
            .sensitivePersonalInformation: scenario.agreementVersions.sensitivePersonalInformation
        ]
        for kind in AgreementKind.allCases {
            let document = try XCTUnwrap(
                agreements.document(for: kind),
                "同意门禁要求 \(kind.rawValue)，但没有任何正文"
            )
            XCTAssertTrue(document.isReadable, "\(kind.rawValue) 正文不可读")
            XCTAssertEqual(
                document.version,
                expectedVersions[kind],
                "\(kind.rawValue) 的正文版本必须与记录的同意版本一致"
            )
            XCTAssertFalse(document.summary.isEmpty)
        }

        let privacyPolicy = try XCTUnwrap(agreements.document(for: .privacyPolicy))
        let policyText = privacyPolicy.sections.map { "\($0.heading)\n\($0.body)" }
            .joined(separator: "\n")
        // The policy must disclose the things this app actually does.
        for required in [
            "精确位置",           // precise location is collected
            "10 分钟",            // standby retention
            "30 天",              // tiered retention
            "3 年",               // sealed layer
            "删除账号",           // the in-app deletion right
            "15 个工作日",        // non-event deletion window
            "不会出售",           // no sale of personal information
            "不做跨 App 追踪"     // no tracking
        ] {
            XCTAssertTrue(policyText.contains(required), "隐私政策缺少必要披露：\(required)")
        }

        // The volunteer agreement must not present this app as emergency care.
        let responderAgreement = try XCTUnwrap(
            agreements.document(for: .volunteerResponder)
        )
        let responderText = responderAgreement.sections.map(\.body).joined(separator: "\n")
        XCTAssertTrue(responderText.contains("不是急救人员") || responderText.contains("自行拨打"))

        // Submission readiness must fail closed while the hosted policy and a real
        // contact address are still missing, so an unfinished legal surface cannot
        // ship silently.
        XCTAssertFalse(agreements.privacyPolicyURL.contains("https://"))
        XCTAssertFalse(
            agreements.isReadyForSubmission,
            "托管隐私政策与联系邮箱未填写前不得视为可提交"
        )
    }

    func testProductionAuthUsesKeychainAndTestHostFakeIsCompileScoped() throws {
        let environment = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/AppEnvironment.swift"
            ),
            encoding: .utf8
        )
        let sessionStore = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Services/AuthSessionStore.swift"
            ),
            encoding: .utf8
        )
        let deviceServices = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Services/DeviceServices.swift"
            ),
            encoding: .utf8
        )
        let project = try String(
            contentsOf: repositoryRoot.appending(path: "ios/project.yml"),
            encoding: .utf8
        )

        XCTAssertTrue(environment.contains("KeychainAuthSessionStore()"))
        XCTAssertTrue(environment.contains("#if AEDRESPONSE_TEST_HOST"))
        XCTAssertTrue(sessionStore.contains("SecItemCopyMatching"))
        XCTAssertTrue(sessionStore.contains("SecItemAdd"))
        XCTAssertTrue(sessionStore.contains("SecItemDelete"))
        XCTAssertTrue(sessionStore.contains("TestHostAuthSessionStore"))
        XCTAssertTrue(sessionStore.contains("#if AEDRESPONSE_TEST_HOST"))
        XCTAssertTrue(project.contains("com.apple.developer.applesignin"))
        XCTAssertTrue(project.contains("AEDResponse/AEDResponse.entitlements"))
        // The service base URL is compiled into the shipping Info.plist from the
        // project spec, so the client itself must not carry an editable override
        // (see the @AppStorage assertion in the views test).
        XCTAssertTrue(project.contains("AEDResponseServiceBaseURL:"))
        XCTAssertFalse(environment.contains("@AppStorage"))
        XCTAssertTrue(deviceServices.contains("hasRequiredBusinessAuthorization"))
        XCTAssertTrue(deviceServices.contains("requestAlwaysAccessAndLocation"))
        XCTAssertTrue(sessionStore.contains("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"))
    }

    func testLocalScenarioControlsAreTestHostDebugOnly() throws {
        let project = try String(
            contentsOf: repositoryRoot.appending(path: "ios/project.yml"),
            encoding: .utf8
        )
        let production = try targetBlock(named: "AEDResponse", in: project)
        let testHost = try targetBlock(named: "AEDResponseTestHost", in: project)

        XCTAssertFalse(production.contains("AEDRESPONSE_TEST_HOST"))
        XCTAssertFalse(production.contains("path: AEDResponseTestHost"))
        XCTAssertFalse(production.contains("fixtures/demo-scenario.json"))

        XCTAssertTrue(testHost.contains("path: AEDResponseTestHost"))
        XCTAssertTrue(testHost.contains("fixtures/demo-scenario.json"))
        XCTAssertTrue(testHost.contains("Debug:"))
        XCTAssertTrue(testHost.contains("AEDRESPONSE_TEST_HOST"))
        XCTAssertFalse(testHost.contains("Release:"))

        let rootView = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Views/RootView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(rootView.contains("#if AEDRESPONSE_TEST_HOST"))
        XCTAssertFalse(rootView.contains("TimelineView()"))
    }

    func testViewsDoNotCallNetworkOrDeviceAdaptersDirectly() throws {
        let source = try recursiveSwiftSource(in: repositoryRoot.appending(path: "ios/AEDResponse/Views"))
        for forbidden in [
            "APIClient(",
            "SocketIOEventStream(",
            "URLSession",
            "CLLocationManager",
            "AVSpeechSynthesizer",
            "UIApplication.shared"
        ] {
            XCTAssertFalse(source.contains(forbidden), "View 不得直接依赖 \(forbidden)")
        }
    }

    func testWatchTargetIsModernSingleTargetAndDeclaresRequiredCapability() throws {
        let project = try String(
            contentsOf: repositoryRoot.appending(path: "ios/project.yml"),
            encoding: .utf8
        )
        let entitlements = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponseWatch/AEDResponseWatch.entitlements"
            ),
            encoding: .utf8
        )
        let info = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponseWatch/Info.plist"),
            encoding: .utf8
        )

        XCTAssertTrue(project.contains("AEDResponseWatch:"))
        XCTAssertTrue(project.contains("platform: watchOS"))
        XCTAssertFalse(project.contains("watchkit-extension"))
        XCTAssertTrue(entitlements.contains("com.apple.developer.health.fall-detection"))
        XCTAssertTrue(info.contains("NSFallDetectionUsageDescription"))
        XCTAssertTrue(info.contains("WKCompanionAppBundleIdentifier"))
    }

    /// App Store submission blockers that are configuration, not code: both
    /// bundles need a privacy manifest declaring the required-reason API they
    /// actually use, and the shipping plists must answer export compliance and
    /// describe the real (remote HTTPS) service instead of a local test one.
    func testShippingBundlesDeclarePrivacyManifestAndExportCompliance() throws {
        let project = try String(
            contentsOf: repositoryRoot.appending(path: "ios/project.yml"),
            encoding: .utf8
        )
        let appManifest = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/PrivacyInfo.xcprivacy"
            ),
            encoding: .utf8
        )
        let watchManifest = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponseWatch/PrivacyInfo.xcprivacy"
            ),
            encoding: .utf8
        )

        for manifest in [appManifest, watchManifest] {
            XCTAssertTrue(manifest.contains("NSPrivacyAccessedAPICategoryUserDefaults"))
            XCTAssertTrue(manifest.contains("CA92.1"))
            XCTAssertTrue(manifest.contains("NSPrivacyTracking"))
            XCTAssertTrue(manifest.contains("NSPrivacyAccessedAPITypes"))
            // UserDefaults is the only required-reason API in shipping code; a new
            // category must not appear without a declared reason.
            XCTAssertFalse(manifest.contains("NSPrivacyAccessedAPICategoryFileTimestamp"))
        }

        let appInfo = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/Info.plist"),
            encoding: .utf8
        )
        let watchInfo = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponseWatch/Info.plist"),
            encoding: .utf8
        )
        for info in [appInfo, watchInfo] {
            XCTAssertTrue(
                info.contains("ITSAppUsesNonExemptEncryption"),
                "缺少出口合规声明会让每次上传都卡在 App Store Connect 提示"
            )
            XCTAssertFalse(
                info.contains("测试服务"),
                "发布 bundle 的用户可见权限文案不得再描述本地测试服务"
            )
        }
    }

    func testWatchCoordinatorTargetMembershipUsesCanonicalProjectSpec() throws {
        let project = try String(
            contentsOf: repositoryRoot.appending(path: "ios/project.yml"),
            encoding: .utf8
        )
        let iphone = try targetBlock(named: "AEDResponse", in: project)
        let testHost = try targetBlock(named: "AEDResponseTestHost", in: project)
        let watch = try targetBlock(named: "AEDResponseWatch", in: project)
        let watchLogic = try targetBlock(named: "AEDResponseWatchLogic", in: project)

        for productionBlock in [iphone, testHost] {
            XCTAssertFalse(productionBlock.contains("FallEmergencyCoordinator.swift"))
            XCTAssertFalse(productionBlock.contains("target: AEDResponseWatchLogic"))
        }

        XCTAssertTrue(watch.contains("- path: AEDResponseWatch"))
        XCTAssertFalse(watch.contains("- Domain/FallEmergencyCoordinator.swift"))
        XCTAssertTrue(watch.contains("- path: AEDResponse/Domain/Models.swift"))
        XCTAssertFalse(watch.contains("target: AEDResponseWatchLogic"))

        XCTAssertTrue(watchLogic.contains("- path: AEDResponse/Domain/Models.swift"))
        XCTAssertTrue(watchLogic.contains("- path: AEDResponseWatch/Domain"))
        XCTAssertTrue(watchLogic.contains("- path: AEDResponseWatch/Networking/WatchAPIReporter.swift"))
        XCTAssertTrue(watchLogic.contains("- path: AEDResponseWatch/Services/WatchPersistence.swift"))
    }

    func testWatchProductionSourceNeverDialsOrAssignsResponders() throws {
        let source = try recursiveSwiftSource(in: repositoryRoot.appending(path: "ios/AEDResponseWatch"))
        for forbidden in [
            "CXCallController",
            "CXStartCallAction",
            "tel:",
            "UIApplication.shared",
            "AssignmentPlanner",
            "GO_TO_PATIENT",
            "FETCH_AED"
        ] {
            XCTAssertFalse(source.contains(forbidden), "Watch 不得执行 iPhone/后端职责：\(forbidden)")
        }
        XCTAssertTrue(source.contains("CMFallDetectionManager"))
        XCTAssertTrue(source.contains("CXCallObserver"))
        XCTAssertTrue(source.contains("import WatchConnectivity"))
        XCTAssertTrue(source.contains("WatchObservationReporting"))
        XCTAssertTrue(source.contains("WatchFallbackReporting"))
        XCTAssertTrue(source.contains("WatchCompanionLinkRedeeming"))
        XCTAssertTrue(source.contains("DeviceCheckAppAttestAdapter"))
        XCTAssertTrue(source.contains("WatchKeychainStore"))
        XCTAssertTrue(source.contains("watch/session/redeem"))
        XCTAssertTrue(source.contains("watch/session/refresh"))
        XCTAssertFalse(source.contains("/session/bootstrap"))
        for forbiddenTransfer in [
            ".sendMessage(",
            ".sendMessageData(",
            ".transferUserInfo(",
            ".updateApplicationContext(",
            ".transferFile("
        ] {
            XCTAssertFalse(source.contains(forbiddenTransfer))
        }
        XCTAssertTrue(source.contains("nonisolated func session("))
        XCTAssertTrue(source.contains("nonisolated func sessionReachabilityDidChange"))
        XCTAssertTrue(source.contains("Task { @MainActor [weak self] in"))
    }

    func testWatchFallbackUsesDirectWANOnlyAndProtectedQueues() throws {
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponseWatch/Domain/WatchFallbackCoordinator.swift"
            ),
            encoding: .utf8
        )
        let persistence = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponseWatch/Services/WatchPersistence.swift"
            ),
            encoding: .utf8
        )
        let runtime = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponseWatch/App/WatchRuntimeModel.swift"
            ),
            encoding: .utf8
        )

        XCTAssertFalse(coordinator.contains("fallbackPositionPermitted"))
        XCTAssertFalse(coordinator.contains("WatchFallbackAuthority"))
        XCTAssertFalse(coordinator.contains("ReachabilityReport"))
        XCTAssertTrue(coordinator.contains("uploadIntervalSeconds: TimeInterval = 5"))
        XCTAssertTrue(coordinator.contains("movementEarlyDistanceMeters: Double = 10"))
        XCTAssertTrue(coordinator.contains("connectivityDidChange"))
        XCTAssertTrue(coordinator.contains("periodicReport"))
        XCTAssertTrue(runtime.contains("WatchConnectivityMonitor()"))
        XCTAssertTrue(runtime.contains("significantPositionDidChange"))
        XCTAssertTrue(runtime.contains("for triggerResult in await self.coordinator.retryPending("))
        XCTAssertTrue(runtime.contains("allowCreation: self.protectedMonitoringStarted"))
        XCTAssertTrue(runtime.contains("await self.applyAndActivate(triggerResult, sessionGeneration: triggerGeneration)"))
        XCTAssertFalse(runtime.contains("saveConfiguration"))
        XCTAssertTrue(runtime.contains("networkMonitor"))
        XCTAssertTrue(runtime.contains("sessionVerified"))
        XCTAssertTrue(runtime.contains("outbox: triggerOutbox"))
        XCTAssertTrue(runtime.contains("stateStore: fallbackStateStore"))
        XCTAssertTrue(runtime.contains("UNAVAILABLE_NO_CONNECTIVITY"))
        XCTAssertTrue(runtime.contains("fallbackPositionProvider.onSignificantPositionChange"))
        XCTAssertFalse(runtime.contains("lastReportedEventID"))
        XCTAssertTrue(persistence.contains("KeychainObservationOutbox"))
        XCTAssertTrue(persistence.contains("ProtectedFileWatchFallbackOutbox"))
        XCTAssertFalse(persistence.contains("maximumEntriesPerKind"))
        XCTAssertTrue(persistence.contains("completeFileProtectionUntilFirstUserAuthentication"))
    }

    func testEventPositionOpenFactsHaveOneCoordinatorOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionFactCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("EventPositionFactCoordinator"))
        XCTAssertFalse(appStore.contains("private var eventPositionOpenSlots: [Date] = []"))
        XCTAssertFalse(appStore.contains("private var eventPositionCandidatesBySlot: [Date: DeviceCoordinate] = [:]"))
        XCTAssertTrue(coordinator.contains("func makeOpenDraft()"))
        XCTAssertTrue(coordinator.contains("func recordCandidate"))
        XCTAssertTrue(coordinator.contains("func markClocked"))
        XCTAssertTrue(coordinator.contains("func removeSealedSlots"))
    }

    /// G11: a normal user cannot export, download or share event data.
    ///
    /// The server grants a read-only, time-boxed view of one's own data and
    /// nothing else, so the app must offer no way to turn that view into a file,
    /// a share sheet or a document another app can open.  A single convenience
    /// share button would quietly undo the boundary the backend enforces, which is
    /// why this is asserted against the shipping source rather than left to review.
    func testAppHasNoExportShareOrDownloadSurface() throws {
        let source = try recursiveSwiftSource(in: repositoryRoot.appending(path: "ios/AEDResponse"))
        for forbidden in [
            "UIActivityViewController",   // the share sheet
            "UIActivityItemSource",       // a shareable item
            "ShareLink",                  // SwiftUI sharing
            "fileExporter",               // writing a document out of the sandbox
            "UIDocumentPickerViewController", // handing a file to another app
            "forExporting",               // an export-mode document picker
            "writeToFile(",               // raw export helper
            "createFile("                 // raw file creation outside the stores
        ] {
            XCTAssertFalse(source.contains(forbidden),
                           "发现导出/分享/下载能力：\(forbidden)")
        }
    }

    func testEventPositionParticipationWindowHasOneReconciliationOwner() throws {
        let appStore = try String(
            contentsOf: repositoryRoot.appending(path: "ios/AEDResponse/App/AppStore.swift"),
            encoding: .utf8
        )
        let coordinator = try String(
            contentsOf: repositoryRoot.appending(
                path: "ios/AEDResponse/Application/EventPositionWindowReconciliationCoordinator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(appStore.contains("eventPositionWindowReconciliationCoordinator"))
        XCTAssertFalse(appStore.contains("private func eventPositionExclusionReason("))
        XCTAssertFalse(appStore.contains("private func reconcilePendingEventPositionBatches("))
        XCTAssertFalse(appStore.contains("private func reconcileOpenEventPositionDraft("))
        XCTAssertTrue(coordinator.contains("func reconcile("))
        XCTAssertTrue(coordinator.contains("func reconcilePersistedBatches("))
        XCTAssertTrue(coordinator.contains("quarantinedEvidence"))
        XCTAssertTrue(coordinator.contains("authoritativeEndedAtByContext"))
    }

    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func combinedSwiftSource(in directory: URL) throws -> String {
        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )
        return try files
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { try String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")
    }

    private func recursiveSwiftSource(in directory: URL) throws -> String {
        guard let enumerator = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: nil
        ) else {
            return ""
        }
        let files = enumerator.compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }
        return try files
            .map { try String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")
    }

    private func targetBlock(named name: String, in project: String) throws -> String {
        let lines = project.split(separator: "\n", omittingEmptySubsequences: false)
        let start = try XCTUnwrap(lines.firstIndex(of: "  \(name):"))
        let remaining = lines.index(after: start)..<lines.endIndex
        let end = lines[remaining].firstIndex {
            $0.hasPrefix("  ") && !$0.hasPrefix("    ") && $0.hasSuffix(":")
        } ?? lines.endIndex
        return lines[start..<end].joined(separator: "\n")
    }
}
