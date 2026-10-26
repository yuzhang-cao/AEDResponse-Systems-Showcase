# AEDResponse v2 backend

Node.js/TypeScript reference backend for the frozen AEDResponse v2 contracts. It is
an authenticated-device coordination service, not a real emergency-dispatch service.

## Current Azure deployment (2026-09-08)

The user resumed Azure deployment and network testing on September 7–8. The current
canonical backend now runs on the approved Japan East VM through systemd and Caddy
HTTPS/WSS. See [deployment configuration, verification and remaining gates](deploy/azure/README.md).
The older paused-scope notes below are historical for that batch. Real SMS, Apple
identity and Watch attestation adapters remain unconfigured; health and transport
success are not successful login or two-iPhone business acceptance.

## What it owns

- stable `user`/`account` records for Sign in with Apple (legacy PHONE rows are read-compatible only);
- short-lived, scoped and rotatable account/device sessions bound to `userId`;
- Watch/iPhone pairing through an opaque `companionPairId`;
- latest-wins iPhone P/R position and presence/capability state;
- append-only event participant position batches containing strict UTC-second `FIX` or
  `NO_NEW_FIX` records (`fixObservedAt` is confined to its slot and gaps carry an explicit reason);
- idempotent Watch observations and event creation;
- durable dynamic recruitment rings (`1000 → 1500 → 2000` meters), server-truth
  30-second offers and persistent scheduler tick;
- Watch-only direct fallback samples gated by the triggering Watch, its user/pair
  binding, iPhone reachability state, Watch network availability and source ordering;
- Haversine nearby-responder filtering, acceptance-time eligibility revalidation,
  dynamic coordination counts and targeted Socket.IO delivery;
- REST event truth, assignment planning, append-only timelines and receipts;
- one-confirmation patient event ending, on-scene professional takeover, and
  stable-user responder exit revocation;
- durable T+30 status-confirmation prompts and T+35 unconfirmed closure;
- false-alarm cancellation, explicit resolution, AED unavailable/reassignment and
  idempotent `AED_ACQUIRED` handling.

It does not dial emergency services, infer phone numbers or call duration, diagnose a
patient, or provide APNs delivery. APNs remains necessary for reliable recruitment
when an iPhone app is suspended or terminated. iPhone business traffic uses network
REST + Socket.IO; Bluetooth is not a transport for this backend.

The current bootstrap still trusts client-supplied device/pair identifiers and
agreement records, but it now requires a previously authenticated account session.
Internet or production use additionally requires a one-time pairing proof, App
Attest/device attestation, TLS, abuse controls and an approved retention/deletion
policy.

## Account authentication boundary

The product now accepts only Sign in with Apple. The former phone challenge and
verification endpoints have been removed. `POST /api/v2/auth/apple/challenges`
issues a five-minute one-use challenge.
`POST /api/v2/auth/apple` requires `challengeId`, `identityToken` and raw `nonce`;
`authorizationCode` is optional. The native client sends SHA256(nonce) to Apple.
`AppleJWTVerifier` verifies RSA/JWKS signature, issuer, explicit audience, expiry
and nonce. `src/main.ts` enables it only when `AED_APPLE_CLIENT_IDS` is configured.
Without a provider, Apple endpoints return 503; membership alone does not enable them.

Before starting the backend, run `npm run check:apple-login` in the same environment
as the service. It validates the audience allowlist and a stable subject pepper
without opening the database or printing secrets. Set `AED_APPLE_CLIENT_IDS` to
the actual signed native Bundle ID (the production target is
`dev.codex.aedresponse`), never a Team ID or a value copied from an untrusted token.
Set `AED_AUTH_SUBJECT_PEPPER` to a securely generated secret of at least 32 bytes.
Preserve the existing pepper: changing it changes identity lookup and can create
duplicate accounts. Do not include the Tests Bundle ID unless its capability and
signing are explicitly configured and that audience is intentionally authorized.

