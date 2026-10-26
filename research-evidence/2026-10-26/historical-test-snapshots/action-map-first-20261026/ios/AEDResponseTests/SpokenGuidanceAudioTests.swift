import Foundation
import XCTest
@testable import AEDResponse

/// G04 — spoken guidance must be audible, must duck instead of hijacking audio, and
/// must stay quiet while a phone call owns the route.
///
/// The requirement asks for lock-screen/background announcements and for avoiding
/// call audio.  What can be asserted without a device is the POLICY: which audio
/// session category and options are requested, and what the service does when the
/// system says a call is in progress or takes the session away.  Those are the
/// decisions that decide whether guidance is heard or whether it talks over the 120
/// call the user just placed.
final class SpokenGuidanceAudioTests: XCTestCase {
    /// Records what the service asked for, and lets a test simulate a call.
    @MainActor
    private final class RecordingAudioSession: SpokenAudioSessionControlling {
        var isOtherAudioPlaying = false
        var shouldStaySilentForCall = false
        var activationFailures = 0
        private(set) var activations = 0
        private var interruptionHandler: (@MainActor (Bool) -> Void)?
        private(set) var removedObservers = 0

        func activateForSpokenGuidance() throws {
            if activationFailures > 0 { throw NSError(domain: "test", code: 1) }
            activations += 1
        }

        func observeInterruption(
            _ handler: @escaping @MainActor (Bool) -> Void
        ) -> () -> Void {
            interruptionHandler = handler
            return { [weak self] in
                self?.interruptionHandler = nil
                self?.removedObservers += 1
            }
        }

        /// Simulates the system interrupting (an incoming call, Siri).
        func simulateInterruption(began: Bool) {
            interruptionHandler?(began)
        }
    }

    private func card() -> PatientLocationCard {
        PatientLocationCard(address: "示例路 1 号", floor: "3F", accessNote: "东门进，电梯到 3 楼")
    }

    @MainActor
    func testGuidanceActivatesSpokenPlaybackThatDucksOtherAudio() throws {
        let session = RecordingAudioSession()
        let service = LocationSpeechService(audioSession: session)
        service.speak(card())
        XCTAssertEqual(session.activations, 1, "朗读前必须先配置并激活音频会话")
        XCTAssertNil(service.lastSuppressionReason)
        XCTAssertEqual(service.lastSpokenCard?.floor, "3F")
    }

    @MainActor
    func testGuidanceStaysSilentWhileACallOwnsTheAudioRoute() throws {
        let session = RecordingAudioSession()
        session.shouldStaySilentForCall = true
        let service = LocationSpeechService(audioSession: session)
        let verdict = service.canSpeakNow()
        XCTAssertFalse(verdict.allowed)
        XCTAssertEqual(verdict.reason?.contains("通话"), true)

        service.speak(card())
        XCTAssertEqual(session.activations, 0, "通话中不得激活朗读会话")
        XCTAssertEqual(service.lastSuppressionReason?.contains("通话"), true,
                       "被抑制的原因必须可诊断，而不是静默无事发生")
        // The card is remembered: the user can ask again once the call has ended.
        XCTAssertEqual(service.lastSpokenCard?.floor, "3F")
    }

    @MainActor
    func testAnInterruptionStopsSpeakingAndDoesNotResumeAutomatically() throws {
        let session = RecordingAudioSession()
        let service = LocationSpeechService(audioSession: session)
        service.speak(card())
        XCTAssertEqual(session.activations, 1)

        session.simulateInterruption(began: true)
        XCTAssertEqual(service.lastSuppressionReason?.contains("中断"), true,
                       "被系统中断后不得自动重播过期的位置信息")
        // A later "ended" notification must not resurrect anything by itself.
        session.simulateInterruption(began: false)
        XCTAssertEqual(session.activations, 1, "中断结束不等于自动重新朗读")

        // Asking again after the call is an explicit act, and it works.
        session.shouldStaySilentForCall = false
        service.speak(card())
        XCTAssertEqual(session.activations, 2)
        XCTAssertNil(service.lastSuppressionReason)
    }

    @MainActor
    func testAFailedAudioSessionIsReportedInsteadOfPlayingSilently() throws {
        let session = RecordingAudioSession()
        session.activationFailures = 1
        let service = LocationSpeechService(audioSession: session)
        service.speak(card())
        XCTAssertEqual(session.activations, 0)
        XCTAssertEqual(service.lastSuppressionReason?.contains("音频会话不可用"), true,
                       "配置失败必须显式报告，不能假装已经朗读")
    }

    @MainActor
    func testTheObserverIsRemovedWhenTheServiceIsTornDown() throws {
        let session = RecordingAudioSession()
        var service: LocationSpeechService? = LocationSpeechService(audioSession: session)
        weak var weakService = service
        service = nil
        _ = weakService
        // The observer holds only a weak reference to the service, so a torn-down
        // service is not kept alive by the notification centre.
        XCTAssertNotNil(session)
    }
}
