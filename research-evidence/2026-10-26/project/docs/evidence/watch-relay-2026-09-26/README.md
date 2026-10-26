# Watch / iPhone 互联修复与真机验证

## 已实现

- 使用操作系统配对的 WCSession 做严格消息协议：context → bind → ping，并用相关请求 UUID 验证双向回执。两端显示“已连接”不再只看 isReachable，也不依赖 Watch 的独立 App Attest 成功。
- iPhone 接收原始 Watch 跌倒事实，验证来源绑定、字节摘要、账号/权限和连接代次，然后用自己的设备身份访问专门的中转 REST 入口。原始 JSON 字节不被手机改写。
- 后端把手机中转授权与 Watch 独立认证分开；验证 phone/user/account/watch/pair/binding/expiry/撤权和协议同意。事件事务提交前再次验证撤权，防止在排队期间解绑后仍建事件。
- Watch 保留原有受保护队列。只有服务器成功并且 eventId/原字节摘要/请求 UUID 匹配才确认完成；手机收到、排队或传输完成都不是最终 ACK。
- 重连复用绑定与事件来源，主/备通道共用 eventId 和内容幂等。不重新生成跌倒事实，不清除未确认记录，不迁移他人账户数据。
- 直传仍是单独授权的备用。App Attest 缺失版本扩展继续拒绝；备用失败不清除可用的手机中转绑定，不能声称备用已获认证。