This check does not verify Apple Developer capability, provisioning, JWKS network
access, actual login, authorization-code exchange or Apple revocation notifications.
Challenges currently live in one server process; restarting requires a new challenge.

New accounts store a provider-scoped HMAC subject digest; raw Apple identity tokens
are not written to durable state. Repeated successful login for the same active
Apple subject reuses the same `userId`/`accountId`. Legacy PHONE rows remain readable
but cannot be used for new phone login. Account login responses include a 30-day
opaque refresh token; `POST
/api/v2/auth/session/refresh` rotates it once, invalidates the old access/refresh
pair, and revokes the complete family on reuse. `POST /api/v2/session/bootstrap`
requires the account bearer session and issues a device session carrying the same
`userId`/`accountId`. All business and Socket.IO routes remain bearer-authenticated.

An authenticated iPhone creates a five-minute, one-use `companionLinkTicket` at
`POST /api/v2/me/companion-link-tickets`. The Watch exchanges that ticket together
with its `deviceInstanceId`, `companionPairId`, `appAttestKeyId`, and base64
`attestationObject` at `POST /api/v2/watch/session/redeem`. The injected verifier
receives the normalized binding, expected challenge/client-data hash, and configured
App Attest app ID; the backend does not decode the attestation object. The legacy
Watch branch of `/api/v2/session/bootstrap` is rejected. A redeemed Watch session
gets a 30-day opaque refresh token at `POST /api/v2/watch/session/refresh`; rotation
is single-use and reuse revokes its family. Explicit account/iPhone logout revokes
the user's sessions and unconsumed tickets and disables collection. A low-level
single-session revocation remains scoped to that session. An explicit unbind endpoint
is not yet exposed.

Account closure uses the legacy `DELETE /api/v2/auth/account` endpoint. It retains
existing server information and marks `users.lifecycleState=CLOSED` with `closedAt`;
device `loginState=SIGNED_OUT` is separate from account lifecycle. Closure revokes
sessions and rejects refresh or automatic reactivation on Apple login. An original
closure token may only replay its own successful closure receipt; it cannot regain
business access. The compatibility receipt field `erasureStartedAt` is a closure
timestamp, not a claim of physical erasure. Restoring closure/revocation status after
an older backup is restored remains unfinished.

During active rescue, the mobile app blocks logout and closure. The patient first
uses three confirmations to cancel assistance; responders likewise confirm their
exit three times. Outside active participation, mobile logout completes locally
immediately and the durable queue retries remote revocation. The server does not
add a separate active-participation authorization gate to these account operations.

The canonical patient end action is `POST /api/v2/events/{eventId}/end` with one
confirmed reason: `FALSE_ALARM`, `PROBLEM_RESOLVED`, or `PROFESSIONAL_TAKEOVER`.
The additional `ASSISTANCE_WITHDRAWN` reason requires `withdrawalConfirmed=true`
and maps to `CANCELLED_ASSISTANCE_WITHDRAWN` after the mobile cancellation sequence.
The backend keeps the
old false-alarm/resolve handlers as compatibility paths for existing clients. An
accepted responder may confirm professional takeover through `/resolve` only after
reaching the patient. Responders leave through `POST /api/v2/events/{eventId}/exit`;
the stable user is then permanently excluded from that event, its current position
projection is cleared, and its realtime write, assignment, read and communication access
are revoked. Persisted position batches, participation intervals and valid pre-exit late
evidence remain append-only. At T+30 the durable scheduler
emits one patient status-confirmation request; `CONTINUE` restarts the cycle, while
no response by T+35 produces `CLOSED_UNCONFIRMED_NO_RESPONSE/STOPPED`. Passive call,
Watch, app, permission, network, and no-responder signals never end an event.

## Local evidence and retention additions (2026-09-13)

