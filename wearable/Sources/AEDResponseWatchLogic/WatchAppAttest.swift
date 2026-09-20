import CryptoKit
import DeviceCheck
import Foundation

protocol WatchAppAttestProviding: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data
}

/// Production adapter around Apple's App Attest service.  There is no fake
/// attestation path in the Watch target: unsupported devices and every Apple
/// service failure remain link failures.
final class DeviceCheckAppAttestAdapter: @unchecked Sendable, WatchAppAttestProviding {
    private let service: DCAppAttestService

    init(service: DCAppAttestService = .shared) {
        self.service = service
    }

    var isSupported: Bool { service.isSupported }

    func generateKey() async throws -> String {
        try await service.generateKey()
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await service.attestKey(keyID, clientDataHash: clientDataHash)
    }
}

enum CompanionLinkClientData {
    /// This must remain byte-for-byte aligned with backend/src/auth.ts:
    /// JSON.stringify({ purpose, companionLinkTicketHash,
    /// deviceInstanceId, companionPairId }).
    static func hash(
        ticket: String,
        deviceInstanceID: String,
        companionPairID: String
    ) -> Data {
        let ticketHash = SHA256.hash(data: Data(ticket.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let canonical = "{\"purpose\":\"AEDResponse.watch-companion-link\",\"companionLinkTicketHash\":\"\(ticketHash)\",\"deviceInstanceId\":\"\(deviceInstanceID)\",\"companionPairId\":\"\(companionPairID)\"}"
        return Data(SHA256.hash(data: Data(canonical.utf8)))
    }
}
