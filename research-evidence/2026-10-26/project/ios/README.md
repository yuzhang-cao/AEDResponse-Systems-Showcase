# AEDResponse iOS/watchOS v2

> 2026-09-26 持续互联更新：即时 RPC + 系统后台 mailbox 的 Watch→iPhone 中转为主链路，带冷启动接收、自动租期恢复和最终服务器 ACK；原始 Watch 事实不由手机合成。持久绑定不随即时可达性或短期上传租期失效。最新约束见 [中转契约](../contracts/watch-relay.md)。独立直传仍需单独 App Attest 授权，不能用中转通过代替。

SwiftUI iPhone App 与现代单 target watchOS companion。实现以仓库根目录的 `docs/requirements.md`、`docs/architecture.md`、`contracts/openapi.yaml` 和 `contracts/events.md` 为准；v2 与旧 MVP 不兼容。

## 登录状态保存（2026-09-26）

短期 access token 到期不等于需要再次 Apple 登录。当前服务端的 refresh 凭据在一次明确登录后固定有效30天；客户端在此期间自动换取短期凭据，不改成永久 bearer，也不自行延长服务端期限。

生产 `AuthSessionRefreshCoordinator` 由同一 AppEnvironment 的账号客户端/业务客户端共享：合并并发刷新、读取最新同次登录凭据，先原子提交 Keychain 再通知 UI。网络连接代次不决定登录凭据能否保存。Keychain 暂时不可读时保留“恢复登录”状态并重试；写入失败保留已刷新的值，不重发已经轮换的旧 refresh token。不同登录由本机 `loginID` 隔离；主动退出先禁止旧刷新写回，再执行已有持久撤销流程。旧版 Keychain 数据无此字段时自动迁移，不改变用户/设备/Watch 配对 ID。

build 5 的本地测试、签名产物与实机安装边界见 [登录持久化证据](../docs/evidence/login-persistence-2026-09-26/README.md)。

## 运行边界

- iPhone 必须登录，仅提供手机号验证码与 Sign in with Apple；登录后分别签署患者协议、志愿响应者协议、隐私政策和敏感个人信息同意，并申请通知、定位权限。
- 平时为中立待命；后端患者激活自动切换患者 UI；响应请求必须明确接受后才计入有效 N，患者身份始终优先。
- Watch 仅在持久绑定未撤销、Fall Detection 授权和 Watch 定位权限都有效时启动 `CMFallDetectionManager`、`CXCallObserver` 与业务定位。`WCSession` 通过受限 RPC 中转 Watch 原始观察；不可即时通信时走受保护持久队列和系统后台投递。未绑定时只能恢复绑定，不能提交业务观察；手机 bearer 不传给 Watch。Watch 的一次性“是否需要帮助？”回答决定触发：`NEEDS_HELP` 立即上报，`DECLINED` 清除且不上报，未回答时仅在 120 秒内观察到新的 outgoing 状态才上报 `NO_RESPONSE`。独立授权和 WAN 可用时才允许 Watch 直传备用；备用位置仍按原 fallback 来源与新鲜度规则处理。它不拨号、不判断号码/接通/时长、不检测短信、不分配响应者或 AED。
- iPhone 不编入 Fall Detection coordinator，不使用 iPhone CallKit 触发，只消费后端 REST/Socket.IO v2 状态。患者与已接受响应者在服务端下发的本设备参与窗口内，对每个合法 UTC 整秒槽严格产生一条记录。`FIX` 使用真实 `fixObservedAt`（必须位于该 slot 内）；没有新 OS fix 时仍写不带坐标的 `NO_NEW_FIX`。一次 Core Location 批量回调按真实时间跨秒分组，在 slot 首次提交前，同秒只保留观测时间最晚的合格 fix；首次提交后内容永久封口，不做 correction。每五个连续秒槽正常组成一个事件位置批次，累计移动达到 10 米可提前发送 1–4 条连续槽。开放草稿（clocked slot 与最新候选 fix）按 server namespace/user/device/event/role/generation 原子写入受保护队列；进程重启会留出 5 秒接收系统补交 fix，旧进程已 clock 的无 fix 槽保持 `NO_FIX`，真正停机空缺写 `APP_NOT_RUNNING`。REST ACK 前不会删除已封口批次；ACK 只解锁本地重试副本的删除，不解锁记录改写。若未 ACK 批次后来被权威时间窗判定为跨界，只可换用新 `batchId` 重组原样合法 records，并把越界 records 追加到不可改写的本地隔离证据；任何 record 内容和 `recordId` 都不变。中立待命/搜索圈仍使用最新值位置接口。工程声明定位后台能力但不启用 extended runtime，锁屏/挂起/终止后的严格秒槽补齐仍需真机验证。
- 事件投影中的 `canPublishEventPosition` 是服务端写权限真值；同用户次 iPhone 可显示患者态但该值为 `false` 时不启动事件 P 队列，终态同样不采样。客户端不根据本地角色或 Socket hint 推断该权限。
- 响应者在接受附近 offer 前只看到“跌倒救助”、距离/ETA 分桶、当前搜索半径和剩余有效期；精确 P、地址卡与匿名协同摘要须等服务端接受结果和 REST 对账后才可见。Socket.IO 只读通知，所有 delivery receipt 均走 REST。
- 生产 iPhone 使用公网 HTTPS REST + WSS Socket.IO；关闭 Wi-Fi 后必须能仅靠蜂窝数据上传 R/P 并接收状态。它不要求与 Windows 同处局域网或加入 Tailscale。现有 HTTP 地址能力只保留给本地/受控开发，不是生产验收路径。
- 没有手动 SOS、App 自建误报倒计时或生产模拟穿戴入口。`AEDResponseTestHost` Debug 可显式切换本地 fixture 患者/响应者场景；它强制脱离后端，不编译进生产 target 或 Release。Watch 不提供手工输入服务地址或配对 ID 的生产入口，配对只接受 iPhone 发出的短期认证封包。
- append-only timeline 保留为内部对账/审计数据，iPhone 用户 UI 不展示时间线。
- 任务仅为 `GO_TO_PATIENT`、`FETCH_AED`。人数公式只计算角色数量，具体成员由服务端 assignment 决定，不按接受顺位推断。
- AED 路径严格为 `R → A → P`；获取后提交幂等 `AED_ACQUIRED`，不可用时保留 `AED_UNAVAILABLE` 与服务端重派。
- 安全测试拨号器由 Xcode 构建开关控制、默认隐藏；即使开启也只允许用户主动打开，不自动呼叫，不参与触发。