`createBackend` now signs event evidence inside the state transaction and verifies
existing signatures at startup. For the normal persisted store, keep the generated
`${AED_DATA_FILE}.evidence-key.pem` private key with the database recovery material;
it is created with mode 0600. Missing keys for signed data cause startup to fail.
Unsigned legacy history receives an explicitly dated BASELINE on initial adoption,
not a reconstructed historical signature. Independent backup anchors, full key
operations and access auditing are still unfinished.

Terminal events enter logical `SEALED` state after 30 days and become eligible for
purging after three calendar years, unless held. Purging commits authorization
before removing evidence, so interrupted cleanup can retry. Logical sealing does
not yet encrypt or move historical data out of the main state. Asset custody is
independent: expiration of event evidence does not imply physical AED return.

The completed local changes, 514 backend regressions and remaining limitations are
recorded in the [closeout evidence](../docs/evidence/local-closeout-2026-09-13/README.md).
Older dated sections below retain their original historical verification scopes.

## Local development

### Current business-only verification scope (2026-09-05)

Latest result: **68 tests, 68 passed, 0 failed** after implementing AED-shortage
fallback, exit replanning and the transactional sole-responder confirmation gate.
The original three regression scenarios remain in the suite and now pass.
See [the business processing report](../docs/business-processing-validation.md)
for reproduction, source evidence and coverage limits.

The user has paused server reception, device transmission, and all network
integration tests. Real PHONE/APPLE provider development is also deferred until
the student server resources are ready. The currently authorized test entry is:

```bash
npm run test:business
```

It calls the domain service directly with synthetic identities, coordinates and a
controllable clock, using memory or temporary SQLite stores. Notifications are
captured by an in-process publisher. Its preload rejects TCP listeners/connections,
HTTP/HTTPS requests, UDP sockets, `fetch`, and WebSocket use. It does not start the
backend, invoke a phone/Watch, or contact a remote server. Known requirement gaps
remain failing assertions; a successful legacy suite alone is not full acceptance.

The general development commands below include network tests and service startup;
they are outside the current paused scope.

```bash
cd backend
npm ci
npm test
npm run build
npm start
```

`better-sqlite3` is pinned to the Node-18-compatible 11.10 line. A deployment is not
ready until `npm ci`, the native binding load, tests and build all succeed on that
machine/architecture.

The development defaults listen only on `127.0.0.1:8787`. Directly binding another
private address is permitted only for controlled development. The address is deployment
configuration and is never embedded in application source. Tailscale may still be used
for Windows administration, but it is not an iPhone production data path.

## Production WAN requirement (deployment not configured)

The production iPhone must reach this service from cellular data or arbitrary external
Wi-Fi through a public HTTPS endpoint, with Socket.IO upgraded over WSS. Sharing a LAN
with Windows, joining Tailscale, or connecting directly to a private Windows address is
not an acceptance condition.

The Windows SQLite service is a local reference and test target, not the production
origin. Port `8787` must not be exposed directly to the public Internet. The eventual
mainland-China production deployment must terminate a publicly trusted TLS certificate,
support WebSocket upgrade, constrain the origin route, enforce the frozen 16 KiB request
boundary and anomaly fuse, and retain audit evidence. It must not impose a separate
business rate limit on normal location cadence. No public listener, DNS, certificate,
router rule, tunnel, or cloud resource is created by the current work.

## Configuration

