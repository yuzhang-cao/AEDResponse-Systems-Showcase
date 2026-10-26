# Tests UI 批次与物理 iPhone 验证

日期：2026-09-06（Asia/Shanghai）。本记录只覆盖用户批准的 UI 简化及离线业务交互，不代表完整产品验收。

## 已实现

- Xcode `AED_SHOW_TEST_TOOLS` 控制 TestHost Debug 的“测试”Tab；App 内无开关，生产/Release 不显示。`AED_SHOW_DIALER` 默认 `NO`，保留代码但隐藏拨号入口。
- Settings 显示账户、手机与服务状态、手动 Ping、Watch 配对/安装/当前通信、四项协议同意记录及版本时间、自身经纬度/精度，以及 iOS 设置链接。没有展示配对 ID、服务 URL、Watch entitlement 门槛或内部架构说明。
- 权限仍由 iOS 控制；签署协议不等于自动获得系统授权。Watch 显示 WCSession 的配对与可通信状态，不把它宣称为蓝牙物理连接的精确检测结果。
- 中立待命去除说明。附近请求显示“接受响应”和“拒绝”；未接受不显示患者精确位置。
- 患者只显示激活时间、简短状态和响应状态。误报/结束救助分开，各确认一次，分别形成误报取消/救助结束；不删除事件记录。
- 响应者“开始前往”后显示路线视图，响应状态固定在底部小卡片。获取 AED 前目的地为 AED，确认取得后切换患者；保留到达、获取、不可用、退出等操作。
- 唯一响应者退出仍为连续三次确认；取消清零。该 UI 批次未改后端补位和路线排序策略。

## 本地场景与可访问性修正

- 手动进入附近请求场景时使用当前时间生成有效期，修复固定旧日期导致请求立即过期的问题。
- 每个手动场景有独立事件 ID，防止前一预览的退出标记屏蔽新场景。
- 本地接受、任务推进、AED 获取与退出后刷新一致的角色/任务/响应人数投影；没有真实 HTTP/Socket 请求。
- TestHost 的 `allowsLiveNetworking=false`；离线路线为明确标记的 Canvas 示意图。只有真实运行模式才构造 MapKit/MKDirections。当前不将离线路线称为真实路网、逐向导航或后台导航验收。
- 真机 accessibility hierarchy 发现父卡片 identifier 覆盖内部按钮：给卡片/导航容器添加 `accessibilityElement(children: .contain)`，保持子按钮独立可访问。
- 原生患者确认弹窗将同一操作暴露为嵌套 Button；UI 测试选取其首个匹配，仍必须核对操作文字并真实点击后检查对应终态，没有跳过确认或降低终态断言。

## 验证与证据

设备为物理 iPhone 17 Pro / iOS 27.0；签名 Team 经 profile 核实。使用 `/tmp` DerivedData，避免桌面 File Provider 扩展属性干扰签名；没有运行 Simulator。

- TestHost generic `build-for-testing`：通过，`/tmp/aedresponse-ui-build-20260906.log`。
- 首轮物理 iPhone Tests：188 项中 177 通过、11 项源码架构检查按设计跳过、0 失败；同轮 UI runner 初始化超时，不计为 UI 通过。`/tmp/aedresponse-ui-physical-20260906-v1.xcresult`。
- UI v2：正常启动，4/11 通过；7 项失败由父标识覆盖导致。UI v3：9/11 通过，剩余两项为确认弹窗同名嵌套控件的查询歧义。
- 最终 UI v4：11/11 通过，0 失败、0 跳过；`/tmp/aedresponse-ui-physical-20260906-v4.xcresult`，实际 UI 用例执行约 182 秒。
- 最终 Tests 独立复跑：177 通过、11 项源码架构检查按设计跳过、0 失败；`/tmp/aedresponse-ui-unit-final-20260906.xcresult`。新增健康探测测试使用 URLProtocol stub，不访问实际服务器。
- Production Release generic iOS 构建：通过，`/tmp/aedresponse-ui-release-20260906.log`；产物 Info.plist 中两个显示开关均为 `NO`。这是编译/配置证据，不是生产 App 登录或真机运行验收。
- `git diff --check`：通过；保留原工作树，无 commit/push。

真实 iPhone 上的 UI 用例覆盖四项同意、患者界面、五场景切换、附近请求接受、患者两种一次确认、前往患者、获取 AED 后前往患者、设置、默认隐藏拨号入口、唯一响应者三次确认和取消重置。

截图由 XCTest 限定于本 App 采集；已查看中立待命、附近请求、患者、前往患者、Settings 上/下部、唯一响应者第三次确认、两种患者确认弹窗，以及获取 AED 前后目的地变化。响应状态卡固定在底部，长内容位于其上方的滚动区域。最终截图位于 `/tmp/aedresponse-ui-v4-attachments`，`manifest.json` 对应测试用例与文件；附件保留本机，不上传真实位置截图或系统诊断包。

## 修改入口

- `ios/AEDResponse/Views/`：Root、Settings、Patient、Responder、ResponderNavigation、Onboarding。
- `ios/AEDResponse/Application/AppFeatureFlags.swift`、`ios/project.yml`：Xcode 显示开关与工程生成配置。
- `ios/AEDResponse/App/AppStore.swift`、`Application/DemoScenarioEngine.swift`：离线场景时间/身份/状态刷新。
- `ios/AEDResponse/Services/ServerConnectionProbe.swift`、`DeviceServices.swift`、`Application/Ports.swift`：手动健康探测与 Watch 状态展示。
- `ios/AEDResponseTestHost/LocalTestScenarioView.swift`、`ios/AEDResponseUITests/AEDResponseUITests.swift`、`ios/AEDResponseTests/ApprovedUIScenarioTests.swift`、`ServerConnectionProbeTests.swift`：本地入口及回归。
- `docs/requirements.md`、`docs/runtime-flow.md`、`ios/README.md`、`ios/VALIDATION.md`、`HANDOFF.md`：与最新患者结束语义及验证边界对齐。

## 不在本批验收范围

真实手机号/Apple 登录、服务器接收/手机上传、真实 Ping、双机蜂窝公网、Windows/Azure、物理 Watch Fall/Emergency SOS、真实路网导航、后台位置持续性继续暂停或待独立验收。其余 UI 调整按用户要求留到后端测试后；本批未开发 AED 当面/照片交接 UI 或扩展业务规则。
