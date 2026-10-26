# AEDResponse v2

2026-10-08 路线选择更新：统一由手机 MapKit 计算 `当前位置 → AED → 患者` 的两段步行距离，后端确认分配；导航优先已安装的高德，未安装或唤起失败则使用 Apple 地图。无需地图 Web API Key。配置与验证边界见 [后端说明](backend/README.md)。此决定覆盖旧 ETA/高德默认算路方案。

AEDResponse 是一个 iPhone + Apple Watch 的 AED 志愿协同毕业设计项目。v2 的唯一生产跌倒信号来自 Apple Watch 系统 Fall Detection：用户在 App 自有询问中选择“需要帮助”时立即成立事件；未回答时，只有在 120 秒内观察到新的外拨状态才成立。App 本身不发起紧急呼叫。不提供或替代公共急救调度服务；本系统会依据跌倒相关求助信号，组织附近志愿者前往并协调 AED 取用，不判断患者是否心脏骤停或是否需要电击。

## v2 产品边界

- 2026-09-26 持续互联要求：Watch→iPhone→服务器为主链路，独立授权的 Watch 直传为备用。即时通道不可达时使用系统后台投递与持久重试，退后台/锁屏/短期上传凭证过期不等于解绑；不得要求用户反复打开两端 App 才恢复业务。绑定、监控许可、上传租期与即时可达性分开管理；只有最终服务器 ACK 才清理事件记录。实现与系统调度边界见 [中转契约](contracts/watch-relay.md)，真机后台验收不能由构建或一次前台成功替代。

- 用户必须先通过Sign in with Apple 登录，再分别签署患者协议、志愿响应者协议、隐私政策与敏感个人信息单独同意，随后取得 Always + 精确定位和通知权限。全部门禁通过前不启动任何业务能力；后端会话绑定稳定 `userId`，且保持限权、短期、可撤销和可轮换。
- 用户平时为中立待命。本人 Watch 触发后，iPhone 自动进入患者状态；附近用户只收到可接受/拒绝的响应请求，接受后才成为有效响应者。患者状态始终优先。
- Watch 监控 `CMFallDetectionManager`、App 自有帮助回答与可观察外拨状态；“需要帮助”立即成立事件，“不需要帮助”取消，未回答时只有 120 秒内的 outgoing observation 才成立。iPhone 不处于 `ACTIVATED + reachable`、或后端已确认连续 10 秒无有效 iPhone P 时，Watch 只要有 WAN 就立即直传备份 P，此后 5 秒或移动 10 米；后端连续 10 秒无 iPhone P 后才采用。Watch 不拨号、不分配响应者、不编排 AED。
- iPhone 不使用 `CMFallDetectionManager` 或 iPhone CallKit 触发事件，只消费后端状态并展示患者/响应者、地图、导航、任务和 AED 协同。
- iPhone 是手机位置的网络上报端：中立/响应者持续上报 `ResponderPosition (R)`，患者激活后立即切换为与事件绑定的 `PatientPosition (P)`；任一仍通过服务端有效性校验的 iPhone P 请求都会用已保存的最新 iPhone fix 恢复主来源，较旧请求不会倒退坐标，同时间或更旧的 Watch fallback 不能覆盖。生产业务数据必须通过公网可达的 HTTPS REST + WSS Socket.IO 传输，支持蜂窝数据和任意外部 Wi-Fi，不要求 iPhone 与 Windows 位于同一局域网或加入 Tailscale。
- 当前本地参考后端以 SQLite 保存账号关联设备、最新位置、capability、可参与状态和当前事件/任务；中国大陆生产目标为 PostgreSQL + PostGIS、Redis 兼容缓存和持久队列，并执行已冻结的分层留存与访问审计。
- Windows 只保留为本地开发、真机联调和压测控制端，不是生产源站；Node.js 监听端口不得直接裸露到公网。中国大陆正式生产仍要求经审核的 TLS/WAF 入口与数据层。2026-09-08 已按用户授权配置 Azure Japan East 开发/联调 VM，可信 HTTPS/WSS 入口与状态见 [Azure 部署说明](backend/deploy/azure/README.md)；真实身份验证器与双机业务验收尚未完成。
- append-only timeline 仅作为后端/客户端内部对账与审计数据，不向患者或响应者展示。
- 没有手动 SOS、App 自建误报倒计时、手动角色选择、固定第一/第二/第三人分工、`GUIDE_AMBULANCE` 或面向用户的模拟穿戴入口。
- 独立 `AEDResponseTestHost` Debug 提供强制离线的本地患者/响应者 UI 预览；该入口不存在于生产 target 或 Release。
- 响应任务只允许 `GO_TO_PATIENT` 和 `FETCH_AED`。AED 路径严格为 `R → A → P`，获取后必须提交幂等 `AED_ACQUIRED` 回执。
- Fall Detection 后 App 单次询问是否需要帮助：“需要”立即创建事件，“不需要”不创建；未回答时只有 120 秒内观察到外拨才创建 `ACTIVE/RECRUITING`，且不等待接通、不检查号码或通话时长。
- Watch 恢复、心率恢复、电话结束或失联都不会自动结束事件。误报和真实事件结束都要求明确的人为操作或授权后台流程。

## 公开 API 证据边界

`CXCallObserver` 不提供号码、系统权威拨号开始时间或累计通话时长，Apple 也未保证 Emergency SOS 一定稳定暴露为 `CXCall`。因此 `callFirstObservedAt` 只表示本 App 首次观察到外拨状态的时间。generic device 构建只证明源码可编译；真实 Emergency SOS 可观测性、Fall Detection entitlement、签名和真机行为必须在物理设备上分别实测。

## 文档与工程

- [需求与验收](docs/requirements.md)
- [架构与状态机](docs/architecture.md)
- [实际运行流程与技术架构](docs/runtime-flow.md)
- [REST 契约](contracts/openapi.yaml)
- [实时事件契约](contracts/events.md)
- [后端实现与 Windows/受控网络运行说明](backend/README.md)
- [iOS/watchOS 架构](ios/ARCHITECTURE.md)
- [iOS/watchOS 构建说明](ios/README.md)

`contracts/` 是跨平台协议的唯一来源。`backend/` 是当前 Node.js/TypeScript
参考实现；现有直连脚本只用于本地/受控开发，不能作为生产公网方案。生产客户端使用可配置域名访问公网 HTTPS/WSS 入口，不硬编码个人 IP。它不是公共紧急调度服务。
v2 是对 v1 的不兼容升级。