| Variable | Development default | Meaning |
| --- | --- | --- |
| `AED_HOST` | `127.0.0.1` | Exact listen address |
| `AED_PORT` | `8787` | HTTP/Socket.IO port |
| `AED_DATA_FILE` | `backend/.data/state.sqlite` | SQLite state truth |
| `AED_LEGACY_DATA_FILE` | `backend/.data/state.json` | Optional one-time legacy import source |
| `AED_FIXTURE_FILE` | `contracts/fixtures/demo-scenario.json` | Seed AED inventory |
| `AED_SESSION_TTL_SECONDS` | `900` | Account/device token lifetime |
| `AED_NEARBY_RADIUS_METERS` | `3000` | Legacy development setting retained for compatibility; event recruitment uses fixed 1,000/1,500/2,000m rings |
| `AED_POSITION_MAX_AGE_SECONDS` | `600` | Maximum current P/R position age |
| `AED_MAX_POSITION_ACCURACY_METERS` | `200` | Maximum accepted horizontal error |
| `AED_MAX_CLIENT_CLOCK_SKEW_SECONDS` | `120` | Allowed future client-clock skew; age is clamped to zero inside this boundary |
| `AED_BOOTSTRAP_LIMIT_PER_MINUTE` | `30` | Authentication/bootstrap limit per remote address |
| `AED_AUTH_SUBJECT_PEPPER` | unset | HMAC secret for provider subject lookup; required in production |
| `AED_WATCH_APP_ATTEST_APP_ID` | unset | App Attest app ID for Watch-link verifier; required in production |
| `AED_WATCH_BUNDLE_VERSIONS` | unset | Exact comma-separated Watch CFBundleVersion allowlist; required in production |
| `AED_WATCH_ATTEST_ENVIRONMENT` | unset | Explicit `development` or `production` App Attest environment; required in production |
| `AED_WATCH_VALIDATION_CATEGORIES` | environment-dependent | Optional exact signing-category allowlist (`2` TestFlight, `3` development, `4` App Store); defaults to `3` for development attestation, `2,4` for production. A development-signed build using production attestations must explicitly select `3`. |
| `AED_OPERATOR_TOKEN` | unset | Optional out-of-band authorized-operator token |

For a deployment, generate this secret outside the repository (for example,
`openssl rand -base64 32`), store it in the deployment secret manager, and inject it
as `AED_AUTH_SUBJECT_PEPPER`. Do not paste it into source, fixtures, logs, or this
README.

Radius, freshness, accuracy and clock-skew defaults are development policy. Production
must configure them explicitly. Radius/freshness/accuracy boundaries are inclusive;
the deterministic distance calculation uses the contract earth radius `6371008.8 m`.

The Watch Fall endpoint accepts one app response after a Fall context. `NEEDS_HELP`
creates an event immediately. `NO_RESPONSE` requires a client-observed outgoing-call
state within 120 seconds of the Fall; the backend does not know a phone number,
connection state or message delivery. `DECLINED` is not a valid event report and is
rejected without creating an event. Every event is bound to the authenticated
triggering Watch, user and companion pair, and replaying its `eventId` is idempotent.

Watch fallback is direct and does not use server-issued authorization. A fallback request must come from
the bound triggering Watch, report that the Watch has network connectivity, and report
that the iPhone is not simultaneously `ACTIVATED + reachable`. The first valid sample
may be stored as a candidate; only after 10 seconds without a valid iPhone P does a
candidate become effective `WATCH_FALLBACK`. Newer valid iPhone P data immediately
restores `IPHONE_PRIMARY`, while older or queued Watch samples cannot displace it.
The backend records the latest Watch sample's cadence evidence (5-second normal
interval and 10-meter movement hint) without applying a generic location throttle.

Recruitment starts at a 1,000m ring after a valid patient P exists. If the unique
stable-user potential in the current ring is below three, the same transaction widens
to 1,500m and then 2,000m as needed. If potential is at least three but fewer than
three users have accepted after the persisted 30-second stage window, the next ring is
opened and its timer is reset; the event never shrinks. A user with a refused or
expired offer is not re-offered for that event, while a newly entering ring user with
no prior delivery receives one offer. `service.tick()` is the durable scheduler hook. The
local server starts a short, stoppable, non-reentrant tick driver while running; production
should replace that process-local driver with a persistent queue/scheduler and continue from
the stored stage timestamp. Event GETs also invoke the hook before returning truth.