Watch 的 5 秒 fallback 调度只保证在 App 进程获得执行时间时按该周期调度，不代表降腕、息屏或系统挂起后仍能严格持续。当前冻结边界明确不启用 extended runtime，也不承诺挂起后严格 5 秒；进程内调度、息屏/挂起表现和系统授权仍需分别在物理 Watch 验证。

## 工程结构

2026-09-05 新增响应者退出链路：唯一响应者连续确认 3 次，普通退出一次；
REST ACK 的权威时间收束位置证据，原声明可幂等重试。新确认状态机有原生纯逻辑
验证脚本 `scripts/verify-responder-exit.swift`；最新编译/测试范围见
[业务处理验证报告](../docs/business-processing-validation.md)。本批已获准进行离线 iPhone UI 验证；服务器接收与真实网络测试继续暂停。

- `project.yml`：XcodeGen 唯一工程配置源。
- `AEDResponse/`：iPhone domain、application、REST/Socket adapter、设备服务和 SwiftUI。
- `AEDResponseWatch/`：Watch 监控 adapter、一次性问答 coordinator、即时/后台 WCSession 中转、独立授权的 WAN fallback REST 和受保护 outbox。
- `AEDResponseWatchLogic`：仅为跨平台确定性测试编译 Watch 纯逻辑；iPhone production target 不依赖它。
- `AEDResponseTestHost/`：不嵌入 Watch 的 iOS 测试宿主；只有 Debug 且 `AED_SHOW_TEST_TOOLS=YES` 时显示本地 UI 场景面板，Release 不编译该入口。
- `AEDResponseTests/`、`AEDResponseUITests/`、`AEDResponseWatchTests/`：领域/契约/UI/Watch 测试。

SwiftPM 使用 `socket.io-client-swift` 16.1.1。工程不硬编码 `DEVELOPMENT_TEAM`、账号、profile 或 token。

## 已批准的 iPhone 联网测试版：直接运行

