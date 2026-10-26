# 2026-09-26 单 iPhone + Watch 非救助真机检查

## 本轮收尾结论

**已通过本轮“iPhone 已运行后锁屏、Watch 前台”的通信与绑定恢复样本。** 用户确认 Watch 显示“连接正常”，iPhone 在后台处理新握手，服务器21:08:14更新 Watch 绑定，把过期租期续到21:21:32。此前“暂未连接”已由用户澄清为手机设置页文案，不能据此判定手机锁屏后 Watch 无法传递信息。

**用户随后纠正验收标准：系统设备连接条件成立时，两端 App 的业务连接不应因退后台、息屏或锁屏而中断，不应要求重新打开 App。** 因此撤回此前“问题仅收窄为手机状态表达”的结论。上面的真机样本继续有效，但仅是窄场景成功，**整体持续连接要求仍未满足**，不能靠改“已连接”文案验收。

后续静态检查确认：目前只有即时 RPC、没有 WC 后台投递接收路径；Watch relay 的 expiresAt 跟随手机短期会话，过期且不能恢复时，`ensureWatchSessionIsUsable` / `refreshMonitoringGate` 会失效绑定门禁并停止监控。这是传输与生命周期的实现缺口，不只是 UI 语义。需要分离持久绑定、监控许可和临时上传凭证，补充后台投递/恢复/业务 ACK，保留授权和撤销门禁。本阶段只更新要求与诊断文档，没有修改业务代码、部署或重新测试设备。

## 本轮范围

- 用户要求开始全 App 真机业务测试，随后明确目前只有一部 iPhone，并选择先测登录、定位、Watch 连接等非救助业务。
- 使用现有物理 iPhone 17 Pro 和 Apple Watch；不用模拟器、屏幕镜像或开发镜像/DDI，不触发 Fall Detection、Emergency SOS，不创建真实或模拟救助事件。
- 只读查看服务/数据库、普通 USB 日志与用户现场操作。未退出登录、撤回协议、注销账号、修改权限、部署后端或安装新包。
- 本次先记录问题，不将本地构建/单测、历史双机记录或 UI 文案当作本次业务验收。

## 基线（时间为 Asia/Shanghai）

- 20:51：USB 中只有一部 iPhone，iOS 27.2，已安装 `dev.codex.aedresponse`，build `2`。该版本号没有递增，不能单靠 build 号区别此前同号安装；安装沿用上一轮已确认的包，见 [Watch 修复证据](../watch-relay-2026-09-26/README.md)。
- Azure current 为 `watch-relay-20260926-r1`，`aedresponse.service` active/running、NRestarts=0，公网 health 200。
- 当前 SQLite 仍有 4 个历史 `SIMULATED_TEST` 事件，全部终态；当前测试手机/Watch 没有关联进行中事件。
- 手机通过已绑定 Watch 的 `watchRelay.iPhoneDeviceId` 定向关联，未复用旧双机测试账号映射。存在有效手机设备会话、四项同意；上报 capabilities 中定位/通知均开启。
- 20:51:36 定位 `R` 已写入服务器，fix 时间 `12:51:36.414Z`，服务接收 `12:51:36.526Z`，水平精度约 32.9 米。20:53:41 再收到新位置。仅证明实际采集/上报，不能替代地图位置正确性或后台长时验收。
- 线上只有 `aed-demo-01/02` 两条测试 AED，不是真实 AED 资产目录。

## 用例进度

