import Foundation

/// Latest-value R only. Event evidence keeps its independent one-second clock.
enum LatestPositionUploadPolicy {
    static func isValid(_ coordinate: DeviceCoordinate) -> Bool {
        coordinate.latitude.isFinite && coordinate.longitude.isFinite
            && (-90...90).contains(coordinate.latitude) && (-180...180).contains(coordinate.longitude)
            && coordinate.accuracyMeters.isFinite && coordinate.accuracyMeters > 0
            && coordinate.observedAt.timeIntervalSince1970.isFinite
    }

    static func permits(
        _ current: DeviceCoordinate,
        after previous: DeviceCoordinate?,
        lastStartedAt: Date?,
        now: Date,
        tier: DevicePositioningTier
    ) -> Bool {
        guard tier != .eventParticipant, isValid(current),
              now.timeIntervalSince1970.isFinite
        else { return false }
        guard let previous, let lastStartedAt else { return true }
        guard current.observedAt > previous.observedAt else { return false }
        let interval: TimeInterval = tier == .searchRing ? 15 : 120
        let movement: Double = tier == .searchRing ? 30 : 100
        return now.timeIntervalSince(lastStartedAt) >= interval
            || distanceMeters(previous, current) >= movement
    }

    private static func distanceMeters(_ first: DeviceCoordinate, _ second: DeviceCoordinate) -> Double {
        let radians = Double.pi / 180
        let latitudeDelta = (second.latitude - first.latitude) * radians
        let longitudeDelta = (second.longitude - first.longitude) * radians
        let a = pow(sin(latitudeDelta / 2), 2)
            + cos(first.latitude * radians) * cos(second.latitude * radians)
            * pow(sin(longitudeDelta / 2), 2)
        return 6_371_008.8 * 2 * asin(sqrt(min(1, max(0, a))))
    }
}
