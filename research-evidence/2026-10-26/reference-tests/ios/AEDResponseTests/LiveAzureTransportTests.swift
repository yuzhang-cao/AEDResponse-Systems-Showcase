import Foundation
@preconcurrency import Network
import UIKit
import XCTest
@testable import AEDResponse

/// Opt-in physical-device diagnostics. Ordinary TestHost/UI tests stay offline.
/// No test identity is submitted as an authenticated account or device session.
@MainActor
final class LiveAzureTransportTests: XCTestCase {
    private func configuredOrigin() throws -> URL {
        guard let value = ProcessInfo.processInfo.environment["AED_LIVE_TEST_ORIGIN"],
              !value.isEmpty else {
            throw XCTSkip("Set AED_LIVE_TEST_ORIGIN explicitly to run public network diagnostics")
        }
        let configuration = try APIConfiguration(userEnteredURL: value)
        XCTAssertEqual(configuration.socketServerURL.scheme, "https")
        return configuration.socketServerURL
    }

    private func record(_ message: String) {
        print("AZURE_DEVICE_PROBE \(message)")
        let attachment = XCTAttachment(string: message)
        attachment.name = "Azure physical-device transport"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testNativeHealthAndNetworkPath() async throws {
        let origin = try configuredOrigin()
        let monitor = NWPathMonitor()
        let paths = AsyncStream<String> { continuation in
            monitor.pathUpdateHandler = { path in
                let interfaces = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .other]
                    .filter { path.usesInterfaceType($0) }.map { String(describing: $0) }
                continuation.yield("status=\(path.status) interfaces=\(interfaces.joined(separator: ",")) expensive=\(path.isExpensive)")
                continuation.finish()
            }
            monitor.start(queue: DispatchQueue(label: "aedresponse.azure.path-probe"))
        }
        var iterator = paths.makeAsyncIterator()
        if let path = await iterator.next() { record("network \(path)") }
        monitor.cancel()

        let result = await ServerConnectionProbe().probe(configuredServiceBaseURL: origin.absoluteString)
        guard case let .success(milliseconds) = result else {
            return XCTFail("Native HTTPS health probe failed: \(result)")
        }
        record("health=200 status=ok rttMs=\(milliseconds) iOS=\(UIDevice.current.systemVersion)")
    }

    func testProtectedRESTRequiresAuthentication() async throws {
        let origin = try configuredOrigin()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let url = origin.appendingPathComponent("api/v2/me/presence")
        let (data, response) = try await session.data(from: url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
        let problem = try JSONDecoder().decode(ProblemDetails.self, from: data)
        XCTAssertEqual(problem.title, "Unauthorized")
        record("protectedREST=401 no device session created")
    }

    func testAppleAPIClientReportsUnavailable() async throws {
        let origin = try configuredOrigin()
        let client = APIClient(configuration: try APIConfiguration(userEnteredURL: origin.absoluteString))
        do {
            _ = try await client.requestAppleLoginChallenge()
            XCTFail("This unconfigured-provider diagnostic no longer applies when Apple login is configured")
        } catch let error as APIClientError {
            guard case let .rejected(problem) = error else { throw error }
            XCTAssertEqual(problem.status, 503)
            XCTAssertEqual(problem.title, "Authentication unavailable")
            record("canonicalAPIClient Apple endpoint=503 provider unconfigured; no real Apple credential used")
        }
    }

    func testJSONBodyLimitAtPublicIngress() async throws {
        let origin = try configuredOrigin()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        for (length, expectedStatus) in [(16_384, 400), (16_385, 413)] {
            var request = URLRequest(url: origin.appendingPathComponent("api/v2/auth/apple"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(("{}" + String(repeating: " ", count: length - 2)).utf8)
            request.timeoutInterval = 15
            let (_, response) = try await session.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, expectedStatus)
            record("JSON bytes=\(length) status=\(expectedStatus)")
        }
    }

    func testNativeWSSReachesSocketAuthenticationGate() async throws {
        let origin = try configuredOrigin()
        var components = try XCTUnwrap(URLComponents(url: origin, resolvingAgainstBaseURL: false))
        components.scheme = "wss"
        components.path = "/socket.io/"
        components.queryItems = [.init(name: "EIO", value: "4"), .init(name: "transport", value: "websocket")]
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: try XCTUnwrap(components.url))
        request.timeoutInterval = 15
        let socket = session.webSocketTask(with: request)
        socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }

        guard case let .string(open) = try await socket.receive() else {
            return XCTFail("Expected an Engine.IO open packet")
        }
        XCTAssertTrue(open.hasPrefix("0{"))
        let handshake = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(open.dropFirst().utf8)) as? [String: Any])
        XCTAssertEqual(handshake["maxPayload"] as? Int, 16_384)
        // Engine.IO message + Socket.IO connect; no bearer, user data or position.
        try await socket.send(.string("40"))
        guard case let .string(rejected) = try await socket.receive() else {
            return XCTFail("Expected a Socket.IO authentication error")
        }
        XCTAssertTrue(rejected.hasPrefix("44{"))
        XCTAssertTrue(rejected.contains("A valid authenticated session is required"))
        record("WSS TLS and Engine.IO handshake succeeded; Socket.IO missing-bearer rejection verified")
    }
}
