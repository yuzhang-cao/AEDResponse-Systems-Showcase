import Foundation
import XCTest
@testable import AEDResponse

final class ControlledSessionStoreTests: XCTestCase {
    private func session(_ method: AuthMethod, origin: String = "https://example.test/api/v2/") -> AuthSession {
        AuthSession(
            accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
            expiresAt: Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) + 300),
            userId: "REDACTED-ID-0169", method: method,
            serviceBaseURL: origin
        )
    }

    private func makeStore(
        _ backing: TestAuthSessionStore, enabled: Bool, file: URL
    ) -> ControlledTestAuthSessionStore {
        ControlledTestAuthSessionStore(
            expectedServiceBaseURL: "https://example.test/api/v2/", sessionStore: backing,
            allowsControlledAccounts: enabled, importFileURL: file
        )
    }

    /// A real Apple session works whether or not the controlled-test feature is on;
    /// a controlled-test session is REFUSED when the flag is off, and nothing is
    /// written.  This test previously asserted that saving a controlled session
    /// always succeeds, which is the opposite of what the flag means — it had never
    /// been executed by the smoke gate, so the wrong expectation survived.
    func testFormalSessionsWorkWithTestFeaturesEnabledOrDisabled() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for method in [AuthMethod.apple, .controlledTest] {
            for enabled in [true, false] {
                let backing = TestAuthSessionStore(session: nil)
                let store = makeStore(backing, enabled: enabled, file: file)
                let formal = session(method)
                if method == .controlledTest && !enabled {
                    XCTAssertThrowsError(try store.save(formal),
                                         "controlled-test sessions must be refused when the flag is off")
                    XCTAssertNil(backing.load(), "a refused session must not be persisted")
                    continue
                }
                try store.save(formal)
                XCTAssertEqual(store.load(), formal)
            }
        }
    }

    func testDisabledTestFeaturesRejectControlledSessionWithoutDeletingStoredData() throws {
        let controlled = session(.controlledTest)
        let backing = TestAuthSessionStore(session: controlled)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = makeStore(backing, enabled: false, file: file)
        XCTAssertNil(store.load())
        XCTAssertThrowsError(try store.save(controlled))
        XCTAssertEqual(backing.load(), controlled)
    }

    func testResidualTestImportCannotOverwriteFormalIdentity() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try JSONEncoder.contractEncoder().encode(session(.controlledTest)).write(to: file)
        let formal = session(.apple)
        let backing = TestAuthSessionStore(session: formal)
        let store = makeStore(backing, enabled: true, file: file)
        XCTAssertEqual(store.load(), formal)
        XCTAssertEqual(backing.load(), formal)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    func testExplicitTestImportPersistsThenRemovesOnlyTheImportCopy() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let controlled = session(.controlledTest)
        try JSONEncoder.contractEncoder().encode(controlled).write(to: file)
        let backing = TestAuthSessionStore(session: nil)
        let store = makeStore(backing, enabled: true, file: file)
        XCTAssertEqual(store.load(), controlled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(store.load(), controlled)
    }

    func testForeignOriginAndCorruptImportsCannotReplaceAnExistingSession() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let original = session(.controlledTest)
        let backing = TestAuthSessionStore(session: original)
        let store = makeStore(backing, enabled: true, file: file)
        XCTAssertThrowsError(try store.save(session(.apple, origin: "https://other.test/api/v2/")))
        try Data("not-json".utf8).write(to: file)
        XCTAssertEqual(store.load(), original)
        XCTAssertEqual(backing.load(), original)
    }
}
