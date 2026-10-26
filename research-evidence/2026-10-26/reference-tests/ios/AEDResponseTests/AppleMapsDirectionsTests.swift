import MapKit
import XCTest
@testable import AEDResponse

/// G07 — navigation is Apple Maps, and the app's only job is the destination.
///
/// The decision of 2026-09-14 replaced a self-hosted routing dependency with the map
/// the phone already has.  That removes a vendor key and a quota, and it makes the one
/// thing this app must not get wrong very small: the link has to point at the
/// destination the SERVER assigned, for walking, and it must not be produced at all
/// when there is no coordinate to point at.
final class AppleMapsDirectionsTests: XCTestCase {
    func testAWalkingLinkCarriesTheServerAssignedDestination() throws {
        let url = try XCTUnwrap(AppleMapsDirections.walkingDirectionsURL(
            latitude: 22.1987654, longitude: 113.5439123, label: "AED"
        ))
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "maps.apple.com")
        let query = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(values["daddr"], "22.198765,113.543912")
        XCTAssertEqual(values["dirflg"], "w", "响应者是步行前往，必须使用步行导航")
        XCTAssertEqual(values["q"], "AED")
    }

    func testNoCoordinateMeansNoLinkRatherThanALinkToNowhere() {
        XCTAssertNil(AppleMapsDirections.walkingDirectionsURL(latitude: 200, longitude: 113))
        XCTAssertNil(AppleMapsDirections.walkingDirectionsURL(latitude: .nan, longitude: 113))
        XCTAssertNil(AppleMapsDirections.walkingDirectionsURL(latitude: 22.1987, longitude: .infinity))
    }

    func testTheLabelIsOptionalAndDoesNotBreakTheLink() throws {
        let url = try XCTUnwrap(AppleMapsDirections.walkingDirectionsURL(
            latitude: 22.1987, longitude: 113.5439
        ))
        let query = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertFalse(query.contains { $0.name == "q" })
        XCTAssertEqual(query.first { $0.name == "daddr" }?.value, "22.198700,113.543900")
    }
}

final class AmapDirectionsTests: XCTestCase {
    func testNavigationPrefersInstalledAmapAndOtherwiseUsesApple() throws {
        let amap = try XCTUnwrap(URL(string: "iosamap://path?t=2"))
        let apple = try XCTUnwrap(URL(string: "https://maps.apple.com/?dirflg=w"))
        XCTAssertEqual(MapsNavigationPreference.preferredURL(amapInstalled: true, amap: amap, apple: apple), amap)
        XCTAssertEqual(MapsNavigationPreference.preferredURL(amapInstalled: false, amap: amap, apple: apple), apple)
        XCTAssertEqual(MapsNavigationPreference.preferredURL(amapInstalled: true, amap: nil, apple: apple), apple)
    }

    private let navigation = AmapNavigation(coordinateSystem: "GCJ02",
        aed: .init(latitude: 39.905, longitude: 116.405),
        patient: .init(latitude: 39.91, longitude: 116.41))

    private func query(_ url: URL?) throws -> [String: String] {
        let url = try XCTUnwrap(url)
        XCTAssertEqual(url.scheme, "iosamap")
        XCTAssertEqual(url.host, "path")
        return Dictionary(uniqueKeysWithValues: try XCTUnwrap(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        ).map { ($0.name, $0.value ?? "") })
    }

    func testFetchUsesCurrentLocationThenGCJ02AedThenPatient() throws {
        let values = try query(AmapDirections.walkingDirectionsURL(latitude: 39.9, longitude: 116.3,
            label: "AED", navigation: navigation, viaAed: true))
        XCTAssertEqual(values["t"], "2")
        XCTAssertEqual(values["dev"], "0")
        XCTAssertEqual(values["vian"], "1")
        XCTAssertEqual(values["vialats"], "39.905000")
        XCTAssertEqual(values["vialons"], "116.405000")
        XCTAssertEqual(values["dlat"], "39.910000")
        XCTAssertEqual(values["dlon"], "116.410000")
        XCTAssertNil(values["slat"])
        XCTAssertNil(values["sname"])
    }

    func testAfterPickupNavigatesToPatientWithoutReturningToCabinet() throws {
        let values = try query(AmapDirections.walkingDirectionsURL(latitude: 39.91, longitude: 116.31,
            label: "患者", navigation: navigation, viaAed: false))
        XCTAssertNil(values["vian"])
        XCTAssertEqual(values["dlon"], "116.410000")
    }

    func testDirectPatientAndLegacyRoutesUseWGS84Conversion() throws {
        let values = try query(AmapDirections.walkingDirectionsURL(latitude: 39.91, longitude: 116.31,
            label: "患者"))
        XCTAssertEqual(values["dev"], "1")
        XCTAssertEqual(values["dlon"], "116.310000")
        XCTAssertNil(values["vian"])
        XCTAssertNil(AmapDirections.walkingDirectionsURL(latitude: .nan, longitude: 116, label: "AED"))
    }