| 用例 | 当前结论 | 证据及边界 |
| --- | --- | --- |
| 已有登录/业务会话 | 部分通过 | 有效设备会话、权限/同意和新定位写入；本轮未重新执行 Apple 登录。 |
| 前台定位上报 | 通过本轮样本 | 多次新 `R` 写入；20:55:41 新样本精度约 21.2 米。用户现场确认地图位置大致正确。 |
| 双前台 Watch 消息 | 通过本轮样本 | 用户报告已连接；20:52:18、20:52:28 等真实 WCSession 请求获匹配回复，传输回执 `kNoErr`。不代表跌倒/救助事件已测试。 |
| iPhone 锁屏 + Watch 前台 | 通过本轮定向样本 | 用户只观察手表并确认“连接正常”；21:08:10手机入后台后，21:08:14服务端更新绑定，已过期租期续至21:21:32。 |
| 短暂 iPhone 后台收发 | 有正向片段，不足以关闭上项 | iPhone 20:53:13 进入后台，20:53:18/22/33 有 WCSession 回复成功，20:53:44 回到前台。不能据此断言持续锁屏/挂起恢复通过，也不能断言后台完全不支持消息。 |
| Watch 退后台后的状态显示 | 待确认语义/体验 | 用户报告两端 App 未打开时不显示已连接；代码依赖即时 `isReachable` 与近期消息确认，不是永久绑定状态。 |
| 待命页/附近地图 | 用户现场确认通过 | 第 3 轮用户回复“没有，显示都是正确的”：待命、位置、地图无所问异常；未点击“上报发现的患者”。 |
| 地图/列表与范围圈开关 | 用户现场确认通过 | 用户回复“全部正常，开关已恢复开启”；人数一致，关闭范围圈后仍保留当前位置。 |
| 账号/权限显示、同意记录与协议阅读 | 未执行，用户收窄范围 | 用户回复“现在的问题就是 watch 和 iPhone 的连接问题”，停止其他界面用例，不把请求过的操作标为通过。 |
| 后台提醒登记 | 阻塞 | 服务器当前手机没有 pushRegistration；客户端有 `POST me/push-token`，实际运行 release 的 source/dist 均无该路由。不能将“通知权限已开启”当作推送可用。 |
| 独立 Watch WAN 备用认证 | 本轮未测，前轮已阻塞 | 前轮缺 build extensions 的 401 未绕过；不得用主链路已连接表示备用可用。 |
| 新登录、权限拒绝/恢复、冷启动 | 未执行 | 后续逐项操作，不清除身份/历史以强行通过。 |
| 持续后台定位、网络切换 | 未执行 | 需要独立时间窗口和服务器新记录对账。 |
| 招募/接受/拒绝/导航/AED 回执/结束 | 本轮不执行 | 用户明确非救助范围，且无第二部手机。 |

## 问题证据