Pending offers and their Socket notifications contain only generic event type, coarse
distance/ETA buckets, the current ring, positioning tier and server `expiresAt`;
they never contain patient coordinates, location card or trigger details. The offer is
valid through exactly 30.000 seconds and expires only after that boundary. Once a
responder accepts, its REST event projection may include the precise P and optional
location card needed for navigation; patient projections retain patient-only access.

SQLite stores each top-level entity independently inside one transaction. A device
row replaces its latest P/R sample; non-event standby/search-ring state has no
position history and expires after the configured 10-minute freshness window. Event
participant batches are stored separately as append-only evidence, including
`NO_NEW_FIX`; they never copy coordinates into the event timeline. Position and
presence idempotency receipts contain IDs/fingerprints/times rather than coordinates
and are bounded per device. On first SQLite startup, a valid legacy JSON file may be
imported; the source JSON is left untouched. Invalid legacy or SQLite truth fails
closed. The batch collection is an additive state collection, so existing v2.0
JSON/SQLite rows reopen with an empty active batch index without changing the storage
format version. Legacy event batches that cannot be assigned a truthful `slotAt` are
copied byte-for-byte as parsed JSON into the durable
`quarantinedLegacyEventPositionBatchesById` collection; business APIs never read that
quarantine or use it for latest-position state.

Accepted event participants also have immutable `participantIntervalsById` records. Position
evidence authorization uses these historical intervals, including their exclusive end time,
instead of mutable delivery or assignment status, so a valid pre-exit offline batch can be
appended after an acceptance is later revoked without reopening participation.
If that stable user becomes the patient of another event, the same transaction ends the old
responder interval with `PATIENT_PRIORITY` and sets the new patient event `createdAt` to exactly
the same instant. iOS may use that new event boundary when revocation makes the old event unreadable.

Cross-batch arrival order is not a continuity signal: offline historical batches may legitimately
arrive after newer batches. The service enforces one record per event/user/device/UTC-second and
never invents a missing record, but the current reference API has no client “stream fully synced”
signal. Consequently, final whole-window gap findings remain a future persistent audit/read-model
step after an explicit completion signal or retention cutoff; normal writes are not rejected for a
temporarily absent intermediate batch.

Client action timestamps are claims rather than authority. Response decisions and
status-confirmation answers reject claims that predate their request/prompt. Delivery receipts,
assignment progress, AED acquisition, and AED-unavailable reports likewise reject claims before
their current delivery/assignment state. Emergency-priority event end and responder exit do not
fail merely because the client clock is behind: their effective time is
`max(min(clientClaimedAt, serverReceivedAt), causalLowerBound)`. The completed-slot `425` gate
keeps every evidence lower bound at or before server receipt, so the clamp neither creates future
state nor lets a client clock extend a position-evidence window. Event REST
views expose only the authenticated device's own inclusive/exclusive evidence window as
`eventPositionParticipationStartedAt` and `eventPositionParticipationEndedAt`; both are null for
a device that never obtained position authority. Explicitly exited responders still receive no
event projection or event communication.

`GET /healthz` is an unauthenticated operational probe. The product API is rooted at
`/api/v2`; Socket.IO uses the default `/socket.io/` transport path.

## Windows development host (LAN-only tooling)

After `npm ci`, `npm test`, and `npm run build`, run the PowerShell scripts from an
elevated shell for the firewall step and a normal shell for lifecycle operations:

```powershell
$listenAddress = Read-Host 'Enter the Windows IPv4 address reachable by the iPhone'
$networkAdapter = Read-Host 'Enter the Windows network adapter alias'
.\scripts\ensure-windows-firewall.ps1 -HostAddress $listenAddress -InterfaceAlias $networkAdapter
.\scripts\start-windows.ps1 -HostAddress $listenAddress -Port 8787
.\scripts\status-windows.ps1
.\scripts\stop-windows.ps1
```

