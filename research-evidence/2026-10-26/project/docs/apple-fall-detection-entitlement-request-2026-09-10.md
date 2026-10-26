# AEDResponse Apple Fall Detection entitlement 申请材料

状态：**Apple 已批准，且本机已实测可用（2026-09-17）。**
时间线：2026-09-11 提交申请 → 2026-09-17 收到 Apple 批准邮件 → 同日在本机启用该能力 → Archive 失败转为**成功**，
签名产物确认带 `com.apple.developer.health.fall-detection = true`。详见下文「获批与启用记录」。
申请编号与提交时间仍待从 Apple 回执邮件抄回「申请记录」。

**批准前它不会出现在开发者网站上（2026-09-13 复核记录；已于 2026-09-17 获批后更新）。** Fall Detection 是 Apple 单独审批的 managed capability，批准前网站上没有摆放它的地方：

- 批准前：Certificates, Identifiers & Profiles → Identifiers 里该 Watch App ID **看不到 Fall Detection 这一项**，也没有开关可勾；
- 批准前：Xcode 的 Signing & Capabilities 里同样没有该 capability，只能手写 entitlement key；
- **批准后（2026-09-17 起）**：它会以 managed capability 形式出现，可在 Xcode 的 Signing & Capabilities 添加，或在开发者网站该 App ID 的 **Capabilities 标签**里 Enable。注意是 **Capabilities 标签**，不是原来的 App Services 勾选列表——这正是批准前“看不到”的原因，不是漏申请；
- 提交入口只有专用表单 <https://developer.apple.com/contact/request/fall-detection-api/>（会跳转到 Apple 登录页），提交后**网站不产生任何可见记录、也没有可回查的状态页**。唯一凭证是 Apple 的回执邮件与后续回复邮件；
- 唯一能被本地客观证实的生效标志是：重新生成的 provisioning profile 里出现 `com.apple.developer.health.fall-detection`。

**2026-09-13 16:03 本机复核（历史快照，当时仍未获批）：** 最近一次下载的 Watch profile（`iOS Team Provisioning Profile: dev.codex.aedresponse.watchkitapp`，文件时间 2026-09-11 11:03）的 entitlement 只有 `application-identifier`、`com.apple.developer.devicecheck.appattest-environment`、`com.apple.developer.team-identifier`、`get-task-allow`、`keychain-access-groups`，**不含** `com.apple.developer.health.fall-detection`。申请提交到本次复核约 2 天，仍在正常等待窗口内。（该结论已于 2026-09-17 被下文「获批与启用记录」取代。）

## 申请对象

- App：AEDResponse
- Watch App Bundle ID：`dev.codex.aedresponse.watchkitapp`
- Development Team：`GR6YBCDW7R`（已从本机 Apple provisioning profile 的 `TeamIdentifier` 核实）
- Entitlement：`com.apple.developer.health.fall-detection`（Boolean）
- API：`CMFallDetectionManager`
- 关联 capability：Watch App；iPhone target 不直接创建 `CMFallDetectionManager`
- 当前代码入口：`ios/AEDResponseWatch/Services/WatchSystemMonitors.swift`

Apple 的官方文档说明，`CMFallDetectionManager` 需要 Apple entitlement；该能力可让 Watch App 接收 Fall Detection 通知并获得响应事件的后台运行时间。项目必须同时提供 `NSFallDetectionUsageDescription`，用户授权后才会收到事件回调。

官方入口：