1. **状态与后台恢复需分开验收。** Watch 标题表示已绑定，不能替代消息确认。`DeviceServices.swift` 在系统不可达时清空近期消息确认；Watch reporter 同时要求可达、绑定有效及 25 秒内回执。代码没有仅因 iPhone scene 进入后台就主动 deactivate 的路径。当前日志有后台成功片段，但用户所见状态异常的完整因果链仍未获得。
2. **线上/客户端版本功能不齐。** 实际服务由 `dist/src/main.js` 启动；其 source 和 `dist/src/server.js` 都缺少 `me/push-token` 和通知回读路由，而手机的 `APIClient.registerPushToken` 使用该新接口。USB 日志在20:52:16、20:53:44 记录 HTTP 404，但 URL 被系统隐去，因此不把这些具体请求未经证明地归因到某条路由。本轮未补部署。
3. Apple 官方说明 Watch 主动 `sendMessage` 可唤起 iPhone 后台执行，反方向不会唤起 Watch；所以不能以“必须双前台”概括平台能力。[Apple sendMessage 文档](https://developer.apple.com/documentation/watchconnectivity/wcsession/sendmessage(_:replyhandler:errorhandler:))
4. **后续救助测试还有部署前置条件。** 路由静态对照发现线上也缺少客户端“上报发现的患者”所需的 `POST /api/v2/events/found-patient`。本轮只记录已部署代码缺口，未点击入口、发送请求或创建事件。不能在未来仅凭手机有按钮就开始全业务验收；也不能为此把全部脏工作树自动发布。

## 聚焦连接后的静态结论

- 已确认：手机 `SettingsView.watchConnected` 要求 `watchReachable && messageVerifiedAt != nil`；`IPhoneCompanionConnectivityActivator.publishState` 在系统不可达时立即清空近期确认，另有 30 秒超时。Watch reporter 则要求当前绑定有效、系统可达及 25 秒内的应用回执。
- 已确认：Apple `isReachable` 描述的是即时消息能力，Watch App 通常需前台或高优先级后台执行；它不是系统蓝牙配对/永久绑定的同义词。普通 Watch 后台状态可令手机端显示“暂未连接”，仅这一个显示不能确定跌倒上报失败。[Apple isReachable 文档](https://developer.apple.com/documentation/watchconnectivity/wcsession/isreachable)
- 已确认：两端当前是 `sendMessage` RPC，没有 `transferUserInfo` / `didReceiveUserInfo` 背景传输接收路径。Watch 已有持久 outbox，但重试依赖 App 获得执行时间时的生命周期与心跳；不能错误描述为没有持久队列，也不能把进程内心跳当系统后台调度保证。
- 已确认：iPhone 进入 background 的 scene 回调没有主动 deactivate；认证和 Watch relay Keychain 均为 `AfterFirstUnlockThisDeviceOnly`，不能在没有证据时归因“锁屏后密钥必定不可读”。
- 后续澄清：用户确认“暂未连接”在手机设置页。此前不构成 Watch 在手机锁屏时失败的证据。已确认手机 UI 把即时可达状态直接用于“已连接”；系统日志只有传输结果，尚不能据此给后台业务握手通过结论。不更改安全门禁或连接显示来强行验收。

## 证据保存

- 临时 USB 日志：`/tmp/aed-real-device-business-20260926.MFyGnY/iphone.log`。保留在本机，不将原始敏感诊断日志加入仓库。
- 数据库使用 `sqlite3 -readonly`，只输出能力/时间/计数及脱敏摘要，不输出 token、Apple 账号或精确坐标。
- 本轮没有业务源码修改、提交或 push。后续结果追加到本文，完成或暂停时停止临时日志采集。
- 第一段 USB 日志已停止，SHA-256 `ef354c3ed95d0c04ed62efa76e44e54f685af22c133dcb4d02dd84c6a9c5ffca`。共 15 个 WCSession 请求和 15 个系统层回复成功；没有应用层 RPC status 日志，不把系统 `kNoErr` 单独等同业务成功。
- 用户确认未连接提示在手机设置页后，停止其他用例并进行独立复测：`iphone-locked-recheck.log` 为第二段 USB 日志。21:07:46 基线为旧 Watch 绑定租期已于 21:00:28 到期，Watch lastSeen 仍为20:45:29；手机21:06:32已 bootstrap。此次若在手机锁屏时成功续绑定并在手表显示连接正常，将比仅看旧 ping/手机文案更有证明力。未创建任何事件。
- 第二段结果：用户明确回复“手表显示连接正常”。iPhone 最后一次生命周期变化为21:08:10进入后台，采集至21:09:29未再记录前台；21:08:14收到 context/bind 尺寸的新握手及 HTTP 200/回复，后续有 ping 尺寸消息。21:09:32只读数据库确认 Watch lastSeen=`13:08:14.529Z`、expiresAt=`13:21:32.166Z`，绑定尾部标识与基线一致；手机后台新位置于21:08:35写入。仅据尺寸不单独判定 RPC method/status，最终以用户 Watch 状态与服务端绑定更新交叉确认。
- 第二段共6个请求和6个系统回复成功。日志已停止，SHA-256 `0804c4416e826b7cda2dbec71a1c48d7c65a093b9fef040381a08c6707f134d4`。收尾服务仍 active/running、NRestarts=0；事件总数仍4、ACTIVE=0。`git diff --check` 通过，未运行新构建/单测（业务源码未修改）。
