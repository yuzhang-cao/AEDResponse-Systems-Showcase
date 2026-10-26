# 登录页与启动动画调整 · 2026-09-28

## 状态

**用户已回复“按这版实现”，本地代码与构建验证已完成，尚未安装或做真机视觉验收。** 实现采用无顶部图标、整体居中、小勾选框、蓝色协议的最后一版。以下图片是 imagegen 内置工具生成的概念稿，不是真机截图；运行时使用原生 SwiftUI 控件和 Shape，不把概念图当成 UI 位图。

- [登录页最新居中稿](login-centered-blue.png)：已确认的中文浅色、中文深色、英文深色对照。
- [启动动画关键帧](launch-ecg-storyboard.png)：静态分镜，不是实际动画；约 1 秒的心电线绘制与淡出。
- [生成与编辑提示词](PROMPTS.md)：使用内置 imagegen，未使用 CLI/API fallback。

## 登录页实现

- 去掉顶部红色 heart.text.square.fill 图标，不移除原生 Apple 登录按钮内的 Apple 标志。
- 标题、按钮、协议作为一个整体，在导航栏与底部安全区域之间水平、垂直居中；协议行内部仍左对齐。小屏幕和大字体时允许滚动，不裁掉协议。
- 四项独立勾选，默认不勾选，全部同意且协议可读后才能准备/发起登录。敏感个人信息保持单独同意。
- 协议区在登录按钮下方；删除原底部“使用 Apple 账号登录，参与附近志愿协作。”。
- 勾选框视觉 18 pt，保留 44 pt 点击区域；协议链接使用蓝色。AgreementCheckboxStyle 参数化，其他页面仍保持原 22 pt 和绿色默认值。
- 使用原生 SignInWithAppleButton：浅色黑按钮、深色白按钮；补齐登录页的中英文资源与支持语言，不能靠覆盖原生按钮文字伪造本地化。
- 协议标题的界面翻译不等于法律正文翻译；不改协议版本、正文或签署校验。

## 手表心电彩蛋：按用户条件放弃

用户提议“佩戴 Watch 时自动检测并显示当前用户心电图，不行就放弃”。Apple 的 HKElectrocardiogram 仅提供对已经保存的 ECG 记录的只读访问；新 ECG 需要用户在 Watch 打开心电图 App，并接触 Digital Crown 约 30 秒。心率数值不是 ECG 电压波形，不能画成用户的真实心电图。

因此不实现自动真实 ECG 彩蛋，不新增 HealthKit 权限，不读取历史波形冒充当前测量。启动线条仅为装饰，无心率数字、诊断或“正在检测”提示。

核验来源：