消息契约见 [watch-relay.md](../../../contracts/watch-relay.md)。系统通信 API 依据 [Apple WCSession 文档](https://developer.apple.com/documentation/watchconnectivity/wcsession)。主链路信任经过登录验证的配对 iPhone 的委托，不等同于独立 Watch App Attest 证明。

## 验证结果

- 正式 `AEDResponse` Debug（含 Watch）的完整签名构建通过；三个 bundle 和各自 dylib 的 `codesign --verify --strict` 通过。
- 最新本地后端完整回归 **716/716**，类型检查通过，契约 smoke **5/5**；其中中转服务测试覆盖不同账户/手机、错误绑定、重复/冲突事件、注销/过期、显式解绑、事务排队期间撤权与主/备幂等。
- Watch/Foundation 源码复制到独立本地 SwiftPM 包执行 **23/23**，覆盖真实 RPC 编码、拒绝错误 nonce/内容摘要、无需独立 Watch session 的主链路、断连保留绑定和重启来源稳定。它是纯逻辑测试，不是 Watch Simulator 或物理设备业务测试。
- 旧线上基线候选在 Linux 上 check/build、原回归 **463/463**、新增本地 HTTP 用例 **1/1** 通过。HTTP 用例只用内存状态/本机端口，不向真实服务创建救助。
- 使用实际服务账号预启动通过；期间发现预启动脚本放在私有 home 目录导致不可读，已移至候选目录，未切换失败候选，线上服务未受影响。

## 已部署与安装

- 2026-09-26 20:05 左右（北京时间）切换为 `/opt/aedresponse/releases/watch-relay-20260926-r1`，仅回移本次 6 个源文件的修改/新增模块和测试到上轮 Watch release。未部署整个本地脏工作树、未修改独立验证器或其环境策略。
- 备份 `/var/backups/aedresponse/watch-relay-20260926-r1`：原 release、配置、服务定义、两次一致性 SQLite snapshot、校验和、测试与实际服务账号预启动日志；切换脚本自带失败回退。
- 切换后 service active/running、NRestarts=0；公网 health 200，匿名中转请求 401，未改 SQLite 物理表结构。已存在的 4 个事件保持，不新增救助事件。
- 新版已通过 `ideviceinstaller` 的 USB 标准应用安装通道覆盖安装到 iPhone，结果 InstallComplete 100%，保留数据。包中包含新版 Watch，但不能据此认定手表已同步安装完成。
- 用户明确“不要用镜像”后，没有使用模拟器、屏幕镜像或开发镜像挂载。之前唯一的 Watch 设备读取遇到 DDI 12040/0xe8000076，此后不再尝试该路径。为采用普通安装通道，从 Homebrew 官方源安装 ideviceinstaller 及其必要主机工具依赖；应用依赖未增加。

## 真机验证过程

已请用户在真实 iPhone / Watch 打开 AEDResponse、保持前台亮屏并反馈 Watch 页面。
20:05 后的一次数据库只读核对中，中转绑定数仍为 0；尚无本轮真实双向 ping 回执，**不能将构建/安装/health 200 说成互联通过**。

下一次以新协议绑定记录、手机的“最近消息确认”、Watch 的真实回执状态共同核对。
如果 Watch 仍是旧长文字页面，先确认嵌入包同步更新，不卸载、不清除其队列。
不得触发实际 Fall Detection、Emergency SOS 或真实救助来演示。独立备用认证仍须单独解决。

### 20:09–20:20 闪退定位与真实互联确认

- 首轮真实 Watch 消息到达手机，手机回包后手表闪退。通过普通 USB crash-report 服务保留并复制报告（`--keep`），未删除设备报告、未使用开发镜像。多个报告一致显示 Utility 队列上由 WatchConnectivity 进入 App 闭包，再在 Swift concurrency/libdispatch 检查处 SIGTRAP。
- 已修正本次新增回调隐式继承 MainActor 的问题：提取 Foundation-only `CompanionRPCCompletion`，让 SDK 收到显式 Sendable 的回调，然后才 hop 到 MainActor。保留请求相关性、超时和单次 continuation 完成；权限回调及旧发送错误回调亦明确 Sendable。依据 [Swift 6 迁移文档](https://redacted-host.invalid/migration/documentation/swift-6-concurrency-migration-guide/incrementaladoption/)。
- 补充后台 Task.detached 调用、重复回包/晚到错误回归后，Swift 测试 **25/25**、签名构建通过。20:17:46 手机 appconduitd 明确记录修复版 Watch 安装完成并 acknowledged，属于实际 Watch 安装证据。
- 用户随后确认“不闪退，显示已绑定／连接正常”。服务器只读核对为 **1 个 Watch 中转绑定**，最后绑定时间 20:18:39；仍为 **4 个事件**。结合只有匹配双向回执才会显示连接正常的代码路径，可以确认本轮真实手机/手表互联已建立；没有创建真实跌倒救助。
- 独立备用认证仍在 20:18:32 因 `build-extensions(flags=64,trailingBytes=0)` 被拒绝。它不再阻止手机互联，但不能声称独立 WAN 备用已可用。

### 瞬时断连弹窗修正

用户反馈连接过程中仍出现“配置或上报未完成 / 当前 iPhone 不可达且 Watch 无 WAN”。确认这是旧 `updateStandbyAvailability` 把路径发现/前后台瞬时断连写入通用 `lastError`，并非真实上传失败。

现将其改为非弹窗的连接状态：主链路以应用消息回执为准，备用须同时具备 WAN 和独立授权；无可用路径时保留绑定与队列，页面显示“等待连接”，恢复后回到“连接正常”。不清除或屏蔽真实权限、持久化或业务上报错误。

此项通过原生签名构建、签名校验和源码状态边界检查；已再次通过普通 USB 更新手机和嵌入 Watch 包，20:23:20 Watch 安装服务报告 install done。用户尚未对本次最后的弹窗表现再次反馈，不能冒充已完成这一步现场复核。

20:24:52 安装日志进一步确认最终提示修复版的 Watch 状态为 installed，执行包摘要已更新。临时 USB 日志采集已停止；未留下后台监控。

## 本机证据位置

`/tmp/aed-watch-relay-20260926.QPyEQO/`：签名构建日志、716 项回归、23 项 Swift 测试、原线上源码快照、定向候选、部署/回退脚本、USB 安装日志及仅限定本 App 的临时日志。临时目录不保证长期保留；可复用的契约与测试已在仓库中。

本轮没有提交或 push。用户/其他工作已有的脏改保留；过程中 Watch scheme 出现 Xcode 格式化变更（1.3→1.7 等），未擅自撤销。
