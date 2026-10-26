import Foundation
import XCTest

final class LoginLocalizationTests: XCTestCase {
    private var resourceBundle: Bundle {
        #if SWIFT_PACKAGE
        .module
        #else
        .main
        #endif
    }

    private func strings(_ language: String) throws -> [String: String] {
        let url = try XCTUnwrap(resourceBundle.url(forResource: "Login", withExtension: "strings", subdirectory: nil, localization: language))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: String])
    }

    func testBothLanguagesCoverExactlyTheSameLoginCopy() throws {
        let chinese = try strings("zh-Hans"), english = try strings("en")
        XCTAssertEqual(Set(chinese.keys), Set(english.keys))
        XCTAssertGreaterThanOrEqual(chinese.count, 30)
        XCTAssertTrue(chinese.values.allSatisfy { !$0.isEmpty })
        XCTAssertTrue(english.values.allSatisfy { !$0.isEmpty })
        XCTAssertTrue(english.values.allSatisfy { text in
            !text.unicodeScalars.contains { (0x4E00...0x9FFF).contains(Int($0.value)) }
        })
    }

    func testLoginAndFourIndependentAgreementsHaveCorrectLanguage() throws {
        let chinese = try strings("zh-Hans"), english = try strings("en")
        XCTAssertEqual(chinese["登录"], "登录")
        XCTAssertEqual(english["登录"], "Sign in")
        XCTAssertEqual(english["登录 AEDResponse"], "Sign in to AEDResponse")
        for key in ["《患者协议》", "《志愿响应者协议》", "《隐私政策》", "《敏感个人信息使用说明》"] {
            XCTAssertEqual(chinese[key], key)
            XCTAssertNotEqual(english[key], key)
        }
        XCTAssertEqual(english["单独同意 "], "Separate consent: ")
        XCTAssertNil(chinese["使用 Apple 账号登录，参与附近志愿协作。"])
    }

    func testSystemLanguageNegotiationSupportsChineseAndEnglish() {
        XCTAssertEqual(Bundle.preferredLocalizations(from: ["zh-Hans", "en"], forPreferences: ["zh-CN"]).first, "zh-Hans")
        XCTAssertEqual(Bundle.preferredLocalizations(from: ["zh-Hans", "en"], forPreferences: ["en-US"]).first, "en")
    }
}