- [Apple HKElectrocardiogram](https://developer.apple.com/documentation/HealthKit/HKElectrocardiogram)
- [Apple Watch ECG 录制步骤](https://support.apple.com/en-us/120278)
- [HealthKit heartRate 类型](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartrate)

## 启动动画与紧急跳过实现

以下已接入源码并完成纯逻辑/编译验证，**不是锁屏/后台真机验收结论**。动画为 0.8 秒绘制、0.2 秒淡出，普通点击也可立即略过。

- 动画仅属于普通前台冷启动的展示层；不延迟 ApplicationRuntime.store 初始化、WC 接收、身份恢复、REST 对账、通知回调或后台上报。
- 本地/远程紧急通知启动、Watch 跌倒消息及持久待处理消息、待确认患者事件、有效响应请求、进行中的事件/响应任务均优先于动画。
- 在入口收到通知/跌倒意图时即跳过，不等服务器事件返回后再判断；payload 只是展示优先级信号，不能赋予事件访问或接单权限。
- 动画播放中出现紧急信号即撤掉，当次进程中不因消息被消费/状态清空而重新播放；从后台返回不重播。
- 身份或事件恢复尚未完成、无法确认是否有紧急业务时，保守跳过；不能为判断是否播放装饰动画而增加联网等待。
- Reduce Motion 或 VoiceOver 开启时跳过。系统静态 Launch Screen 与 App 内可跳过动画分开；不会也不能保证隐藏 iOS 本身的静态启动画面。

已核对的接线位置：

- App/AEDResponseApp.swift：保留原 ApplicationRuntime.store 和场景激活，不增加等待。
- Services/RemoteNotificationService.swift：进程初始化、pendingMessageID / pendingLocalAlert、通知点击回调。
- App/AppStore.swift：pendingPushMessageID、pendingLocalAlert、pendingPatientEventID、visibleEvents、responseRequest、assignment / acceptedResponseEventID、handleCompanionRequest。
- Services/CompanionBackgroundMailbox.swift 与 DeviceServices.swift：持久接收队列；不能只看当前可见事件。
- Application/LaunchPresentationPolicy.swift：单进程一次决策；skip 锁存，不随通知消费、账号切换或回前台重置。
- Views/RootView.swift、Views/LaunchECGView.swift：独立展示层、即时移除、任务取消、深浅色与辅助功能。

纯策略已覆盖普通冷启动一次、恢复未知、各类紧急状态、入口提前打断、播放中打断、后台/回前台不重播和 Reduce Motion。真实邮箱测试覆盖普通绑定与紧急队列的区分、真实/模拟观察、事件恢复、重建后保留、不可读/不可写安全跳过。AppStore 的远程/本地通知入口、未知服务端状态三项新集成测试已加入并编译，尚未在 iOS 执行。

## 本轮验证与范围

- XcodeGen 生成成功；工程 developmentRegion=zh-Hans，knownRegions 含 en/zh-Hans；实际 Debug 包 CFBundleDevelopmentRegion=zh-Hans、CFBundleLocalizations=[zh-Hans,en]，两份 Login.strings 均入包。
- macOS Foundation/Watch 逻辑测试 **72/72**，其中启动策略 9、语言资源 3、邮箱 18（本轮新增 4），其余为已有 Watch/提醒回归。不启动 Simulator、不调用真实传感器、不连接服务器。
- iPhone + Watch **Debug、Release generic device SDK 构建成功**；CODE_SIGNING_ALLOWED=NO，是未签名编译产物，不可声称已部署到设备。
- AEDResponseUnitTests **build-for-testing 成功**。包含本轮 AppStore 入口回归和原四项独立同意用例，只编译，未在 iOS 执行。
- Apple 认证结果/协议版本校验、nonce/issuer 检查、LoginAgreementConsent 四项可读性判断，与本轮修改前快照逐段一致；未变更法律正文或版本。
- 两份 .strings 通过 plutil；脚本 bash -n 与本轮文件 diff --check 通过。构建仅有系统 AppIntents 元数据跳过提示，无编译错误。

日志及本轮修改前快照：`/tmp/aed-login-launch-20260928.kSc2NF/`。主要日志为 `debug-build.log`、`release-build.log`、`tests-compile.log`、`swift-tests.log`。最后一项由该目录 `swift-tests/Package.swift` 运行；使用 canonical 源码与测试的本轮副本。

复验命令（在项目根目录执行；均不安装设备）：

```sh
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/AEDResponse.xcodeproj -scheme AEDResponse -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/aed-login-launch-20260928.kSc2NF/Build -clonedSourcePackagesDirPath ios/.build/SourcePackages -disableAutomaticPackageResolution -skipPackageUpdates CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/AEDResponse.xcodeproj -scheme AEDResponse -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/aed-login-launch-20260928.kSc2NF/Build -clonedSourcePackagesDirPath ios/.build/SourcePackages -disableAutomaticPackageResolution -skipPackageUpdates CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/AEDResponse.xcodeproj -scheme AEDResponseUnitTests -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/aed-login-launch-20260928.kSc2NF/Build -clonedSourcePackagesDirPath ios/.build/SourcePackages -disableAutomaticPackageResolution -skipPackageUpdates CODE_SIGNING_ALLOWED=NO build-for-testing
swift test --package-path /tmp/aed-login-launch-20260928.kSc2NF/swift-tests
```

登录页面、登录恢复提示和常见认证错误已增加中英文资源；这不是整个业务 App 或法律正文的英文翻译。真机仍需核对原生 Apple 按钮语言、浅深色、长英文/大字体、动画与紧急中断的实际表现。已登录冷启动如仍在恢复身份/事件状态，会直接跳过动画，不等待恢复完成后补播。

APNs、服务器部署、手机/Watch 安装和非界面业务继续暂停，等待用户连接手机后再开始。禁止镜像、Simulator、DDI、真实 Fall/SOS 或外部联系；保留全部既有未提交修改。
