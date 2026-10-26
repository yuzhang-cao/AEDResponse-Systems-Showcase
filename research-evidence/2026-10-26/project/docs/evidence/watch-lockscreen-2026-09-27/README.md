# 后台触发与锁屏提醒：实现记录

## 2026-10-04 验收安排更新

用户明确确认“之前测试过的可以算通过”。此前已执行的连接、后台通信与独立通知测试按用户确认记为通过，不再重复发送独立测试通知；历史记录保留，不补写未记录的显示设备位置。

后续只继续未完成的**手机锁屏时Watch模拟跌倒→iPhone中转→服务器事件→提醒与结束**。这与独立非救助通知测试不同；未执行的真实系统Fall/SOS、独立Watch WAN、完整AED领取/送达不会因此被标为通过。

### 22:34 本轮结论：已收尾，性能故障阻断完整验收

- Watch原始测试点击时间22:15:10.798，服务器创建22:15:32.888，精确phone/watch/run均匹配；模拟事件在22:28:06.570正常结束为`RESOLVED / PROBLEM_RESOLVED`，当前0ACTIVE。
- 两虚拟响应者的请求超时，邀请到期且无assignment；本轮接单/导航/AED未完成。patient-activated推送多次TRANSPORT重试后变为SUPPRESSED，无Watch最终ACK或屏幕通知确认。完整锁屏业务不能标通过；22:18采集的appState1仅为inactive，不是后台执行证明。
- 登录随后出现503。停止虚拟客户端自动请求后，健康检查从3–5秒降至0.35秒；用户只重试一次后确认进入主页面。公钥网络及部署版解析器独立探测均约1秒成功，但原503内部原因未被日志分离，不能唯一归因CPU。
- 私有离线副本复现3次空事务耗时128–148ms，仍反复clone/validate/flatten历史状态；0次SQLite提交。性能开销已证实，尚未修改/发布修复。原始临时数据库副本已删除，仅留脱敏指标，线上历史和备份保留。
- 两虚拟身份已按原清单关闭待命并注销，所有会话/refresh撤销；无外部收件人、未改物理绑定或用户账号。普通日志采集和runner均已停止。接下来优先修服务端性能，不继续要求用户逐步重复测试。

### 22:05 本轮准备状态

- r5限时隔离窗口已配置，截止北京时间23:13:48；同一真实iPhone/Watch及两名虚拟响应者，不涉及外部用户。
- 当前release未变，重新载入本轮配置后健康检查200；主认证/APNs配置保持不变。准备时0ACTIVE。
- 两名虚拟响应者已完成初始连接、位置和heartbeat，状态均为`WAITING_FOR_WATCH`。事件尚待用户在锁屏后从Watch单击发起，不通过服务器代造事件。
- 普通USB白名单后台日志采集已开始，用户已收到锁屏点击步骤；仍待实际触发、Watch服务器确认、提醒呈现与结束证据。本条只记录测试准备，不宣称业务通过。

### 22:12 用户操作后的自动核查

用户确认已完成上述动作。22:08和22:09两次精确查询均无r5事件、全库0ACTIVE。普通手机历史日志在22:05–22:10:20得到10条固定字段记录，见`locked-attempt-r5-20261004.log`：后台context/bind/ping与系统回复传输成功，但未捕获simulationContext/simulationObservation。只证明连接恢复，不证明模拟跌倒成功，也不能据此否定用户点击。

仍需Watch当前提示以区分模拟入口/权限/绑定恢复/点击意图等门槛；未要求用户重做或解锁手机。没有再发独立通知、重装App或修改业务代码。后续流程改为尽量自动核查，只向用户收集工具无法取得的实机观察。

## 2026-10-01 14:07 更新：通知服务已发布，等待手机推送登记