- [CMFallDetectionManager](https://developer.apple.com/documentation/coremotion/cmfalldetectionmanager)
- [Fall Detection Notifications entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.health.fall-detection)
- [CMFallDetectionManager.requestAuthorization(handler:)](https://developer.apple.com/documentation/coremotion/cmfalldetectionmanager/requestauthorization(handler:))

## 本地预检结果

已存在且已核对：

1. `ios/AEDResponseWatch/AEDResponseWatch.entitlements` 声明 `com.apple.developer.health.fall-detection = true`。
2. `ios/project.yml` 的 `AEDResponseWatch` target 同步声明该 entitlement 和文件路径。
3. `ios/AEDResponseWatch/Info.plist` 声明 `NSFallDetectionUsageDescription`。
4. `WatchAppDelegate.applicationDidFinishLaunching()` 调用 `WatchRuntimeModel.shared.start()`；生产 adapter 在可用设备上创建单一 `CMFallDetectionManager` 并尽早设置 delegate。
5. `WatchRuntimeModel` 通过用户界面显式调用 `requestAuthorization()`，拒绝/受限/不可用状态均保留，不会伪造为已授权。

尚未证明（2026-09-17 更新：前两项已证明，见「获批与启用记录」）：

- ~~Apple 已批准该 entitlement~~ —— **已于 2026-09-17 获批**（Apple Developer Relations 批准邮件）；
- ~~当前 Team 的 provisioning profile 已包含该 key~~ —— **已证明**：profile `REDACTED-ID-0001` 与归档内签名产物均含 `com.apple.developer.health.fall-detection = true`；
- 分发用（App Store / Ad Hoc）profile 尚未单独生成核对；
- 物理 Apple Watch 能接收真实 Fall Detection 事件并在短时后台窗口内完成 `completionHandler`；
- 真实后端、Watch WAN fallback、APNs 和用户通知送达。

## 提交步骤

1. 用 Apple Developer Program **Account Holder** 登录开发者网站，打开官方 Fall Detection Entitlement Request 入口。该申请不是单纯在 Xcode 勾选 capability。
2. 选择明确的 Watch App ID：`dev.codex.aedresponse.watchkitapp`。不要把 iOS companion 或测试 target 当成生产申请对象。
3. 使用下面的英文说明填写用途、数据最小化、授权和测试计划。Team ID、Apple Account、联系人和 App Store Connect 状态等账号字段只从当前账户读取，不在仓库中猜测或保存。
4. 提交后保存 Apple 的申请编号、提交时间、状态和回复原文到本文件的“申请记录”部分；不要把 token、profile、证书或邮件凭据提交到 Git。
5. 获批后重新生成/下载包含该 entitlement 的 development provisioning profile，安装到受控 Watch 测试设备，然后检查签名产物：

   ```bash
   codesign -d --entitlements :- \
     /path/to/AEDResponseWatch.app
   ```

   只有输出同时包含 `com.apple.developer.health.fall-detection = true`，才能把“profile 已包含”标为已确认。
6. 在架构主线完成后，分开执行授权、真实 Fall Detection、后台唤醒、网络不可达、fallback、终态和恢复测试；不能用模拟 monitor 或 generic build 代替。

## 历史影响：Xcode Cloud 首个 workflow 的 Archive 动作必然失败（**已解除**）

> **状态更新（2026-09-17）：本节问题已解除。** 能力获批并在 App ID 上启用后，
> 同一条 `xcodebuild archive` 已得到 `** ARCHIVE SUCCEEDED **`（见「获批与启用记录」）。
> 以下保留为历史记录，说明当时的失败形态与判据。

2026-09-11 实测（Xcode Cloud Build 5 + 本机同源复现）确认：该 entitlement 未获批前，
任何归档都无法完成，与 CI 环境无关。

Xcode Cloud `Test - iOS` 动作**通过**（代码编译 + 354 项测试全绿）；
`Archive - iOS` 动作失败，错误为 Code Signing：

```
Provisioning profile "…dev.codex.aedresponse.watchkitapp" doesn't include the
Fall Detection Notifications capability. …
Entitlement com.apple.developer.health.fall-detection requires approval from Apple
to include in a profile. (in target 'AEDResponseWatch')
```

本机用真实证书执行 `xcodebuild archive` 得到**完全相同**的错误（`** ARCHIVE FAILED **`），
因此这不是云端配置问题。**结论：在获批之前，CI 只作为测试门禁使用，不产出可分发包。**
不要把该失败当作代码缺陷，也不要用临时摘除 entitlement 的方式伪造绿色归档。

## 提交表单实际问到的四个字段与我们的回答（2026-09-11 提交版）

Apple 的表单按「紧急服务集成方」标准审核，逐项询问紧急呼叫能力。
以下为仓库保存的中文回忆记录，尚未取得实际提交的英文原文与回执，不能当作已核对的提交副本。下述历史表述不作为当前产品声明；当前口径见文末修订。

### 字段 1：请描述贵公司提供的服务以及贵公司在应急服务中提供的安全整合方案

> AEDResponse 是一套面向 Apple Watch 佩戴者的**院外心脏骤停（OHCA）志愿协同服务**，
> 由 iPhone App、Apple Watch App 和自建后端组成。
>
> 服务流程：Apple Watch 系统 Fall Detection 在用户事前授权后产生跌倒事件 → Watch App
> 单次询问「是否需要帮助」→ 用户选择需要帮助时事件立即成立；未回答时，只有在 120 秒内
> 观察到新的外拨状态才成立 → 事件以稳定 ID 上报后端 → 后端依据患者位置在 1/1.5/2 km
> 逐级搜索附近**已完成实名登录、签署志愿响应者协议、并开启定位与通知的志愿响应者**，
> 按「到患者」与「取 AED」两类任务分配 → 志愿响应者到达患者身边实施救助。
>
> **安全整合边界**：本服务**不发起紧急呼叫、不做医学诊断、不接入任何公共安全接听点
> （PSAP）、不做真实急救调度**。它与系统 Emergency SOS **并行独立**，不替代、不拦截、
> 不改写任何系统紧急呼叫行为。我们的定位是**补充**：在专业急救力量到达前，把最近的
> AED 和志愿者组织起来。

### 字段 2：支持的功能（优先呼叫路由 / 呼叫转接至 PSAP / 自动号码识别 / 自动定位识别 / 网络发起定位请求 / 高级移动定位）

**六项全部回答"不提供"，未勾选任何一项。** 文本框：

> 本服务不提供上述任何一项紧急呼叫功能。我们不是呼叫路由方、不接入 PSAP、
> 不参与号码与定位识别，也不参与 AML。App 不发起任何电话呼叫。

### 字段 3：不支持的功能 → 缓解措施

> 我们不声称提供与拨打紧急电话等效的支持，也不建议用户以此替代紧急呼叫。
> 我们采取的缓解措施是：
>
> 1. **不拦截、不替代系统紧急通道。** 本服务不修改 Emergency SOS，不改写系统拨号行为，
>    用户随时可以正常拨打当地急救电话。
> 2. **明确的产品边界。** 产品文档与界面均不宣称医学诊断、真实急救调度或替代专业急救服务。
> 3. **提供互补的救助资源。** 事件成立后，服务依据患者位置组织附近携带 AED 的志愿响应者
>    前往患者身边，缩短「专业急救到达前」的空窗期。
> 4. **事件必须有明确的人为结束动作。** 电话结束、Watch 失联、心率恢复等被动信号都
>    **不会**自动结束事件，只能由用户明确操作或经授权的后台流程结束，避免事件被静默丢弃。
> 5. **数据最小化与可追溯。** 仅采集该协同流程必需的事件与位置事实，记录绑定到已认证的
>    服务、用户、设备、配对与事件；未获后端确认的事实保留在受保护的本地存储中，
>    不会因登出、响应丢失、冲突或终态快照而被静默删除。
> 6. **通道冗余。** Watch 在 iPhone 不可达且自身有 WAN 时直接上传备份位置；iPhone 恢复
>    可达后立即夺回主来源。位置来源切换由服务端裁决，客户端不能自行提升权限。

### 字段 4：目标用户群体

> **主要用户**：18 岁以上、佩戴 Apple Watch Series 4 或更新机型（支持系统跌倒检测）的
> 成年人，尤其是独居、有心血管基础疾病或跌倒风险较高的人群。
>
> **志愿响应者**：已完成实名登录（手机号验证码或 Sign in with Apple）、签署志愿响应者
> 协议与隐私政策、授权 Always 定位与通知，并主动开启「可参与响应」的成年人，通常为
> 社区工作者、物业人员、急救志愿者或附近持证人员。
>
> **明确不面向**：专业急救调度机构、医疗机构，以及将其作为唯一急救手段的用户。
> 本服务不是公共紧急调度服务。

## 申请记录

- 提交状态：**已提交（2026-09-11 22:1x 本地时间，提交动作已发生）**；**Apple 已批准（2026-09-17 收到批准邮件）；同日在本机启用并验证通过**（见下文「获批与启用记录」）
- Apple 申请编号：**待填写 —— 只能从 Apple 回执邮件抄回。开发者网站上查不到该编号，也没有申请状态页**
- 提交时间：待填写（约 2026-09-11 22:1x 本地时间）
- 提交入口：<https://developer.apple.com/contact/request/fall-detection-api/>
- 账号角色：Account Holder（Individual，Team `GR6YBCDW7R`）
- Team ID：`GR6YBCDW7R`
- 使用的 Apple 账户：`[REDACTED_EMAIL]`
- Apple 回复：**已收到批准邮件（2026-09-17）**，原文要点：entitlement 已分配给账号、可为符合条件（eligible）的 App 配置该能力、组织账号的 Admin 也可使用。邮件原文与收发时间待抄回本文件

### 想在网站上“看见”这次申请，只有三条路（2026-09-13 核对）

1. **查回执邮件**：登录 `[REDACTED_EMAIL]`，搜索发件人 `developer.apple.com` / 主题含 `Fall Detection`。若有表单回执，编号只在那封邮件里。
2. **用同一 Apple 账户重开提交表单**：<https://developer.apple.com/contact/request/fall-detection-api/>。若提示已有在审申请，即代表提交成功；若仍是全新空白表单，则需重填一份。
3. **看 profile 是否含该 key**：客观证据是 Watch development profile 里出现 `com.apple.developer.health.fall-detection`，用 `codesign -d --entitlements :-` 或 `security cms -D -i` 核对。**注意：批准邮件 ≠ profile 已生效**——批准只把 entitlement 分配给账号，还必须在 Xcode（Signing & Capabilities → Fall Detection Notifications）或开发者网站该 App ID 的 **Capabilities** 标签里 **Enable**，profile 才会带上它。2026-09-17 已按此流程完成并验证通过。

### 待补事项

1. 从 Apple 批准/回执邮件抄回**申请编号**与**准确提交时间**，填到上面两行；并把批准邮件原文与收发时间抄回本文件。
2. ~~获批后重新下载 development profile 并核对签名产物~~ —— **已完成（2026-09-17）**：profile `e252c8c6` 与归档内 `AEDResponseWatch.app` 均含 `com.apple.developer.health.fall-detection = true`。
3. **下一步**：给 Xcode Cloud 增加 Archive 动作（并单独核对一次分发 profile 是否含该 key）；TestFlight 分发在核对通过后再启用。
4. 真实设备验收：物理 Apple Watch 的授权、真实 Fall 回调、后台唤醒、断网 fallback 与终态恢复（见「仍未证明」）。


## 获批与启用记录（2026-09-17）

### 时间线

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 2026-09-11 22:1x | 提交 Fall Detection entitlement 申请 | 提交动作已发生 |
| 2026-09-17 | 收到 Apple Developer Relations 批准邮件 | 邮件原文要点：entitlement 已分配给账号、可为符合条件（eligible）的 App 配置该能力、组织账号的 Admin 也可使用 |
| 2026-09-17 21:08 | 本机强制重新生成 profile 后，Archive **仍失败** | 新 profile `4186a337`（Apple 生成时间 21:08:49）**不含**该 key；`** ARCHIVE FAILED **` |
| 2026-09-17 21:11–21:13 | 在 Xcode/网站上为该 App ID **启用**该能力后重跑 | profile `e252c8c6`（21:12:43）**含**该 key；`** ARCHIVE SUCCEEDED **` |

### 关键结论：批准邮件不等于 profile 生效

`4186a337` 那份 profile 是批准之后由 Apple 服务器**新生成**的，却依然不含该 key，报错为
“capability needs to be assigned to your team **and bundle identifier**”。
即：邮件只完成「分配给 team」，还差「在 App ID 上 Enable」这一步。
Apple 文档对应流程见 [Capability Requests](https://developer.apple.com/help/account/capabilities/capability-requests)
与 [Provisioning with managed capabilities](https://developer.apple.com/help/account/reference/provisioning-with-managed-capabilities)。

另一个易误判点：**Apple 批准不会让本机已有的 profile 自动变成已授权。** profile 是从 Apple 服务器下载的静态文件，
不重新生成就会一直停在旧版本。因此“profile 里没有”只能说明未生效，不能区分“还在审”和“已批但没重新生成”。

### 本机验证证据（全部实测，2026-09-17 21:11–21:13）

归档命令：

```bash
xcodebuild archive -project AEDResponse.xcodeproj -scheme AEDResponse \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /tmp/aed-verify-2/AEDResponse.xcarchive -allowProvisioningUpdates
```

| 检查项 | 结果 |
| --- | --- |
| 归档退出码 / 日志 | `0` / `** ARCHIVE SUCCEEDED **`，`error:` 出现 **0** 次 |
| 归档元数据 | `AEDResponse` 2.0 (2)，27 MB |
| 新 Watch profile | `REDACTED-ID-0001`，创建 2026-09-17 21:12:43 |
| profile entitlements | 含 `com.apple.developer.health.fall-detection = true` |
| Watch App 签名产物 | `codesign -d --entitlements :- …/AEDResponse.app/Watch/AEDResponseWatch.app` 含 `com.apple.developer.health.fall-detection = true` |
| Watch 内嵌 profile | UUID `e252c8c6-…`，与已授权 profile 一致 |
| 签名校验 | Watch 与 iPhone App 均 `codesign --verify --deep --strict` 通过 |
| `NSFallDetectionUsageDescription` | 已随包生效 |
| iPhone companion entitlements | `application-identifier`、`applesignin`、`team-identifier`（未越权新增） |

**结论：开发/Ad Hoc 签名链路已打通，Archive 不再是阻塞项。** CI 可以从「只跑 Test」升级为增加 Archive 动作。

### 仍未证明（不要据此扩大结论）

- 分发路径（App Store Connect / TestFlight 的 distribution profile）尚未实测；按 Apple 文档，
  能力已在 App ID 上启用后分发 profile 应自动包含，但**需单独生成并核对一次**才能标为已确认。
- 物理 Apple Watch 尚未接收过真实 Fall Detection 事件；后台唤醒、`completionHandler` 时限、
  拒绝/需要帮助/未回答三个分支、外拨观察窗口、网络不可达与 fallback、终态恢复均**未验收**。
- 本文档记录的授权只能证明该具体权限获授，**不得**扩大为 Apple 对产品安全、医疗能力或法律合规的背书。

## 当前用途说明修订（2026-09-13；未重新提交 Apple）

不提供或替代公共急救调度服务；本系统会依据跌倒相关求助信号，组织附近志愿者前往并协调 AED 取用，不判断患者是否心脏骤停或是否需要电击。

- 不发起紧急呼叫、不接入 PSAP、不派救护车；志愿协同与系统 Emergency SOS 独立运行。
- 登录方式仅为 Sign in with Apple，用于账号身份验证，不称为实名核验。
- 参与者必须经可靠证据核验已满 18 周岁；没有可靠成年证明时禁止进入业务。Apple 登录、自报年龄、监护人声明及仅由客户端上传的成年布尔值均不作为服务端放行依据。
- 当前没有接通可靠成年核验服务，不能描述为“年龄核验已完成”或开放真实业务。
- entitlement 的授权记录只能证明具体权限获授，不得扩大为 Apple 对产品安全、医疗能力或法律合规的背书。
- 旧 provisioning profile 不含权限不能单独证明当前审核状态；空白申请表也不能证明此前未提交，不据此重复提交。
- Fall Detection 申请页目前跳转至 Apple 登录页，附加条款未读到；ADPLA 公开条款不替代账户实际版本和附加条款。不能替用户记录“已接受赔偿风险”。

历史记录中的“实名登录”“手机号验证码或 Sign in with Apple”“不做真实急救调度”已被以上当前口径取代。须取回英文提交副本，确认是否需向 Apple 补充说明；本次未发送任何说明或接受协议。