    func testUnknownCoordinateSystemCannotProduceAMisplacedWaypoint() {
        let invalid = AmapNavigation(coordinateSystem: "WGS84", aed: navigation.aed, patient: navigation.patient)
        XCTAssertNil(AmapDirections.walkingDirectionsURL(latitude: 39.9, longitude: 116.3,
            label: "AED", navigation: invalid, viaAed: true))
    }
}

@MainActor
final class MapKitAedRouteCalculatorTests: XCTestCase {
    func testBothLegsAreSummedAsDistancesWithoutTimeOrAccessCost() async throws {
        let aed = Aed(id: "aed", name: "test", aedPosition: try AedPosition(latitude: 22.001, longitude: 113.001),
            openFrom: "00:00", openUntil: "00:00", floor: "1", floorTransferSeconds: 9999,
            accessNote: "", accessDelaySeconds: 9999, verificationSeconds: 9999, available: true)
        let context = ClientAedRouteContext(calculationId: UUID().uuidString, expiresAt: Date().addingTimeInterval(60),
            responder: try ResponderPosition(latitude: 22, longitude: 113, accuracyMeters: 5),
            patient: try PatientPosition(latitude: 22.002, longitude: 113.002, accuracyMeters: 5),
            aeds: [aed], eligibleCandidateCount: 1)
        var legs: [(Double, Double)] = []
        let distances = try await MapKitAedRouteCalculator.calculate(context) { from, to in
            legs.append((from.latitude, to.latitude))
            return from.latitude == 22 ? 120.5 : 230.25
        }
        XCTAssertEqual(distances, [.init(aedId: "aed", toAedMeters: 120.5, toPatientMeters: 230.25)])
        XCTAssertEqual(legs.count, 2)
        XCTAssertTrue(legs.contains { $0 == (22, 22.001) })
        XCTAssertTrue(legs.contains { $0 == (22.001, 22.002) })
    }

    func testAFreeLegSlotStartsTheNextCandidateAndResultsKeepInputOrder() async throws {
        let context = try makeContext(count: 8)
        let gate = RouteLegGate(context: context)
        let task = Task { try await MapKitAedRouteCalculator.calculate(context, leg: gate.calculate) }
        defer { task.cancel() }
        await fulfillment(of: [gate.started[0], gate.started[1]], timeout: 2)
        guard gate.isWaiting(0), gate.isWaiting(1) else {
            task.cancel()
            _ = try? await task.value
            return
        }
        gate.finish(1, with: .success(101))

        // Leg 0 stays blocked while every later leg uses the other slot. These
        // gates prove scheduling order without depending on elapsed milliseconds.
        for index in 2..<16 {
            await fulfillment(of: [gate.started[index]], timeout: 2)
            guard gate.isWaiting(index) else {
                task.cancel()
                _ = try? await task.value
                return
            }
            XCTAssertTrue(gate.isWaiting(0))
            gate.finish(index, with: .success(Double(100 + index)))
        }
        gate.finish(0, with: .success(100))
        let distances = try await task.value
        XCTAssertEqual(gate.peakActive, 2)
        XCTAssertEqual(gate.startedIndices.count, 16)
        XCTAssertEqual(gate.active, 0)
        XCTAssertEqual(distances, context.aeds.enumerated().map { index, aed in
            ClientAedRouteDistance(aedId: aed.id, toAedMeters: Double(100 + index * 2),
                                  toPatientMeters: Double(101 + index * 2))
        })
    }

    func testDirectionsNotFoundOnEitherLegOmitsTheWholeCandidate() async throws {
        let context = try makeContext(count: 4)
        let gate = RouteLegGate(context: context)
        let distances = try await MapKitAedRouteCalculator.calculate(context) { from, to in
            let index = try gate.index(from: from, to: to)
            if index == 2 || index == 5 { throw MKError(.directionsNotFound) }
            return Double(100 + index)
        }
        XCTAssertEqual(distances, [
            .init(aedId: context.aeds[0].id, toAedMeters: 100, toPatientMeters: 101),
            .init(aedId: context.aeds[3].id, toAedMeters: 106, toPatientMeters: 107)
        ])
    }

    func testOtherErrorsPropagateAndCancelTheRemainingLeg() async throws {
        let context = try makeContext(count: 3)
        let gate = RouteLegGate(context: context)
        let task = Task { try await MapKitAedRouteCalculator.calculate(context, leg: gate.calculate) }
        defer { task.cancel() }
        await fulfillment(of: [gate.started[0], gate.started[1]], timeout: 2)
        guard gate.isWaiting(0), gate.isWaiting(1) else {
            task.cancel()
            _ = try? await task.value
            return
        }
        gate.finish(0, with: .failure(RouteLegProbeError.failed))
        do {
            _ = try await task.value
            XCTFail("A failed leg must fail the calculation")
        } catch {
            XCTAssertEqual(error as? RouteLegProbeError, .failed)
        }
        XCTAssertEqual(Set(gate.startedIndices), Set([0, 1]))
        XCTAssertEqual(gate.cancelledIndices, [1])
        XCTAssertEqual(gate.active, 0)
    }

