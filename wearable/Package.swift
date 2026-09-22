// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "AEDResponseCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "AEDResponseCore", targets: ["AEDResponseCore"])],
    targets: [
        .target(name: "AEDResponseCore", path: "Sources"),
        .testTarget(name: "AEDResponseCoreTests", dependencies: ["AEDResponseCore"], path: "Tests")
    ],
    swiftLanguageModes: [.v5]
)
