# Watch / iPhone relay protocol: immediate RPC and background delivery

The 2026-09-26 user-selected primary path is Watch → paired iPhone → server.
Watch direct HTTPS remains a separately authorized fallback. This supersedes the
older restriction that WCSession may carry only an App Attest ticket. It does not
waive direct-Watch App Attest checks or issue a Watch bearer through the phone.

## Clarified requirement: continuous companion service

On 2026-09-26, the user clarified that opening either app must not be a prerequisite
for continued companion service while the physical devices remain connected by
the system. Backgrounding, screen sleep and iPhone lock must not by themselves
tear down the business relationship or require manually reopening the apps to
restore message delivery. This is a transport/lifecycle requirement, not permission
to leave a green connection label on an unverified or failed channel.

The background/lifecycle changes below implement this requirement at the source
level. **Physical background scheduling and long-duration acceptance remain
separate gates**, not implied by compilation or local protocol tests:

- `isReachable` and a 25/30-second ping lifetime describe live messaging, not
  the enduring paired-app relationship. `isPaired` alone also does not prove that
  the counterpart is powered on or currently communicating.
- Immediate RPC needs a system-managed background delivery path, durable retry
  and final business ACK handling. The existing Watch outbox must remain
  source-bound; OS transfer completion must not erase unacknowledged facts.
- Stable binding identity, consent/monitoring eligibility and short-lived upload
  credentials need separate lifecycle handling. Expiry/recovery must not be
  mistaken for explicit unlink/revocation. This does not authorize accepting an
  expired bearer, bypassing App Attest or ignoring logout/revocation.
- Automatic renewal and recovery must work without requiring either app's UI to
  be foreground. Background launch, persisted state recovery and queued delivery
  need explicit handlers and real-device acceptance, not an in-process timer.