    func testCancellationPropagatesWithoutStartingMoreLegs() async throws {
        let context = try makeContext(count: 3)
        let gate = RouteLegGate(context: context)
        let task = Task { try await MapKitAedRouteCalculator.calculate(context, leg: gate.calculate) }
        await fulfillment(of: [gate.started[0], gate.started[1]], timeout: 2)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A cancelled calculation must not return partial routes")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(Set(gate.startedIndices), Set([0, 1]))
        XCTAssertEqual(Set(gate.cancelledIndices), Set([0, 1]))
        XCTAssertEqual(gate.active, 0)
    }

    func testAlreadyCancelledCalculationDoesNotCallTheLegCalculator() async throws {
        let context = try makeContext(count: 1)
        var calls = 0
        let task = Task {
            try await MapKitAedRouteCalculator.calculate(context) { _, _ in
                calls += 1
                return 10
            }
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("An already cancelled calculation must stop before making requests")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(calls, 0)
    }

    func testCandidateLimitRejectsBeforeStartingRequests() async throws {
        let context = try makeContext(count: 9)
        var calls = 0
        do {
            _ = try await MapKitAedRouteCalculator.calculate(context) { _, _ in
                calls += 1
                return 10
            }
            XCTFail("More than eight candidates must remain rejected")
        } catch {
            XCTAssertTrue(error is AedRouteError)
        }
        XCTAssertEqual(calls, 0)
    }

    private func makeContext(count: Int) throws -> ClientAedRouteContext {
        let aeds = try (0..<count).map { index in
            Aed(id: "aed-\(index)", name: "test", aedPosition: try AedPosition(
                latitude: 22.001 + Double(index) * 0.001, longitude: 113.001 + Double(index) * 0.001),
                openFrom: "00:00", openUntil: "00:00", floor: "1", floorTransferSeconds: 9999,
                accessNote: "", accessDelaySeconds: 9999, verificationSeconds: 9999, available: true)
        }
        return ClientAedRouteContext(calculationId: UUID().uuidString, expiresAt: Date().addingTimeInterval(60),
            responder: try ResponderPosition(latitude: 22, longitude: 113, accuracyMeters: 5),
            patient: try PatientPosition(latitude: 22.05, longitude: 113.05, accuracyMeters: 5),
            aeds: aeds, eligibleCandidateCount: count)
    }
}

private enum RouteLegProbeError: Error, Equatable {
    case failed
    case unexpectedEndpoints
}

@MainActor
private final class RouteLegGate {
    let started: [XCTestExpectation]
    private let context: ClientAedRouteContext
    private var continuations: [Int: CheckedContinuation<Double, Error>] = [:]
    private(set) var startedIndices: [Int] = []
    private(set) var cancelledIndices: [Int] = []
    private(set) var active = 0
    private(set) var peakActive = 0

    init(context: ClientAedRouteContext) {
        self.context = context
        started = (0..<(context.aeds.count * 2)).map { XCTestExpectation(description: "Leg \($0) started") }
    }

    func index(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) throws -> Int {
        if from.latitude == context.responder.latitude, from.longitude == context.responder.longitude,
           let index = context.aeds.firstIndex(where: {
               $0.aedPosition.latitude == to.latitude && $0.aedPosition.longitude == to.longitude
           }) {
            return index * 2
        }
        if to.latitude == context.patient.latitude, to.longitude == context.patient.longitude,
           let index = context.aeds.firstIndex(where: {
               $0.aedPosition.latitude == from.latitude && $0.aedPosition.longitude == from.longitude
           }) {
            return index * 2 + 1
        }
        throw RouteLegProbeError.unexpectedEndpoints
    }

    func calculate(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async throws -> Double {
        let index = try index(from: from, to: to)
        try Task.checkCancellation()
        startedIndices.append(index)
        active += 1
        peakActive = max(peakActive, active)
        defer { active -= 1 }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                continuations[index] = continuation
                started[index].fulfill()
            }
        } onCancel: {
            Task { @MainActor in
                if let continuation = self.continuations.removeValue(forKey: index) {
                    self.cancelledIndices.append(index)
                    continuation.resume(throwing: CancellationError())
                }
            }
        }
    }

    func isWaiting(_ index: Int) -> Bool { continuations[index] != nil }

    func finish(_ index: Int, with result: Result<Double, Error>) {
        guard let continuation = continuations.removeValue(forKey: index) else {
            XCTFail("Leg \(index) is not waiting")
            return
        }
        continuation.resume(with: result)
    }
}
