import Foundation
import XCTest
@testable import AEDResponse

final class ServerConnectionProbeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubHealthURLProtocol.response = StubHealthURLProtocol.StubResponse(
            statusCode: 200,
            body: Data(#"{"status":"ok"}"#.utf8)
        )
        StubHealthURLProtocol.requests.removeAll()
    }

    func testCanonicalHealthURLUsesHTTPSOriginAndHealthPath() {
        let url = ServerConnectionProbe.canonicalHealthURL(
            from: "https://Example.TEST/api/v2/"
        )

        XCTAssertEqual(url?.absoluteString, "https://example.test/healthz")
    }

    func testCompanionConnectivityLegacyInitializerLeavesNewFieldsUnknown() {
        let state = CompanionConnectivityState(
            activationState: .activated,
            watchReachable: true
        )

        XCTAssertNil(state.isPaired)
        XCTAssertNil(state.isWatchAppInstalled)
    }

    func testCanonicalHealthURLRejectsNonHTTPSAndCredentials() {
        XCTAssertNil(
            ServerConnectionProbe.canonicalHealthURL(from: "http://example.test/api/v2/")
        )
        XCTAssertNil(
            ServerConnectionProbe.canonicalHealthURL(from: "https://user:[REDACTED_EMAIL]")
        )
    }

    func testProbeRequiresHTTP200AndStatusOK() async {
        let probe = makeProbe()

        let success = await probe.probe(configuredServiceBaseURL: "https://example.test/api/v2/")
        guard case let .success(roundTripMilliseconds) = success else {
            return XCTFail("有效的 200/status=ok 响应应成功")
        }
        XCTAssertGreaterThanOrEqual(roundTripMilliseconds, 0)
        XCTAssertEqual(StubHealthURLProtocol.requests.last?.httpMethod, "GET")
        XCTAssertEqual(
            StubHealthURLProtocol.requests.last?.url?.absoluteString,
            "https://example.test/healthz"
        )

        StubHealthURLProtocol.response = StubHealthURLProtocol.StubResponse(
            statusCode: 200,
            body: Data(#"{"status":"not-ok"}"#.utf8)
        )
        let invalidStatus = await probe.probe(
            configuredServiceBaseURL: "https://example.test/api/v2/"
        )
        XCTAssertEqual(invalidStatus, .unavailable)

        StubHealthURLProtocol.response = StubHealthURLProtocol.StubResponse(
            statusCode: 204,
            body: Data(#"{"status":"ok"}"#.utf8)
        )
        let invalidHTTPStatus = await probe.probe(
            configuredServiceBaseURL: "https://example.test/api/v2/"
        )
        XCTAssertEqual(invalidHTTPStatus, .unavailable)
    }

    private func makeProbe() -> ServerConnectionProbe {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubHealthURLProtocol.self]
        return ServerConnectionProbe(session: URLSession(configuration: configuration))
    }
}

private final class StubHealthURLProtocol: URLProtocol {
    struct StubResponse {
        let statusCode: Int
        let body: Data
    }

    nonisolated(unsafe) static var response = StubResponse(statusCode: 500, body: Data())
    nonisolated(unsafe) static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let client,
              let requestURL = request.url
        else {
            return
        }
        Self.requests.append(request)
        let stub = Self.response
        guard let response = HTTPURLResponse(
            url: requestURL,
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        ) else {
            client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: stub.body)
        client.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