Xcode 选择 `AEDResponseControlledTests` 和已连接、解锁的物理 iPhone，使用
Run（不是 Test）。该目标是普通 iPhone App，不需要 UITests Runner；它复用
正式手机业务代码。登录页始终提供手机号/Apple入口；测试Debug开启时还允许
已有的受控会话，不再以“等待受控测试账号”页面阻挡正式登录。真实Apple/
短信成功仍需后端供应商配置和对应签名能力，不能将页面出现视为登录验收。

签名通过 `Config/Signing.xcconfig` 可选载入本机 `Signing.local.xcconfig`。
本机文件只配置 `DEVELOPMENT_TEAM`，被 Git 忽略；换机器时按同目录 example
填入 Xcode Accounts 中的 Team ID，再执行 `xcodegen generate`。该引用保存在
`project.yml`，重新生成工程不会丢失，GUI Run 不再需要额外传 Team 参数。
此配置仅用于 `AEDResponseControlledTests`，不修改正式 iPhone/Watch 的
entitlement，也不签发受控账号或导入身份凭据。

## iPhone 本地场景预览

### 构建开关

- `AED_ENABLE_TEST_FEATURES` 是测试总开关：两个测试 Debug 目标当前为 `YES`，正式目标和所有 Release 为 `NO`。联网测试版关闭后拒绝受控身份、隐藏并忽略开发地址覆盖；源码保留。离线 TestHost 仍是独立无网络测试宿主，不能作为正式版发布。
- XcodeGen 的 `AED_SHOW_TEST_TOOLS` 是构建设置，不是 App 内开关。仅 `AEDResponseTestHost` 的 `Debug` configuration 将它设为 `YES`，此时主界面才显示底部“测试”Tab；设为 `NO` 时该 Tab 隐藏。
- `AEDResponse` production target 和所有 `Release` 构建不提供测试入口，即使修改运行时用户设置也不能打开它。`AED_SHOW_DIALER` 默认也是 `NO`，安全测试拨号器不会出现在普通行动页面，且没有 App 内开关。

### 操作步骤

1. 在 Xcode 打开 `AEDResponse.xcodeproj`，scheme 选择 `AEDResponseTestHost`，configuration 保持 `Debug`，并确认 `AED_SHOW_TEST_TOOLS=YES`。
2. 选择 iPhone 真机运行。TestHost 不嵌入 Watch，Personal Team 可用于普通 iPhone 签名（仍受免费 profile 已安装 App 数量限制）。本项目的 iPhone 功能验收直接在物理 iPhone 上执行，不以 Simulator 结果替代。
3. 首次运行仍需分别完成患者协议、志愿响应者协议、隐私政策和敏感个人信息同意；进入主界面后打开底部“测试”。自动 UI 测试使用 `-UITestMode` 的 TestHost 假身份，不连接服务端。
4. 可选择五种本地 fixture 场景：“中立待命”、“附近响应请求”、“患者”、“响应者 · 前往患者”或“响应者 · 获取 AED”；选择后自动返回“行动”页。附近请求由本地预览当前时间生成，接受动作也只改变本地状态。
5. 患者场景中的“误报”和“结束救助”是两个独立操作，各自只要求一次明确确认；二者都不会模拟 Watch 触发或真实急救调度。
6. 顶部“测试模式”条表示当前是 fixture 预览。TestHost 在该模式下禁用 REST/Socket.IO 与 Settings 的手动“Ping 服务”，所有业务按钮只改变本地状态；响应者路线使用离线 `Canvas` 示意图，不是 MapKit 或实际地图导航。
7. Settings 中的“打开系统设置”链接只负责交给 iOS 管理通知、定位等 OS 权限；应用不提供绕过系统授权的内部开关。

同一次 App 启动若已尝试过 live 连接，本地场景按钮会禁用；需完全退出并重新启动 TestHost。这是为了防止已在途的 bootstrap/业务请求在预览期间继续完成。

`AEDResponse` 生产 target 及 `AEDResponseTestHost` Release 都不编译该面板。该预览不是手动修改生产角色，也不是 Watch/Fall Detection、实际地图导航、服务器接收、真实登录、公网 HTTPS/WSS 或双机/Watch 测试证据；这些外部验证当前继续暂停。

## 附近待命用户汇总

