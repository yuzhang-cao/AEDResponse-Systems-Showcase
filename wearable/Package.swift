// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "AEDResponseWatchLogic",
    platforms: [.macOS(.v14)],
    products: [.library(name: "AEDResponseWatchLogic", targets: ["AEDResponseWatchLogic"])],
    targets: [
        .target(name: "AEDResponseWatchLogic"),
        .target(name: "AEDResponse"),
        .testTarget(name: "AEDResponseTests", dependencies: ["AEDResponse"]),
        .testTarget(name: "AEDResponseWatchLogicTests", dependencies: ["AEDResponseWatchLogic"])
    ],
    swiftLanguageModes: [.v5]
)