Apple's background transfers can continue after submission when an app is
suspended; that is not a promise of permanent process execution or bounded,
zero-delay delivery. The system's scheduling limitations must be stated and
tested rather than silently replacing the user's stronger requirement with
"it worked once with Watch in the foreground". See Apple's
[transferUserInfo](https://developer.apple.com/documentation/watchconnectivity/wcsession/transferuserinfo(_:))
and [isReachable](https://developer.apple.com/documentation/watchconnectivity/wcsession/isreachable).

Future acceptance must include both apps backgrounded, iPhone locked, ordinary
screen sleep, automatic recovery across a phone-session expiry and recovery after
temporary device unreachability. Use non-emergency messages and preserve the
existing prohibition on real Fall Detection/SOS/rescue-event tests. A source
change/build or the earlier foreground handshake does not close these gates.

## Binding and connection lifecycle

- Both native apps use their OS-paired WCSession. The iPhone activates business
  handlers only after account login and the existing agreement/permission gates.
- The Watch requests `context`, derives its existing per-pair device identity,
  then requests `bind`. The phone calls `POST /me/watch-relay/bindings` using its
  own device session. The strict body is `{deviceInstanceId, companionPairId}`.
- The server returns `{bindingId,iPhoneDeviceId,deviceInstanceId,companionPairId,
  userId,accountId,expiresAt}`. IDs are UUIDs except the opaque user/account IDs;
  expiry is an ISO-8601 timestamp bounded by the authenticated phone session.
  It is an upload lease, not the lifetime of the persisted paired identity.
  Reconnecting the same phone/watch/account keeps the binding ID. A revoked Watch
  cannot implicitly rebind, and another phone/account cannot take the identity.
- The Watch stores this metadata in its device-only protected Keychain and
  atomically updates its active configuration. No phone bearer crosses WCSession.
- Before a relayed operation, the phone restores/renews a missing or expiring
  cached lease using its current authenticated session. The returned reference,
  phone, pair and user must still match. The server continues to reject expired
  credentials and leases; no expired bearer becomes usable through this change.
- `ping` echoes the exact binding reference and request UUID. A recent matching
  response confirms live messaging; `isReachable` alone does not. The 25/30-second
  live-indicator window does not erase the binding or stop monitoring. A separately
  configured and verified background path is shown as “后台连接”, not as evidence
  of an instantaneous response or proof that the remote device has power.
- Temporary disconnection retains the binding and source-bound unacknowledged
  facts. Login, account switch, expired session and explicit revocation remain
  separate from transport reachability. Messages for an obsolete phone/account
  generation cannot acknowledge the current queue.

## WCSession envelope

The property-list request contains exactly `protocol="aedresponse-relay-1"`,
`requestId` (fresh UUID), `method`, and `payload` (JSON Data, at most 12,288 bytes).
Methods are `context`, `bind`, `ping`, `observation`, `eventState`, `fallbackTicket`.
A reply contains exactly `requestId`, `status`, and `payload`; the request ID must
match. The adapter times out after 12 seconds and resumes its caller only once.
Unrecognized/oversized envelopes are rejected at creation and decoding. Status is
`ok`, `unavailable`, `authorizationRequired`, `invalidRequest`, `bindingMismatch`,
or `serverRejected` (optional HTTP status). `unavailable`/network failure does not
revoke a grant. Explicit authorization loss, owner mismatch or server 403 suspends
the grant persistently; same-owner reauthorization advances the revision so
previously blocked facts resume without being rewritten.

`observation` carries `{binding,observationData,digest}`. `binding` contains the
Watch ID, pair ID and relay binding ID; `observationData` is the exact encoded
WatchEmergencyObservation and `digest` is its SHA-256 hex digest. The iPhone
validates it and forwards the **original bytes**, not a reconstructed observation.
Neither phone location nor phone CallKit can synthesize/replace its fields.

## Durable background extension

- `transferUserInfo` carries a single-key wrapper: `relayRequest` with the strict
  RPC request, or `relayReply` with its correlated response. `fallbackTicket` is
  never eligible: raw App Attest tickets/account tokens do not enter this mailbox.
- Watch persists an operation before submitting it. Retries/restarts reuse the
  original request UUID for the same method and canonical payload. An observation
  is submitted to the system queue before attempting its immediate fast path;
  background handlers also queue before waiting on live replies. Queueing is not
  a success ACK and cannot remove the original Watch event outbox entry.
- iPhone persists the incoming request before consuming it, rechecks account and
  permissions, restores the lease and forwards the original bytes. Its reply is
  persisted before enqueueing; transport errors/5xx leave the request pending.
  Watch accepts replies only for known original requests. Final observation ACK
  still requires matching server event ID and content digest.
- The protected, atomic mailbox has 128 incoming and 128 outgoing transaction
  slots. Corrupt/unreadable storage and overflow fail closed without truncating
  facts; write failure is not shown as a ready background queue. Device-local
  protected files are excluded from backup. OS transfer completion can retire a
  phone reply copy, but never the Watch's unacknowledged event fact.
- `updateApplicationContext` carries `relayControl`: installation ID, monotonically
  increasing revision, opaque owner hash and explicit authorization availability.
  Owner/authorization changes retire obsolete transport transactions and grant
  replies, not original event evidence. Older revisions cannot undo logout. The
  owner binds user, phone and pair; backend authorization is still authoritative.
- AppDelegate initializes the phone receiver without a visible scene. watchOS
  connectivity background tasks track callbacks through completion; queued
  results trigger recovery without a foreground transition. iPhone also registers
  a network-required BGProcessing retry for its durable inbox; this is an
  OS-scheduled opportunity, not a periodic or latency guarantee.
- Cold-start account restore retains credentials and retries transport/5xx errors;
  definitive 401/403 still invalidates authentication. A rotated credential that
  cannot immediately be persisted is retried locally rather than refreshing the
  already-rotated old token again. Generation guards reject late completion after
  logout/account switching. Clock rollback does not freeze queue retry.

## Server routes and final ACK

- `POST /me/watch-relay/bindings`: 200 for a validated phone-owned binding.
- `PUT /me/watch-relay/{watchId}/{bindingId}/emergency-observations/{eventId}`:
  same strict WatchEmergencyObservation and event response as the direct route;
  201 for creation, 200 for identical replay, 409 for changed contents.
- `GET /me/watch-relay/{watchId}/{bindingId}/events/{eventId}/state`: restricted
  WatchEventState projection for an event created by that same Watch.

Every route requires the iPhone device bearer, current user/account, the correct
phone/watch/pair/binding, current agreements and an unexpired, unrevoked binding.
Event creation rechecks authorization **inside the transaction** so revocation
while a request is queued cannot create an event. The direct `/watch/*` routes
continue rejecting iPhone bearers.

The phone returns `{eventId,digest}` only after a matching successful REST ACK.
A local WCSession receipt is NOT a server ACK. The Watch's existing
protected outbox retains ownership of retries; no success is claimed when the
phone suspends/dies or the reply times out. Main/fallback use the same original
event ID and source fingerprint, and converge on existing server idempotency.

The relay trusts the signed-in **phone's delegation over OS-paired WCSession**;
this is not independent cryptographic App Attest evidence about the Watch.
The independent fallback is provisioned separately via a transient ticket and
the unchanged App Attest verifier. A failed fallback proof cannot clear an
otherwise valid phone relay, and must not be presented as a working backup.

## Validation boundary

Unit/HTTP fixtures run against in-memory/local services only. Real devices use
non-emergency handshake/ping messages for verification; do not synthesize Fall
Detection, Emergency SOS or a public rescue event to demonstrate connectivity.
# 受控 Watch 模拟扩展（2026-09-27）

只有显式 `DEBUG && AED_WATCH_SIMULATION` 构建使用模拟 Fall/Call 输入；普通 Debug 默认和 Release 不展示入口。复用真实协调器、同一 WCSession mailbox、原始字节摘要与服务器 ACK，但测试上下文、outbox、fallback 文件各自隔离。测试版不启用系统跌倒/外拨监视器，不调用 SOS，不允许直接 WAN 上报。

2026-09-27用户进一步明确测试入口为**一键上报**：点“模拟跌倒”直接发送，无二次“是否需要帮助”。测试适配器提供完整的合成 `NEEDS_HELP` 场景并复用协调器；这个字段是模拟输入，不声称用户实际回答过问题。正式系统跌倒的询问逻辑不变。测试按钮直到本次异步提交结束才重新启用，重复事件仍由现有幂等规则处理。

受限 RPC 增加 `simulationContext` 与 `simulationObservation`，分别对应认证 GET `/me/watch-relay/{watchId}/{bindingId}/simulation` 和 PUT `.../simulation/emergency-observations/{eventId}`。403 关闭测试许可不等于撤销正常绑定；真实绑定撤销仍按原规则处理。测试事件状态也只经 iPhone 查询。

服务端 `AED_WATCH_SIMULATION_RUN` 明确指定 UUID runId、起止时间（最多90分钟）、一个手机、一个 Watch、两个独立受控响应者；必须同时启用 private simulation IPC 与受控账号。未配置、过期、异身份、绑定失效均拒绝。入队事务再次校验相同授权与身份，已启用测试的 Watch 普通未标记上报被拒绝。

模拟事件根观察为 `SIMULATED_TEST`，原始观察仅嵌套于 `syntheticWatch.observation`，不将模拟信号宣称为真实系统 Fall。正常招募/可见性/任务/AED 规则再叠加精确四设备白名单；私人管理 IPC 只能注册两名测试账号，不能伪造 Watch 起点。N=2 验证两类任务，响应者定位和行走均为受控客户端合成，不算第二部真机或真实步行验收。

测试结束撤下服务器许可和设备测试版，保留模拟审计记录。产生新观察格式后不可直接回退至不识别该格式的旧解析器；保留兼容解析代码、关闭许可即可，不删除或改写事件事实。
