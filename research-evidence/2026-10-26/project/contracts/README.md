# AEDResponse 平台中立契约 v2

`contracts/` 是 iOS、watchOS、Android 与后端共同遵守的唯一协议来源。

- [Watch/iPhone 中转契约](watch-relay.md)：主链路为 Watch→iPhone→服务器，即时 RPC 与系统后台队列并行；持久绑定不因退后台或上传租期到期而解除，实际消息仍以最终业务回执确认。独立直传授权作为备用单独检查，取代旧“WCSession 仅传 ticket”的限制。

- `openapi.yaml`：REST API v2.1；手机号/Apple 登录、账户/设备 session、认证 Watch 触发/直接 fallback、iPhone P/R 位置、事件参与者位置批次、presence 和状态消费通过后端隔离。事件批次采用严格 UTC 整秒 `slotAt`，FIX 的 `fixObservedAt` 必须落在该秒内，缺口必须声明原因。
- `events.md`：Socket.IO v2 服务端通知、Watch fallback 来源仲裁、coordination revision、终态同步和 REST 对账规则。
- `safety.json`：禁止自动呼叫、手动 SOS和生产模拟入口等硬边界。
- `positioning-policy.schema.json`：1/1.5/2 公里动态招募半径、时效、精度、客户端时钟容差、10 秒 Watch fallback 晋级门槛、5 秒/10 米 cadence 常量。
- `fixtures/demo-scenario.json`：P/R/A、Watch 观察、iPhone P/R 更新、位置边界、N=1...5 分配和 AED 回执夹具。

生产契约通过公网 HTTPS REST + WSS Socket.IO 使用，必须允许 iPhone 仅靠蜂窝数据接入；loopback/私网 HTTP 仅用于开发，不构成广域网验收证据。Windows 原始 Node.js 端口不得直接裸露公网。

v2 对 v1 不兼容：账号仅允许手机号验证码或 Sign in with Apple；删除密码/游客/匿名登录、客户端手动事件创建、旧误报倒计时、duty、手动角色和 `GUIDE_AMBULANCE`。客户端不得为兼容旧服务端偷偷恢复这些入口。

2026-09-08 用户批准的测试期例外：可在明确启用的开发服务器本地签发受控账号，
仅替代首次身份建立。会话响应以 `CONTROLLED_TEST` 显式标识，其他鉴权、协议、
设备绑定和业务接口规则不变；不增加公共注册/登录方式，正式登录仍只允许
PHONE/APPLE。详见 `docs/controlled-account-position-validation-2026-09-08.md`。

## Device identity during account switching

`POST /api/v2/session/bootstrap` returns HTTP 403 with problem type
`https://aedresponse.invalid/problems/device-account-binding-conflict` when a
registered device belongs to another authenticated account. Status, title and
English detail remain compatible; the problem type is the new machine-readable
contract. No device, pair, participant or historical fact changes on rejection.
Other account, scope, pair and device-kind errors must not trigger identity migration.

During rollout iPhone also recognizes the old generic `/problems/403` type only
with the exact legacy binding-conflict detail. After all supported server versions
emit the dedicated type, remove that compatibility branch as a separate change.
A rejected account may use its own stable local device/pair namespace, preserving
the legacy owner's IDs and durable history. This does not transfer Watch identity,
change participation rules, or authorize uploading another context's facts.

### Watch account recovery

A same-issuer companion ticket may establish a separate Watch device identity for
its pair after App Attest and server verification. The original device binding is
never reassigned. Returning to an earlier pair reuses its local device identity;
source-bound pending facts remain unchanged and may only drain under their original
source binding. The iPhone envelope still carries no bearer or user identity.
Cross-issuer rebinding is not enabled. Candidate configuration must not become
active before a successful redeem; failed verification retains the prior configuration.

### Logout acknowledgement replay

POST auth/logout may acknowledge a stored explicit logout completion with 204 even
though that bearer no longer authenticates on any business endpoint. The marker and
revocation effects commit together. Expired/rotated credentials without a marker,
unknown credentials, and sessions removed by normal cleanup remain 401. This does
not extend retention or allow expired credentials to revoke newly linked devices.
The client keeps such unresolved records rather than treating 401 as successful logout.

### Reauthentication after unresolved logout (user confirmed 2026-09-11)

A 401 on logout transitions the protected pending record to requiresReauthentication,
not success. The client stops sending that old bearer. On login to the original
issuer/user, auth/logout/recover uses the fresh account bearer and immutable prior
logout boundary/device metadata. Server ownership checks and the cutoff preserve
new login/Watch bindings. A 204 alone permits local ACK removal. Unknown-owner or
missing-boundary legacy records are retained for explicit migration, never guessed.
