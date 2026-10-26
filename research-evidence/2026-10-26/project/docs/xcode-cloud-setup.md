# Xcode Cloud 接入清单

状态：2026-09-11 编写。本文是本仓库接入 Xcode Cloud 的操作手册。
配套的本地冒烟套件见 [`smoke-testing.md`](smoke-testing.md)。

## 0. 为什么需要这份清单

Xcode Cloud **没有可自动化的开通入口**：产品（app 记录）、仓库授权、workflow
都只能在 Xcode GUI 或 App Store Connect 网页里创建，ASC API Key 只能查询不能建。
所以下面标「你」的步骤必须人工完成；标「已验证」的状态是 2026-09-11 实测结果。

### 已就绪（2026-09-11 实测）

| 项 | 状态 |
| --- | --- |
| Apple ID 登录 Xcode | ✅ `[REDACTED_EMAIL]`（账号 UUID `EEA6A11E-…`，见 `IDEProvisioningTeamByIdentifier`） |
| 付费会员资格 | ✅ `isFreeProvisioningTeam = 0`，Individual team `GR6YBCDW7R`，profile 有效期至 2027-09 |
| Xcode 版本 | ✅ 26.6（Xcode Cloud 要求 15.0+） |
| 代码托管 | ✅ GitHub `yuzhang-cao/-`（private），分支 `codex/architecture-repair-20260909` @ `aaa73b3` |
| 共享 scheme | ✅ `AEDResponseUnitTests` / `AEDResponseWatch` / `AEDResponse` / `AEDResponseTestHost` / `AEDResponseControlledTests` |
| 工程自洽性 | ✅ 97 个 Swift 源文件、工程引用 96（唯一排除项 `SocketIOEventStream 2.swift` 是有意的） |
| SwiftPM 可复现 | ✅ `Package.resolved` 已提交（socket.io-client-swift 16.1.1、Starscream 4.0.8） |
| 云端路径预演 | ✅ 在 `c050a4a` 的干净克隆 + 全量工作树改动 + 空 `SourcePackages` 下，联网解析包后 `** TEST BUILD SUCCEEDED **` |
| 费用 | 会员内含 25 计算小时/月，开通不额外收费；除非主动订阅更大档位（100h US$49.99 等） |

### 未就绪

| 项 | 状态 |
| --- | --- |
| App Store Connect 应用记录 | ❌ 不存在（`ZPRODUCTENTITY` 0 行） |
| Xcode Cloud workflow | ❌ 不存在（`ZWORKFLOWSUMMARYENTITY` 0 行） |
| GitHub 仓库授权给 Xcode Cloud | ❌ 未授权（`IDESourceControlHostAccounts` 为空） |
| Watch App 的 `health.fall-detection` entitlement | ❌ Apple 未批准，**首次不要建 Watch workflow** |

## 1. 创建 App Store Connect 应用记录（你）

登录 <https://appstoreconnect.apple.com>，用与 Xcode 相同的账号
`[REDACTED_EMAIL]`。左侧 **My Apps → ＋ → New App**。

| 字段 | 填什么 |
| --- | --- |
| Platform | **iOS** |
| Name | `AEDResponse`（重名就加后缀） |
| Primary Language | Chinese (Simplified) |
| Bundle ID | **`dev.codex.aedresponse`** |
| SKU | `AEDRESPONSE001`（内部编号，创建后不可改） |
| User Access | Full Access |

如果 Bundle ID 下拉为空，先去
<https://developer.apple.com/account/resources/identifiers> → ＋ → App IDs → App
注册 `dev.codex.aedresponse`，Capabilities 只勾 **Sign in with Apple**，
**不要勾 HealthKit / Fall Detection**（未获批，勾了会在签名阶段失败）。

> **Watch App 先不建。** 它的 entitlement 里有 `com.apple.developer.health.fall-detection`，
> 该权限 Apple 至今未批；Xcode Cloud 配置签名时会卡死在这里。等到批复后再注册
> `dev.codex.aedresponse.watchkitapp` 并加 Watch App 版本。

## 2. 把仓库授权给 Xcode Cloud（你）

Xcode 打开 `ios/AEDResponse.xcodeproj` → **Report Navigator（⌘9）→ Cloud 标签 →
Get Started** → 选 GitHub → 浏览器里授权 Xcode Cloud 的 GitHub App 访问
`yuzhang-cao/-`。这是 Apple 侧的授权，与本机 `gh` 的 token 无关。

## 3. 建 workflow（你）

**Product → Xcode Cloud → Manage Workflows → ＋**（或继续 Get Started 引导）：

| 配置项 | 选什么 | 理由 |
| --- | --- | --- |
| Name | `iOS Smoke` | |
| Xcode Version | Latest Release | 工程要求 Xcode 26+ |
| macOS Version | Latest | |
| Environment Variables | **一个都不加** | 加了 `AED_LIVE_TEST_ORIGIN` 会让 `LiveAzureTransportTests` 去打真实 Azure |
| Start Condition | **Manual** | 第一次手动点，确认链路通了再挂自动触发 |
| Branch | **`codex/architecture-repair-20260909`** | 代码在这个分支，不是默认的 `codex/ios-mvp` |
| Actions | 1 个 **Test - iOS** | |
| └ Scheme | `AEDResponseUnitTests` | TestAction 只含 `AEDResponseTests`，不会拉 UITests |
| └ Tests | 留空 = 全量 | 想先跑快的：Only Test 选 smoke 覆盖的那 11 个类 |
| └ Destination | Latest iOS Simulator | |
| Post-Actions | 第一次**不加** TestFlight | 需要 app 记录与构建号齐备后再加 |

预期耗时：干净环境 + 首次解析 SwiftPM 约 **8–15 分钟**；25 小时/月足够 100+ 次。

## 4. 第一次跑（你）

Manage Workflows 里点 ▶ Run，看 Report Navigator。关注三处日志：

1. `Resolve Package Graph` —— 应出现 `Checking out 16.1.1 of package 'socket.io-client-swift'`；
2. `xcodebuild test` —— 编译 + 跑测试；
3. 末尾测试计数 —— 本机全量为 354 项；smoke 子集为 122 项。

## 5. 日常使用

- 改完代码 `git push`，若 Start Condition 设为 Branch Changes 会自动跑；否则手动 Run。
- **不要提交重新生成的 `project.pbxproj`**，除非确实改了 `ios/project.yml`。
  现在两者一致，`xcodegen generate` 只会引入 139 行顺序抖动而无实际变更。
- 本地先跑 `scripts/smoke.sh all` 再 push，能省云端计算时间（本地约 16 秒热缓存）。

## 6. 与需求边界的关系

本清单只建立 CI 通道。**CI 绿不等于验收通过**：

- CI 不覆盖 V2-A01—A28 的真机项（物理 Watch Fall Detection、Emergency SOS
  可观测性、真实 Core Location、蜂窝 E2E、APNs）。
- CI 不替代 `docs/requirements.md` 的逐项验收，也不构成 App Store 提审证据。
- Watch workflow 在 Fall Detection entitlement 获批前不应创建。
