import XCTest
#if canImport(AEDResponse)
@testable import AEDResponse
#else
@testable import AEDResponseWatchLogic
#endif

final class LaunchPresentationPolicyTests: XCTestCase {
    private var ordinary: LaunchPresentationContext {
        LaunchPresentationContext(authenticationResolved: true, eventStateResolved: true)
    }

    func testOrdinaryLaunchPresentsOnlyOnce() {
        var policy = LaunchPresentationPolicy()
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertTrue(policy.isPresenting)
        policy.skip()
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertEqual(policy.phase, .finished)
    }

    func testUnknownStartupStateFailsClosedWithoutWaiting() {
        var policy = LaunchPresentationPolicy()
        policy.begin(context: LaunchPresentationContext(), reduceMotion: false)
        XCTAssertEqual(policy.phase, .finished)
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertFalse(policy.isPresenting, "Later network recovery must not insert a late splash")
    }

    func testAuthenticationAndEventRecoveryEachSkipIndependently() {
        for field in [\LaunchPresentationContext.authenticationResolved, \.eventStateResolved] {
            var context = ordinary
            context[keyPath: field] = false
            var policy = LaunchPresentationPolicy()
            policy.begin(context: context, reduceMotion: false)
            XCTAssertEqual(policy.phase, .finished)
        }
    }

    func testEachUrgentSourceSkipsEvenBeforeAnEventExists() {
        let fields: [WritableKeyPath<LaunchPresentationContext, Bool>] = [
            \.hasActiveRescue, \.hasResponseRequest, \.hasNotificationIntent,
            \.hasPendingCompanionWork, \.hasBlockingError
        ]
        for field in fields {
            var context = ordinary
            context[keyPath: field] = true
            XCTAssertTrue(context.requiresImmediateContent)
            var policy = LaunchPresentationPolicy()
            policy.begin(context: context, reduceMotion: false)
            XCTAssertFalse(policy.isPresenting)
        }
    }

    func testUrgentCallbackBeforeRootIsLatched() {
        var policy = LaunchPresentationPolicy()
        policy.skip()
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertEqual(policy.phase, .finished)
    }

    func testUrgentCallbackDuringPlaybackImmediatelyStopsIt() {
        var policy = LaunchPresentationPolicy()
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertTrue(policy.isPresenting)
        policy.skip()
        XCTAssertFalse(policy.isPresenting)
        policy.skip() // Late animation completion is harmless.
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertEqual(policy.phase, .finished)
    }

    func testBackgroundLaunchOrReturnNeverReplays() {
        for wasPlaying in [false, true] {
            var policy = LaunchPresentationPolicy()
            if wasPlaying { policy.begin(context: ordinary, reduceMotion: false) }
            policy.skip() // Background/inactive scene callback.
            policy.begin(context: ordinary, reduceMotion: false)
            XCTAssertFalse(policy.isPresenting)
        }
    }

    func testReduceMotionSkipsAndDoesNotReplayAfterPreferenceChanges() {
        var policy = LaunchPresentationPolicy()
        policy.begin(context: ordinary, reduceMotion: true)
        XCTAssertEqual(policy.phase, .finished)
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertFalse(policy.isPresenting)
    }

    func testRepeatedActiveCallbacksDoNotRestartPlayingAnimation() {
        var policy = LaunchPresentationPolicy()
        policy.begin(context: ordinary, reduceMotion: false)
        policy.begin(context: ordinary, reduceMotion: false)
        XCTAssertEqual(policy.phase, .presenting)
    }
}