The firewall command must be run elevated. It is scoped to the explicitly selected
IPv4 address, adapter, TCP port, Private profile and `LocalSubnet` by default; use a
narrower `-RemoteAddress` when the test subnet is known. The lifecycle scripts save
the selected host/port under `.run/` so status checks do not assume port 8787 or a
Tailscale address. To survive an OpenSSH session closing, the process runs through the on-demand
`AEDResponseBackend-v2-Development` scheduled task. The task has no trigger and is not
configured to start at boot or logon.

These scripts are retained for local diagnostics only. They do not implement or satisfy
the production cellular/WAN requirement and must not be used to publish raw Node.js port
`8787` to the Internet.

The production write paths are:

- `PUT /api/v2/me/presence` for availability and capabilities;
- `PUT /api/v2/me/responder-position` for neutral/responder R;
- `PUT /api/v2/events/{eventId}/patient-position` as a latest-only compatibility path for old
  clients; the production iPhone uses event position batches and does not dual-write it;
- `PUT /api/v2/events/{eventId}/position-batches/{batchId}` for the patient source or an iPhone
  with an immutable accepted-participant interval (pre-end evidence may arrive after termination);
  each batch has 1–5 unique UTC-second slots; `FIX` requires an in-slot `fixObservedAt`, while
  `NO_NEW_FIX` requires `gapReason=NO_FIX|APP_NOT_RUNNING`. Slots inside a batch must be consecutive.
  A new batch is persisted only when its final slot has fully elapsed at server receipt time;
  otherwise it returns retryable `425 Too Early` without storing any record. This prevents a
  fast-clock/future evidence record from blocking an emergency-priority event end.
  The client permanently seals record content when it first submits the batch, then may only retry
  the identical batch until ACK; ACK permits deleting the local retry copy but is not the seal point.
  If a later authoritative participation boundary rejects an unacknowledged mixed transport batch,
  the client may regroup only its unchanged legal records (same record IDs and payloads) and must
  retain every excluded record in append-only quarantine; this is transport recovery, not correction.
  Early partial batches seal only their submitted slots, and there is no server-side
  correction/replacement endpoint;
- `POST /api/v2/events/{eventId}/end` for the patient's single confirmed end action;
- `POST /api/v2/events/{eventId}/status-confirmation` for a patient `CONTINUE` response;
- `POST /api/v2/events/{eventId}/exit` for an accepted responder's explicit exit;
- `PUT /api/v2/watch/events/{eventId}/fallback-position/{positionUpdateId}` for a
  direct, network-available Watch fallback P sample.

Socket.IO carries low-latency offers and coordination hints. On every connection or
reconnection, clients must restore event/assignment/timeline truth through REST before
resuming position writes.

## Transport and abuse boundaries

Every non-media REST JSON body is limited to 16,384 raw UTF-8 bytes. A body of exactly
16,384 bytes is parsed normally; a larger body returns `413 Payload too large` with
problem type `https://aedresponse.invalid/problems/payload-too-large`. Socket.IO uses
the same 16,384-byte packet limit and is notification-only: clients must not send a
`delivery:receipt` write event. Delivery receipts are written through the REST receipt
endpoint above.

Position writes are not normally rate-limited. If one authenticated device exceeds
five position writes in each second for ten consecutive seconds, its position writes
enter a 30-second degraded window; at most one position write per second is accepted
for that device and the others return `429`. Other event actions, including response,
exit/resolution and AED actions, are not covered by this circuit. A position batch is
one REST write and may contain at most five records; six records return `422` before
any record is persisted. The circuit is an in-memory abuse control and does not
invent background 1 Hz samples.


### 架构整改的本地验证

从仓库根目录运行 `python3 ios/scripts/run_architecture_repair_checks.py --output <仓库外的新目录>`，使用本机Swift/Node和已安装依赖，生成13个组件测试及两阶段真实REST/SQLite链验证；只启动loopback测试后端，包含一次进程重启，不操作设备或生产服务。外部AppAttest与位置输入使用明确夹具，不代表真实供应商或后台能力。生成的凭据/数据库仅存私有证据目录，不能加入Git。