- 中立待命页默认显示列表：1 公里内、1.5 公里内、2 公里内各有多少可接受救助请求的其他用户；累计人数不能跨行相加。可切换地图范围圈，不显示志愿者个人点位。
- `GET /api/v2/me/nearby-volunteers` 仅返回 `generatedAt` 与 `ranges`；统计在后端完成。客户端无需接收他人的精确位置或身份。进入页面/下拉刷新；超过 120 秒的展示缓存失效，不新增位置采样或后台轮询。
- TestHost 默认示例为 3/5/8 人，明确标注“示例数据”，不是当前附近真人统计。其地图使用离线范围示意；真实 MapKit 视图需要自己的有效定位。没有有效统计时显示暂不可用，不显示假 0 人。
- 用户已将本次验证限制改为有线或无线均可。实际连接类型与新增功能的构建/实机结果见 [附近人数批次记录](../docs/nearby-volunteers-validation-2026-09-06.md)；有线结果不替代无线传输验收，也不恢复真实业务网络测试。

## 生成、设备 SDK 构建与真机测试

```bash
cd ios
xcodegen generate
```

先用 `xcrun devicectl list devices` 确认目标 iPhone 为 `available`，再使用该设备的 UDID、已登录的 Apple Team 和匹配 provisioning profile 执行测试：

```bash
xcodebuild \
  -project AEDResponse.xcodeproj \
  -scheme AEDResponseTestHost \
  -configuration Debug \
  -destination 'platform=iOS,id=<IPHONE_UDID>' \
  -derivedDataPath /tmp/aedresponse-iphone-tests \
  -clonedSourcePackagesDirPath .build/SourcePackages \
  -only-testing:AEDResponseTests \
  test
```

UI 测试使用同一真机 destination 并改为 `-only-testing:AEDResponseUITests`。这两条命令会真实签名、安装和执行；设备不可用时不得把下面的 generic 构建写成测试通过。

generic iOS 源码/架构构建使用不嵌入 Watch 的测试宿主：

```bash
xcodebuild \
  -project AEDResponse.xcodeproj \
  -scheme AEDResponseTestHost \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath .build/DerivedData-generic-v2 \
  -clonedSourcePackagesDirPath .build/SourcePackages \
  CODE_SIGNING_ALLOWED=NO \
  build
```

对 Watch 源码和测试 bundle 做设备 SDK 编译（不启动 Simulator）：

```bash
xcodebuild \
  -project AEDResponse.xcodeproj \
  -scheme AEDResponseWatch \
  -configuration Debug \
  -destination 'generic/platform=watchOS' \
  -derivedDataPath .build/DerivedData-watchos-v2 \
  -clonedSourcePackagesDirPath .build/SourcePackages \
  CODE_SIGNING_ALLOWED=NO \
  build

xcodebuild \
  -project AEDResponse.xcodeproj \
  -scheme AEDResponseWatch \
  -configuration Debug \
  -destination 'generic/platform=watchOS' \
  -derivedDataPath .build/DerivedData-watchos-v2 \
  -clonedSourcePackagesDirPath .build/SourcePackages \
  CODE_SIGNING_ALLOWED=NO \
  build-for-testing
```

完整 `AEDResponse` scheme 会嵌入 Watch App，因此本机必须安装与 Xcode 匹配的 watchOS 平台组件。generic watchOS device SDK 编译只证明源码可编译；Watch 配对、App Attest、Fall Detection、定位和 WAN 行为仍须在签名物理设备上分别验证，证据边界见 `VALIDATION.md`。

## 真机与 entitlement

1. 在 Xcode Settings → Accounts 配置有权限的 Apple 开发账号，并为 iPhone/Watch bundle ID 生成匹配 profile。
2. Apple 必须单独批准 `com.apple.developer.health.fall-detection`；证书、Personal Team、工程 entitlement 文件或 unsigned build 都不能替代批准证据。
3. 在 Watch 上启用 Developer Mode、重启并确保开发隧道/DDI 可用。
4. 签名构建后同时检查 Watch app 的 `codesign` entitlements 与 embedded provisioning profile。
5. 真机权限、Fall Detection 与真实 Emergency SOS 可观测性分别验证。不得用 Simulator 或模拟 port 冒充，也不得在无人值守情况下触发可能呼叫公共紧急服务的 SOS。

生产客户端只接受受信任 build/Info.plist 提供的公网 `https://` issuer，并规范化到 `/api/v2/`；未配置或 issuer 不一致时 fail closed。仅带显式开发标识的 Debug/TestHost 可使用 loopback HTTP，普通用户不能把身份令牌或位置令牌发往任意主机。Windows/Tailscale 本地运维边界见 `backend/README.md`。
