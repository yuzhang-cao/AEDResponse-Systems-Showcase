# AEDResponse Systems Showcase

Selected, runnable code from a graduation project on location-driven volunteer coordination and phone–wearable recovery. The repository highlights spatial candidate selection, transactional state changes, missing sensor-record handling, and durable Watch retry logic.

This is a research/engineering prototype. It is not an operational emergency service, clinical validation, or learned embodied-intelligence policy.

## Core code

| Area | Implementation | Tests |
| --- | --- | --- |
| Conservative spatial lookup | [device-position-index.ts](backend/src/device-position-index.ts) | [device-position-index.test.ts](backend/test/device-position-index.test.ts) |
| Position-window reconciliation | [position-window.ts](backend/src/position-window.ts) | [position-window-reconciliation.test.ts](backend/test/position-window-reconciliation.test.ts) |
| Transaction-aware coordination | [entity-transaction.ts](backend/src/entity-transaction.ts), [tx-recruitment-context.ts](backend/src/tx-recruitment-context.ts) | [transaction-index-overlay.test.ts](backend/test/transaction-index-overlay.test.ts), [recruitment-differential.test.ts](backend/test/recruitment-differential.test.ts) |
| Wearable recovery | [FallEmergencyCoordinator.swift](wearable/Sources/AEDResponseWatchLogic/FallEmergencyCoordinator.swift), [WatchFallbackCoordinator.swift](wearable/Sources/AEDResponseWatchLogic/WatchFallbackCoordinator.swift) | [WatchMonitoringTests.swift](wearable/Tests/AEDResponseWatchLogicTests/WatchMonitoringTests.swift) |
| Task state and privacy | [StateMachines.swift](wearable/Sources/AEDResponse/StateMachines.swift), [Models.swift](wearable/Sources/AEDResponse/Models.swift) | [StateMachineTests.swift](wearable/Tests/AEDResponseTests/StateMachineTests.swift), [ResponsePrivacyProjectionTests.swift](wearable/Tests/AEDResponseTests/ResponsePrivacyProjectionTests.swift) |

## Run

Backend requirements: Node.js 24, npm, Python and a C++ toolchain when SQLite has no prebuilt binary.

```sh
cd backend
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run check
npm run build
npm test
npm run demo
```

Swift requirements: macOS 14+ with a Swift 6 toolchain.

```sh
cd wearable
swift test
```

Local validation on 2026-09-20: 121 backend tests and 85 Swift tests passed with zero failures. Backend tests and the demo block network access and use synthetic fixtures. Machine-readable results are in [validation.json](docs/validation.json).

Production deployment files, signing material, live data, device logs, runtime databases, internal handoffs, and the original repository history are excluded. The selected code demonstrates sensor-driven systems and distributed-device coordination; it does not implement robot actuation, SLAM, policy learning, or vision-language-action models.

The preparation used AI assistance for review, three correctness fixes, extraction, tests, and this English presentation. Physical Watch behavior, real emergency calls, APNs delivery, clinical effectiveness, production capacity, and public deployment are not claimed.
