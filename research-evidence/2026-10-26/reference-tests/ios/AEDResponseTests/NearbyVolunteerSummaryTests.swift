import Foundation
import XCTest
@testable import AEDResponse

final class NearbyVolunteerSummaryTests: XCTestCase {
    private let generatedAt = Date(timeIntervalSince1970: 1_800_000_000)

    func testValidSummaryAndZeroPeoplePreserveFixedCumulativeRanges() throws {
        let summary = try makeSummary(counts: [0, 0, 0])

        XCTAssertEqual(summary.generatedAt, generatedAt)
        XCTAssertEqual(summary.ranges.map(\.radiusMeters), [1_000, 1_500, 2_000])
        XCTAssertEqual(summary.ranges.map(\.count), [0, 0, 0])
        XCTAssertEqual(summary.ranges.map(\.radiusLabel), ["1 公里内", "1.5 公里内", "2 公里内"])
    }

    func testBoundaryRadiiAndIntegerCountsAreAccepted() throws {
        let summary = try makeSummary(counts: [0, Int.max - 1, Int.max])

        XCTAssertEqual(summary.ranges.map(\.radiusMeters), [1_000, 1_500, 2_000])
        XCTAssertEqual(summary.ranges.map(\.count), [0, Int.max - 1, Int.max])
    }

    func testConstructorRejectsDuplicateMissingExtraOrMisorderedRadii() {
        let invalidRadii: [[Int]] = [
            [1_000, 1_000, 2_000],
            [1_000, 1_500],
            [1_000, 1_500, 2_000, 2_000],
            [1_000, 2_000, 1_500],
            [999, 1_500, 2_000],
            [1_000, 1_500, 2_001]
        ]

        for radii in invalidRadii {
            let ranges = radii.map {
                NearbyVolunteerRangeCount(radiusMeters: $0, count: 0)
            }
            XCTAssertThrowsError(
                try NearbyVolunteerSummary(generatedAt: generatedAt, ranges: ranges),
                "应拒绝半径序列 \(radii)"
            )
        }
    }

    func testConstructorRejectsNegativeAndDecreasingCumulativeCounts() {
        let invalidCounts: [[Int]] = [
            [-1, 0, 0],
            [1, 0, 1],
            [1, 3, 2]
        ]

        for counts in invalidCounts {
            XCTAssertThrowsError(
                try makeSummary(counts: counts),
                "应拒绝累计人数 \(counts)"
            )
        }
    }

    func testDecodeRejectsInvalidRangeShapesAndValues() {
        let invalidJSON: [String] = [
            json(radii: [1_000, 1_000, 2_000], counts: [0, 0, 0]),
            json(radii: [1_000, 1_500], counts: [0, 0]),
            json(radii: [1_000, 1_500, 2_000, 2_000], counts: [0, 0, 0, 0]),
            json(radii: [1_000, 1_500, 2_000], counts: [-1, 0, 0]),
            json(radii: [1_000, 1_500, 2_000], counts: [2, 1, 2]),
            #"{"generatedAt":"2026-01-15T08:00:00Z","ranges":[{"radiusMeters":1000,"count":1.5},{"radiusMeters":1500,"count":2},{"radiusMeters":2000,"count":3}]}"#,
            #"{"generatedAt":"not-a-date","ranges":[{"radiusMeters":1000,"count":0},{"radiusMeters":1500,"count":0},{"radiusMeters":2000,"count":0}]}"#,
            #"{"generatedAt":"2026-01-01T00:00:00Z","ranges":[{"radiusMeters":1000},{"radiusMeters":1500,"count":0},{"radiusMeters":2000,"count":0}]}"#,
            #"{"generatedAt":"2026-01-01T00:00:00Z"}"#
        ]

        for value in invalidJSON {
            XCTAssertThrowsError(try decode(value), "应拒绝无效摘要：\(value)")
        }
    }

    func testEncodingContainsOnlyContractFields() throws {
        let summary = try makeSummary(counts: [1, 2, 4])
        let data = try JSONEncoder.contractEncoder().encode(summary)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(Set(object.keys), ["generatedAt", "ranges"])
        let encodedRanges = try XCTUnwrap(object["ranges"] as? [[String: Any]])
        XCTAssertEqual(encodedRanges.count, 3)
        for range in encodedRanges {
            XCTAssertEqual(Set(range.keys), ["radiusMeters", "count"])
        }

        let decoded = try JSONDecoder.contractDecoder().decode(
            NearbyVolunteerSummary.self,
            from: data
        )
        XCTAssertEqual(decoded, summary)
    }

    func testFreshnessAcceptsBoundariesAndDoesNotZeroExpiredCounts() throws {
        let summary = try makeSummary(counts: [1, 2, 4])

        XCTAssertTrue(summary.isCurrent(at: generatedAt.addingTimeInterval(-5)))
        XCTAssertTrue(summary.isCurrent(at: generatedAt))
        XCTAssertTrue(summary.isCurrent(at: generatedAt.addingTimeInterval(120)))
        XCTAssertFalse(summary.isCurrent(at: generatedAt.addingTimeInterval(-5.001)))
        XCTAssertFalse(summary.isCurrent(at: generatedAt.addingTimeInterval(120.001)))
        XCTAssertEqual(summary.ranges.map(\.count), [1, 2, 4])
    }

    private func makeSummary(counts: [Int]) throws -> NearbyVolunteerSummary {
        try NearbyVolunteerSummary(
            generatedAt: generatedAt,
            ranges: zip([1_000, 1_500, 2_000], counts).map {
                NearbyVolunteerRangeCount(radiusMeters: $0.0, count: $0.1)
            }
        )
    }

    private func decode(_ value: String) throws -> NearbyVolunteerSummary {
        try JSONDecoder.contractDecoder().decode(
            NearbyVolunteerSummary.self,
            from: Data(value.utf8)
        )
    }

    private func json(radii: [Int], counts: [Int]) -> String {
        let ranges = zip(radii, counts).map {
            "{\"radiusMeters\":\($0.0),\"count\":\($0.1)}"
        }.joined(separator: ",")
        return "{\"generatedAt\":\"2026-01-15T08:00:00Z\",\"ranges\":[\(ranges)]}"
    }
}