- 用户提供APNs私钥文件后，仅在内存校验EC/P256和签名自检，未输出内容；Mac原下载文件权限收紧600。当前App签名团队及development环境已核对。尚无真实APNs接受或设备通知展示证据。
- 基于实际线上watch-simulation-20260927-r1重新生成限定候选，没有整树发布canonical未验收变更。Mac与VM均编译成功、通知/模拟定向24/24、原基线完整463/463、契约smoke5/5。服务器现为 `lockscreen-notifications-20261001-r1`，内外health200；不改固定登录30天、没有新建救助事件。
- 部署前SQLite备份通过integrity_check，候选解析其私有验证副本成功（7历史/0ACTIVE）。备份在 `/var/lib/aedresponse/backups/pre-apns-20261001-26ZG85W23U.sqlite`，未倒回数据库或删除历史记录。
- 原 `/etc/aedresponse` 为root/700，保持不变；密钥改放专用 `/etc/aedresponse-apns`（root:aedresponse/750），文件640，以真实服务身份读取并解析成功。服务进程使用SANDBOX。转移临时私钥副本与数据库验证副本已清理；正式密钥、Mac原件和备份保留。
- **目标iPhone尚未登记push token**：当前只读 `pushRegistrationPresent=false`。已请用户打开手机App前台10秒后锁屏、不退出登录、不点模拟跌倒；下一步核对该指定设备登记、实际APNs结果及设备呈现，不能把配置完成当投递验收。
- 兼容回退：保留当前新解析器，通过 `/opt/aedresponse/operations/disable-apns-config-20261001.mjs` 备份并移除APNs配置后重启；不简单切回旧代码或恢复旧DB。新release的Linux node_modules目前引用原release目录，旧release必须保留，清理前先处理该依赖。
- 本轮中间证据在Mac `Library/Caches/AEDResponseDeviceBuilds/apns-candidate-20261001.N2KoQ3` 及服务器 `/var/tmp/aed-apns-20261001.d9McHw`，均不包含项目仓库内私钥。

## 2026-10-01 更新：连接验证已推进，完整锁屏业务仍待密钥和限定部署

- build10已实际装到iPhone和Watch，用户确认启动；9月30手机后台通信、10月1拔线窗口内后台接收/回复/系统传输成功证据见 `../wireless-test-2026-09-29/README.md`。这些结果不替代跌倒服务器ACK和通知显示验收。
- 10月1主线程重新只读确认线上7历史事件/0ACTIVE、仍运行watch-simulation-20260927-r1；APNs五个配置变量均不存在。旧r4的 `run.expiresAt` 为2026-09-27T04:29:57.638Z，不能沿用。
- 下面记载的9月27 `/tmp/.../candidate` 现已不存在。历史463/463、24/24等结果不能当作今天候选仍可用；须重整限定候选并重新验证，不能发布整棵脏工作树。保留通知存储格式兼容回退约束。
- 常用下载目录仍未找到.p8；浏览器控制再次超时，未新建/下载任何密钥。已请用户按现行Apple官方说明手动下载APNs专用Sandbox/Topic Specific/dev.codex.aedresponse密钥，不撤销旧钥、不在聊天粘贴私钥。实际build10签名包aps-environment读回development。没有进行新模拟、部署或推送。

## 范围与授权

用户要求补齐后台 Watch 触发、iPhone 锁屏提醒；确认原生通知视觉方案。只允许既定真实 iPhone + Watch 和隔离测试身份，不能触发系统 Fall/SOS、联系外部人员、使用镜像/Simulator/DDI。正式视觉文案与受控业务测试标记分开。

上一轮 r4 `REDACTED-ID-0045` 已由用户结束；服务器只读核验 `RESOLVED`、7 个历史事件、0 个 ACTIVE，两名虚拟响应者不可参与，0 个外部邀请/通知。本轮没有创建新救助事件。

## 已实现

1. Watch 点击意图先存入受保护存储，再请求受控授权。后台回复、执行机会恢复和进程重建后自动续接；保存原点击时间，不再需要第二次点击。过期、换账号、测试窗口改变均拒绝迁移旧事实。
2. coordinator 在发现已落盘 outbox 时不重新采样/覆盖；最终 ACK 仍是事件 ID + 原始字节摘要匹配的服务器确认。
3. iPhone 后台接收后可调度原生本地通知。`received` 和 `activated` 分开，服务器 ACK 返回终态不能重新显示活跃救助。通知发送失败不伪造/撤销业务 ACK；重复消息、冷启动及账号切换有去重/清理保护。
4. 冷启动通知点击不再在登录恢复期间丢弃；点击后通过当前账号 REST 读取，不在锁屏直接修改业务。
5. REST 恢复、事件位置队列及 presence 不再把 Socket connected 当作可用前提；仍要求有效账号、权限、设备会话和 REST 确认的位置写入窗口。
6. 后端 APNs 改为实际 HTTP/2；时效性级别、短文案、过期时间、事件合并、业务阶段去重。位置 tick 不生成用户提醒，未确认 AED 送达不能推断为已送达。
7. Socket 与 APNs 的进度和重试分离，已完成 Socket 的消息允许仅推进推送发送记录，不改变原消息/Socket 完成证据。APNs 网络在独立串行 worker 中处理，不能拖住 Watch 上报 HTTP ACK。
8. token 登记返回 `providerConfigured`；只存下 token 但缺服务端密钥时，iPhone 不显示远程提醒已就绪。
9. iPhone 的 Time Sensitive entitlement 已通过 Xcode 正常更新签名配置；不申请/冒充 Critical Alerts。

