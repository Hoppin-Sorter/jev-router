// swift-tools-version:5.9
import PackageDescription

// JevCore is Foundation only (pricing, the ~/.config/jev contract, transcript usage),
// so its checks run anywhere Swift does. JevBar is the macOS menu bar app.
let package = Package(
    name: "JevBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "JevBar", targets: ["JevBar"]),
    ],
    targets: [
        .target(name: "JevCore"),
        .executableTarget(name: "JevBar", dependencies: ["JevCore"]),
        // `swift run JevCoreChecks` — plain assertions, no XCTest or Swift Testing needed.
        .executableTarget(name: "JevCoreChecks", dependencies: ["JevCore"]),
    ]
)
