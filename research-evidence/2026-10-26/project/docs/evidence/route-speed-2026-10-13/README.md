# 随机模拟路线速度与调度优化 · 2026-10-13

用户在附近真实 AED 验收延期后，要求随机模拟 AED 和患者位置，核实算路是否仍需十多秒。本轮完成正常手机网络测速与最小调度优化；没有复现十多秒的 MapKit 计算。

## 实际手机数据

独立“路线验收”build 4 使用手机当前位置作为 R，在周围随机生成 3 个模拟 AED（100–650m）、模拟 P（250–450m），保存一次生成的坐标并复用于各轮。AED 互距及与 P 的间距至少 50m。所有点明确标注为模拟，未创建救助事件，也不代表真实设备。

| 原版直接算路 | 第 1 轮 | 第 2 轮 | 第 3 轮 |
| --- | ---: | ---: | ---: |
| 单 AED、两段步行路线 | 301.98ms | 95.50ms | 71.44ms |
| 3 个 AED、共六段路线 | 217.17ms | 210.05ms | 302.48ms |

均为 Wi-Fi，所有候选都返回完整两段路线。3 条路线总距离依次为 849m、1407m、2341m。独立 HTTPS `/healthz` 检查返回 200、耗时 471.97ms；此项没有计入 MapKit 耗时，也不代替路线业务 GET/PUT 的端到端测量。

build 5 沿用 build 4 的同一份场景文件，SHA256 一致；原版函数从修改前源码独立提取，优化版直接编译当前生产源码。四轮顺序及结果：

| 轮次 | 实现 | 3 AED 总计算耗时 |
| --- | --- | ---: |
| 1 | 原版 | 346.397ms |
| 2 | 优化版 | 166.666ms |
| 3 | 优化版 | 178.689ms |
| 4 | 原版 | 164.520ms |

四轮每条路线的 AED ID、两段距离及顺序完全一致。第一轮开始时网络监视器尚未回调，结束时为 Wi-Fi；其他三轮开始/结束均为 Wi-Fi。用户确认四轮完成，已独立导出并核对手机结果。

这些重复请求可能命中系统缓存；样本只有每版 2 次，原版最后一轮也与优化版相近，**不能据均值差宣称固定提速百分比**。能确认的是此场景算路均不足 0.35 秒，上一轮十多秒包含 USB 四轮串行交互，不能当作纯 MapKit 耗时。

## 代码变化

- `ios/AEDResponse/Services/AppleMapsDirections.swift`：原先等待同一 AED 两段全部结束，再开始下一个 AED；现在每次算路保持最多 2 条在途请求，一条完成立即补下一段，消除空闲等待。按输入顺序合并结果，仅返回两段都成功的候选。
- 保留实际步行查询、`requestsAlternateRoutes=true`、每段返回距离取最小值、最多 8 个候选及服务端最终分配权。没有增加缓存或请求总数，也没有扩大并发上限。
- `ios/AEDResponseTests/AppleMapsDirectionsTests.swift`：新增 6 项确定性回归，用可控门闩检查补位、并发、8 候选 16 段、顺序和值、缺路不留半条、错误及取消传播、候选上限。全部旧测试体保留。
- `this-turn.patch` 以开始本轮时的完整 dirty 文件为基线，仅列本次增量，不把此前未提交改动混为本轮工作。

## 验证

- 原生 macOS XCTest **15/15**，其中算路器 7/7；使用正式 helper 与原测试源码、临时 DTO 支持，不调用在线 MapKit。日志 `native-tests.log`，临时可重跑入口 `/tmp/aed-routing-speed-20261013/native-tests/run-tests.zsh`。
- Swift 6 严格并发与默认 MainActor 源码检查成功，见 `swift6-typecheck.log`。
- 正式 `AEDResponse` generic iOS 未签名集成构建成功：`xcodebuild -project ios/AEDResponse.xcodeproj -scheme AEDResponse -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/aed-routing-speed-20261013/DerivedData CODE_SIGNING_ALLOWED=NO build`。日志 `/tmp/aed-routing-speed-20261013/ios-build.log`。
- 两个独立测速 App 签名构建及严格验签成功，普通 USB 安装完成；本轮没有安装正式 AEDResponse。build 5 的编译来源哈希与手机回执、当前生产文件三者一致。
- `git diff --check` 成功；未使用 Simulator、DDI、镜像、生产数据、提交、推送或远程部署。

## 计时和剩余范围

计时仅使用手机 `ContinuousClock` 包围生产算路 helper；定位、随机生成、文件保存、USB 导出、HTTPS 检查和轮间 3 秒间隔均排除。前后使用相同起终点，不用每轮重抽造成的差异冒充提速。

本次只有 1/3 候选实机样本，未完成 8 候选、弱网、蜂窝、冷缓存和业务 GET/PUT 全流程速度验证；附近真实 AED 验收仍按用户要求待回深圳。任务取消测试只证明合作式 Swift 子任务行为，没有新增或验证 MapKit 底层网络立即取消；60 秒上下文截止控制也未在本轮修改。

精确手机位置及随机点原始坐标只保存在手机 Documents 和私有临时目录，未复制到项目证据。项目保存去除坐标的 `verification.json`、源码哈希与构建/测试记录。手机独立 App 留在 build 5，正式 App 仍未更新；没有后台测速或临时服务持续运行。