在backend目录运行 `node --import tsx test/architecture-repair-native/state-cost.mts`，对相同实体交替测旧全状态read和新entity read，并保留空事务成本/SQLite重开校验。它只创建临时合成库，不是目标负载验收。D1仅迁移认证、现有Socket授权及Watch恢复读取，其他读取、启动加载和写事务成本仍未整改完成。


### 手机 MapKit 算路与双地图导航（2026-10-08）

最新用户决定：统一由 iPhone MapKit 获取 `R→A`、`A→P` 两段步行距离，后端确认分配；导航检测 `iosamap`，已安装高德则优先打开高德，否则打开 Apple 地图，高德唤起失败也回退 Apple。无需地图 Web API Key。导航按“先取 AED、领取后去患者”的任务阶段切换；新 MapKit 结果没有高德转换点时，使用单一当前目标和 `dev=1`，不把 WGS-84 作为高德 GCJ-02 途经点。

服务端部署配置 `AED_NAVIGATION_MODE=CLIENT_MAPKIT`；开发入口默认此模式，生产仍要求显式配置。`CLIENT_APPLE_MAPS` 只保留为旧几何夹具模式；`SERVER_AMAP` 为显式可选旧服务端方案，本轮不启用且不需要它的 Key。手机的 CLLocation/任务路径保持 WGS-84。

志愿者接受后先取得服务端任务，再用 `GET /events/{eventId}/aed-route-calculation` 获取 60 秒有效的计算上下文。上下文绑定事件/设备、位置及 AED 元数据，每轮至多八个候选，按两段直线距离下界预筛并保留原目标。手机最多同时查两段 MapKit 步行路线，分别取返回方案中的最短距离，PUT 上报 `{calculationId, routes:[{aedId,toAedMeters,toPatientMeters}]}`。不上传客户端选择的角色或任务。候选中算不出的路线不会用几何距离冒充；不宣称全库全局最短。

后端重新检查接受资格、事件/任务状态、位置新鲜度、患者位置相同、响应者位移 ≤25 m、候选未被替换/停用、占用和唯一分配；对距离执行有限值/边界及直线下界（允许端点吸附 50 m）校验。结果标为 `CLIENT_MAPKIT`：距离来自客户端申报，后端没有独立的 Apple 路线真实性证明。提交成功后只采用服务端返回的任务；在途任务不因提交结果静默改道，仍走已有 15 秒改派确认。

计算上下文与报价是有界内存缓存，不增加数据库表；重启/过期/输入变化需重新计算。手机界面可见时每 30 秒尝试更新；连接变化、退出或旧回调不得覆盖新任务；离线 TestHost 默认不调用地图网络。旧 ETA 记录兼容读取而不转换为米，旧 ETA 改派不再接受。新后端字段需和新客户端配套更新。

手机需要联网才能完成 MapKit 查询；地图限流/失败时保留当前服务端任务并显示可重试状态。手机是否装高德只影响导航入口，不影响算路服务。真实 iPhone 上的地图请求、已安装/未安装高德的唤起，以及步行路线可达性仍需分别验收。本轮不部署、不安装设备、不修改服务端数据。

参考：[Apple MKDirections](https://developer.apple.com/documentation/mapkit/mkdirections)、[高德 iOS 安装检测](https://developer.amap.com/api/amap-mobile/guide/ios/ios-uri-information)。

### 指定Apple设备的双机测试
仅私有 `AED_SIMULATION_ADMIN_SOCKET` 可配置 `AED_SIMULATION_APPLE_DEVICE_IDS`（恰好两个不同UUID，保留已存标识大小写）。这允许指定Apple设备使用明确标记的SIMULATED_TEST，不开启受控账号签发，也不跳过定位、协议与受众校验。测试后移除这两项临时配置。VIEWED是客户端回执，不是用户实际看见的证明。
