# Mac Codex iOS 开发工作包

此目录是交接说明，不包含 iOS 平台代码。Mac Codex 必须自行完成 iOS 客户端的实现、构建、签名与测试。

## 首次执行清单

1. 只读核验 macOS、Xcode、可用 Simulator、真机、签名 Team、CocoaPods/SwiftPM 和 Node 版本。
2. 在 Mac 专属分支 `codex/ios-mvp` 或独立 iOS 仓库创建工程；不要修改 `android-app/`。
3. 读取 `contracts/openapi.yaml`、`contracts/events.md`、`contracts/fixtures/` 和 `docs/requirements.md`。
4. 实现患者/响应者双角色、20 秒误报取消、本地声音/震动/闪屏、位置卡朗读、安全拨号器、AED 路线与时间线。
5. 使用契约测试夹具验证 `P/R/A` 类型、状态机、回执顺序和禁止紧急号码。
6. 由 Mac Codex 独立记录 Xcode build、Simulator/真机测试及签名结果。

## 不可违反的边界

- 只允许安全测试号码，绝不自动呼叫。
- 不实现医学诊断，不接真实急救调度，不提供公众注册。
- 模拟穿戴事件必须清晰标注为模拟。
- iOS 工程所有权、签名材料和构建日志留在 Mac 侧，不由 Windows 任务代写或代验。

## 联调入口

- REST：以 `contracts/openapi.yaml` 为准。
- 实时事件：以 `contracts/events.md` 为准。
- 默认本地 API：`http://127.0.0.1:8787`；跨设备联调时由用户明确指定 Tailscale 地址和允许范围。

