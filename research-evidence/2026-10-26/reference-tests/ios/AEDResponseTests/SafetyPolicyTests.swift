import Foundation
import XCTest
@testable import AEDResponse

final class SafetyPolicyTests: XCTestCase {
    func testOnlyExactSafeNumberCanOpenDialerURL() throws {
        let policy = SafetyPolicy.fallback
        let url = try policy.dialURL(for: "+1 (202) 555-0147")

        XCTAssertEqual(url.scheme, "tel")
        XCTAssertTrue(url.absoluteString.contains("12025550147"))
        XCTAssertThrowsError(try policy.dialURL(for: "+1 202 555 0199"))
    }

    func testEmergencyNumbersAreBlockedAfterNormalization() {
        let policy = SafetyPolicy.fallback
        for number in ["110", "1-1-2", "119", "1 2 0", "911", "999"] {
            XCTAssertThrowsError(try policy.dialURL(for: number), "应拦截 \(number)")
        }
    }

    func testUnsafeFeatureFlagsInvalidatePolicy() {
        let unsafe = SafetyPolicy(
            schemaVersion: "2.0.0",
            safeTestNumber: "+12025550147",
            dialerMode: "AUTO_CALL",
            blockedNormalizedNumbers: ["120"],
            medicalDiagnosisEnabled: true,
            realEmergencyDispatchEnabled: true,
            publicRegistrationEnabled: true,
            manualSOSEnabled: true,
            appFalseAlarmCountdownEnabled: true,
            mockWearableProductionEntryEnabled: true,
            iphoneFallDetectionEnabled: true,
            automaticCallingEnabled: true
        )
        XCTAssertThrowsError(try unsafe.validateBoundaries())
    }
}
