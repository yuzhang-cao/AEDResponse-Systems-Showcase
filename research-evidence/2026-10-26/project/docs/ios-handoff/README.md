# iOS/watchOS v2 交接索引

此目录保留早期 iOS 交接背景，但开发与验收只能使用当前 v2 canonical 文档：

- `docs/requirements.md`
- `docs/architecture.md`
- `contracts/openapi.yaml`
- `contracts/events.md`
- `ios/ARCHITECTURE.md`
- `ios/VALIDATION.md`

## 历史约束（已废弃）

- 以下列表仅描述早期零登录提案，不再是 v2 约束。当前生产 App 必须先通过手机号验证码或 Sign in with Apple 登录，再完成四项同意和权限门禁。
- 用户不手动选择角色。本人 Watch 事件使设备成为患者；附近设备收到响应请求，明确接受后才成为响应者。患者身份优先。
- Watch 仅监控 Fall Detection 与 Watch 上可观察到的系统外拨，满足严格双信号后直接上报后端；Watch 不拨号、不分配任务。
- iPhone 只消费后端业务事件；没有手动 SOS、App 自建误报倒计时或生产模拟穿戴入口。
- 任务仅有 `GO_TO_PATIENT` 与 `FETCH_AED`；AED 路径严格为 `R → A → P`，获取后提交幂等 `AED_ACQUIRED`。
- Simulator/模拟 port 只验证确定性逻辑。签名、Fall Detection entitlement、真机授权和真实 Emergency SOS 可观测性必须分别记录，不能互相替代。

`0002-no-user-login-proposal.md` 与同名历史副本已于 2026-09-05 被新身份规则取代，只作为已废弃决策记录保留。
