# AEDResponse Systems Showcase

Selected, runnable code from a graduation project on location-driven volunteer coordination and phone–wearable recovery. The repository highlights spatial candidate selection, transactional state changes, missing sensor-record handling, and durable Watch retry logic.

This is a research/engineering prototype. It is not an operational emergency service, clinical validation, or learned embodied-intelligence policy.

## Research evidence archive

The [Chinese research evidence index](research-evidence/2026-10-26/README.md) collects sanitized historical reports, performance observations, failed and rerun test results, archived test sources, and offline UI screenshots. Start with its evidence boundaries and [Deep Research prompt](research-evidence/2026-10-26/DEEP_RESEARCH_PROMPT.md) when assessing whether this project supports a research proposal. [Download the evidence ZIP](https://github.com/yuzhang-cao/AEDResponse-Systems-Showcase/archive/refs/heads/main.zip).

Historical artifacts and archived tests are reference material; they are separate from the runnable showcase below. No claim of research novelty or clinical effectiveness is made.

## Core code

| Area | Implementation | Tests |
| --- | --- | --- |
| Conservative spatial lookup | [device-position-index.ts](backend/src/device-position-index.ts) | [device-position-index.test.ts](backend/test/device-position-index.test.ts) |
| Position-window reconciliation | [position-window.ts](backend/src/position-window.ts) | [position-window-reconciliation.test.ts](backend/test/position-window-reconciliation.test.ts) |
| Transaction-aware coordination | [entity-transaction.ts](backend/src/entity-transaction.ts), [tx-recruitment-context.ts](backend/src/tx-recruitment-context.ts) | [transaction-index-overlay.test.ts](backend/test/transaction-index-overlay.test.ts), [recruitment-differential.test.ts](backend/test/recruitment-differential.test.ts) |
| Wearable recovery | [FallEmergencyCoordinator.swift](wearable/Sources/AEDResponseWatchLogic/FallEmergencyCoordinator.swift), [WatchFallbackCoordinator.swift](wearable/Sources/AEDResponseWatchLogic/WatchFallbackCoordinator.swift) | [WatchMonitoringTests.swift](wearable/Tests/AEDResponseWatchLogicTests/WatchMonitoringTests.swift) |
| Task state and privacy | [StateMachines.swift](wearable/Sources/AEDResponse/StateMachines.swift), [Models.swift](wearable/Sources/AEDResponse/Models.swift) | [StateMachineTests.swift](wearable/Tests/AEDResponseTests/StateMachineTests.swift), [ResponsePrivacyProjectionTests.swift](wearable/Tests/AEDResponseTests/ResponsePrivacyProjectionTests.swift) |

## Run

Backend requirements: Node.js 22 LTS (Node.js 24 was also verified locally on macOS), npm, Python and a C++ toolchain when SQLite has no prebuilt binary.

```sh
cd backend
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run check
npm run build
npm test
npm run demo
```

Swift requirements: macOS 14+ with a Swift 6 toolchain. Open `wearable/Package.swift` in Xcode, or run the tests below. The `AEDResponseCore` module shares one model definition between phone and wearable logic.

```sh
cd wearable
swift test
```

Backend tests and the demo block network access and use synthetic fixtures. Current local test counts and the published baseline are recorded in [validation.json](docs/validation.json).

Production deployment files, signing material, private live data, runtime databases, raw private device archives, and the original repository history are excluded. The research evidence archive includes reviewed, sanitized copies of historical reports, handoffs and selected logs, with exclusions and transformations documented. The selected code demonstrates sensor-driven systems and distributed-device coordination; it does not implement robot actuation, SLAM, policy learning, or vision-language-action models.

The preparation used AI assistance for review, correctness fixes, extraction, tests, and this English presentation. Physical Watch behavior, real emergency calls, APNs delivery, clinical effectiveness, production capacity, and public deployment are not claimed.
