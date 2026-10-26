import XCTest
@testable import AEDResponse

@MainActor
final class ClientRouteRefreshCoordinatorTests: XCTestCase {
    private let context = ClientRouteRefreshCoordinator.Context(
        eventID: "event", assignmentID: "assignment", connectionGeneration: 1
    )

    func testRepeatedContextKeepsTheExistingCadence() async {
        let sleeper = ManualRouteRefreshSleeper()
        var refreshed: [ClientRouteRefreshCoordinator.Context] = []
        let coordinator = ClientRouteRefreshCoordinator(sleep: sleeper.sleep) { refreshed.append($0) }
        defer { coordinator.stop(); sleeper.resumeAll() }

        coordinator.synchronize(context: context)
        await waitUntil { sleeper.pendingIDs == [0] }
        XCTAssertEqual(refreshed, [context])
        for _ in 0..<5 { coordinator.synchronize(context: context) }
        await drainTasks()
        XCTAssertEqual(refreshed, [context], "Repeated projections must not restart the refresh timer")
        XCTAssertEqual(sleeper.durations, [.seconds(30)])

        sleeper.resume(0)
        await waitUntil { sleeper.pendingIDs == [1] }
        XCTAssertEqual(refreshed, [context, context])
        XCTAssertEqual(sleeper.durations, [.seconds(30), .seconds(30)])
    }

    func testStopAndRestartRejectsTheOldWaitEvenWhenSleepIgnoresCancellation() async {
        let sleeper = ManualRouteRefreshSleeper()
        var refreshed: [ClientRouteRefreshCoordinator.Context] = []
        let coordinator = ClientRouteRefreshCoordinator(sleep: sleeper.sleep) { refreshed.append($0) }
        defer { coordinator.stop(); sleeper.resumeAll() }

        coordinator.synchronize(context: context)
        await waitUntil { sleeper.pendingIDs == [0] }
        coordinator.synchronize(context: nil)
        XCTAssertFalse(coordinator.isScheduled)
        XCTAssertNil(coordinator.context)
        coordinator.synchronize(context: context)
        await waitUntil { sleeper.pendingIDs == [0, 1] }

        sleeper.resume(0)
        await drainTasks()
        XCTAssertEqual(refreshed, [context, context])
        XCTAssertEqual(coordinator.context, context)
        XCTAssertTrue(coordinator.isScheduled, "An old completion must not clear the restarted timer")
        sleeper.resume(1)
        await waitUntil { sleeper.pendingIDs == [2] }
        XCTAssertEqual(refreshed, [context, context, context])
    }

    func testEventAssignmentAndConnectionChangesReplaceTheSchedule() async {
        let sleeper = ManualRouteRefreshSleeper()
        var refreshed: [ClientRouteRefreshCoordinator.Context] = []
        let coordinator = ClientRouteRefreshCoordinator(sleep: sleeper.sleep) { refreshed.append($0) }
        defer { coordinator.stop(); sleeper.resumeAll() }
        let contexts = [context,
            .init(eventID: "other-event", assignmentID: "assignment", connectionGeneration: 1),
            .init(eventID: "other-event", assignmentID: "other-assignment", connectionGeneration: 1),
            .init(eventID: "other-event", assignmentID: "other-assignment", connectionGeneration: 2)]

        for (index, context) in contexts.enumerated() {
            coordinator.synchronize(context: context)
            await waitUntil { sleeper.pendingIDs.contains(index) }
            if index > 0 { sleeper.resume(index - 1) }
            await drainTasks()
            XCTAssertEqual(refreshed, Array(contexts.prefix(index + 1)))
            XCTAssertEqual(coordinator.context, context)
            XCTAssertTrue(coordinator.isScheduled)
        }
    }

    func testRefreshCanStopItsOwnScheduleWithoutStartingAnotherWait() async {
        let sleeper = ManualRouteRefreshSleeper()
        var refreshCount = 0
        weak var scheduled: ClientRouteRefreshCoordinator?
        let coordinator = ClientRouteRefreshCoordinator(sleep: sleeper.sleep) { _ in
            refreshCount += 1
            scheduled?.stop()
        }
        scheduled = coordinator
        coordinator.synchronize(context: context)
        await waitUntil { refreshCount == 1 }
        XCTAssertFalse(coordinator.isScheduled)
        XCTAssertTrue(sleeper.pendingIDs.isEmpty)
    }

    func testWaitingTaskDoesNotRetainItsOwner() async {
        let sleeper = ManualRouteRefreshSleeper()
        var refreshCount = 0
        var coordinator: ClientRouteRefreshCoordinator? = ClientRouteRefreshCoordinator(sleep: sleeper.sleep) { _ in
            refreshCount += 1
        }
        weak var owner = coordinator
        coordinator?.synchronize(context: context)
        await waitUntil { sleeper.pendingIDs == [0] }
        coordinator = nil
        XCTAssertNil(owner, "A sleeping refresh task must not keep AppStore's coordinator alive")
        sleeper.resumeAll()
        await drainTasks()
        XCTAssertEqual(refreshCount, 1)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<1_000 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("Scheduled task did not reach its manual wait", file: file, line: line)
    }

    private func drainTasks() async {
        for _ in 0..<20 { await Task.yield() }
    }
}

/// Intentionally ignores cancellation so tests exercise the scheduler's lease.
@MainActor
private final class ManualRouteRefreshSleeper {
    private var nextID = 0
    private var continuations: [Int: CheckedContinuation<Void, Error>] = [:]
    private(set) var durations: [Duration] = []
    var pendingIDs: [Int] { continuations.keys.sorted() }

    func sleep(_ duration: Duration) async throws {
        durations.append(duration)
        let id = nextID
        nextID += 1
        try await withCheckedThrowingContinuation { continuations[id] = $0 }
    }

    func resume(_ id: Int) {
        continuations.removeValue(forKey: id)?.resume()
    }

    func resumeAll() {
        for id in pendingIDs { resume(id) }
    }
}