## 构建与本地证据

工作区：`[PROJECT_ROOT]`。
中间证据：`/tmp/aed-background-lockscreen-20260927.bSiSbg/`。

- Watch/Foundation SwiftPM：56/56，包括仅后台通道、重建 reporter、原点击时间、授权/过期隔离与通知去重策略。日志 `swift-all.log`。
- 本地后端最终完整回归：728/728，含慢 APNs 不拖住 Watch HTTP ACK 的回归，见 `backend-nonblocking-full.log`。
- 含上述慢 APNs 用例的定向 HTTP/推送回归：24/24，`nonblocking-push.log`。
- iPhone + Watch Debug build 9 签名构建通过，`signed-build-final2.log`。iOS TestHost/XCTest `build-for-testing` 通过，`tests-compile-final.log`，这是编译，不是真机 XCTest 执行。
- Release 即使显式传入模拟编译条件，也不启用 DEBUG 测试入口；Release 构建日志 `release-final.log`。
- 契约 smoke 5/5，`contract.log`；`git diff --check` 通过。

## 线上候选与未完成验收

没有直接发布整个 dirty checkout。基于当前线上版本的候选位于 `/tmp/aed-background-lockscreen-20260927.bSiSbg/candidate`，只回移通知接线、存储兼容及测试窗口校验，保留线上原存储/账号行为。候选编译、原有 463/463 和新增定向 24/24 已通过，见 `candidate-final.log` / `candidate-nonblocking.log`。

**尚未发布候选，尚未把 build 9 安装到设备，尚未完成锁屏实测。**

- Mac 当前没有 USB iPhone。已请用户接回并解锁，Watch 放在旁边。
- 已搜索 Mac 与服务器常见/隐藏目录，未找到 APNs `.p8`；线上无 APNs 配置。用户允许协助新建且不撤销旧密钥，但浏览器控制连续超时，未创建任何密钥。已请求用户通过 Apple 开发者后台下载 `Sandbox / Topic Specific / dev.codex.aedresponse` 的新密钥，不要求在聊天发送内容。
- 新持久化 push 字段/状态不被旧严格解析器识别。部署前必须准备兼容解析器的回退包；一旦写入新格式，不得仅切回旧 release 或回滚数据库抹掉新证据。故障时优先关掉 APNs 凭据接线、保留新解析器。
- 下一轮须从真实 Watch 一次点击开始，手机先锁屏且不再解锁，检查 phone `appState=2` 接收、服务器事件、最终 Watch ACK、系统通知及解锁后 REST 页面；另测短断线、access 过期及重复传输。受控入口不算真实系统 Fall 检测/独立 Watch WAN 验收。
- r4 没有 FETCH_AED 任务，仍不能宣称完整 AED 领取/送达闭环已实机通过。

## 系统限制

普通锁屏/后台不能成为要求手动打开 App 的理由；用户强退、设备重启后未首次解锁、断网和系统后台调度不具备任意时刻零延迟保证。Time Sensitive 可被用户关闭，不能当成绕过静音/勿扰的 Critical Alerts。

Apple 默认把通知送到 iPhone 或 Watch，而不是同时两端响铃；佩戴并解锁 Watch 时，锁屏 iPhone 的提醒可能转到 Watch。验收需分清系统路由与业务上报，不得将“系统调度通知成功”写成“手机实际已亮屏”。

官方依据：[本地通知](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)、[时效性通知](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive)、[APNs HTTP/2](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns)、[密钥创建](https://developer.apple.com/help/account/keys/create-a-private-key)、[两端通知路由](https://support.apple.com/en-gb/108274)。
