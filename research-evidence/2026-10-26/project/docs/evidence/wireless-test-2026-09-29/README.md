# build 10 安装与无线测试准备记录

## 2026-10-04 用户确认

用户明确“之前测试过的可以算通过”。本记录中此前已执行的测试按用户确认记为通过，不重复基础连通性、拔线及独立通知检查；以下原始证据和其技术范围保留。未执行的业务场景单独继续，不由此扩大为全业务验收完成。

## 2026-10-01 最新状态：拔线期间手机后台通信已有成功证据

- 用户继续测试，普通USB重新识别原目标手机；独立安装列表读回AEDResponse2.0(10)，没有重新安装或改业务代码。保留Watch模拟页面，不点击模拟跌倒、不创建救助。
- 用户按本轮步骤完成并回复“已接回”：iPhone锁屏、Wi-Fi/蓝牙开启，不要求先打开手机App；拔线后Watch回表盘45秒、只重开Watch约20秒，然后接回USB。锁屏和Watch操作依用户反馈，手机后台状态另有日志佐证。
- 普通USB每2秒只读观测：13:31:44.222首次未发现、13:33:03.018最后未发现、13:33:05.030重新发现。自动普通日志回读13:33:20完成，命令exit0，无镜像/DDI。
- 仅统计保守内窗 **13:31:50–13:32:58** 的AEDResponse/CompanionRelay固定字段，不包括接回之后的成功。13:32:33.361、13:32:45.394后台ping回复ok，13:32:33.567、13:32:45.500系统确认回复传输成功；全为appState2。日志见 `unplug-background-20261001.log`。
- 初始13:32:30.775即时和随后3条后台回复为unavailable，至13:32:33.361恢复ok，间隔2.586秒。没有要求手机App回前台。对应时间窗未找到固定`AED Companion gate`诊断行，不能唯一归因为认证恢复或网络；短暂不可用是实测事实，不隐去也不称零延迟常连。
- 此结果支持**无USB连接时，手机后台接收处理Watch消息并完成系统回复传输**。不证明底层只使用Wi-Fi而非蓝牙，不等于服务器每次收到ping，也不证明持续常驻/Watch应用层已消费/真实跌倒/锁屏通知。无requestID，11行记录不能算11次独立往返。
- 13:30:30服务器只读预检仍7历史事件/0ACTIVE、active/running、旧release、APNs变量不存在；本轮未部署、推送、开run或写库。下一业务验收是隔离的锁屏模拟跌倒与通知，需要先补齐其前置条件，不能由本次连通性结果代替。
- 独立校核得到相同11条记录分类及时间边界；2.586秒是日志中首次不可用至首次成功的间隔，不是完整业务恢复耗时。原始tar及展开归档已精确删除、不留恢复副本，保留脱敏App记录和USB时间线；手机数据未修改，采集已结束。

## 2026-09-30 最新状态：两端安装与启动通过，通信有成功样本

本节覆盖下方 9 月 29 日“尚未安装”的历史结论。

- 手机重新通过普通 USB 通道可管理；network 列表仍为 0。安装前读回 iPhone18,1 / iOS27.2、AEDResponse 2.0 (8)。没有把 USB 连接算作无线业务验证。
- 昨日 `/tmp/aed-device-test-20260929.dWAcaY/` 的 App 已不在原位置。本轮保持源码与 build10 不变重新构建，未重新修改业务逻辑或项目版本。
- 第一次将 DerivedData 放到桌面项目下的 ignored `.build/DeviceAcceptance-10.VGl3Ph`，Watch CodeSign 返回 resource fork / Finder information 错误；产物根目录实际有 com.apple.FinderInfo 与 fileprovider 属性。保留失败日志，不清理项目扩展属性，不手工绕过签名。
- 将唯一变量改为桌面之外的本机缓存 DerivedData，重新构建成功；随后 iPhone、内嵌 Watch、独立 Watch 三 bundle 各自严格验签成功，均为 build10。手机 profile 包含当前目标设备、Time Sensitive=true；Watch profile Fall Detection=true，期限仍有效；手机中英文 Login.strings 均存在。
- 普通 `ideviceinstaller install` 覆盖安装完成（InstallComplete 100%、Complete、exit0），安装后独立 list 读回 **dev.codex.aedresponse 2.0 (10)**。没有卸载或清理登录/业务数据；用户随后确认直接进入主页面。
- Watch 11:01:03 的 placeholder 不作为成功；**11:01:14 Finished install →11:01:15 installed → acknowledged** 是实际安装完成证据。回执中的 executable SHA-256 `406df8b22ea90b9203a4dbd6043b161e8b58c5d5f110a74b58250e9b8bd546c7` 与本轮 build10 Watch 可执行文件逐字匹配。
- 服务端本轮重新只读核验：current 仍 watch-simulation-20260927-r1，服务 active/running、NRestarts0；代理及主任务分别只读聚合确认 7 个历史事件、0 ACTIVE。进程 APNs 配置仍不存在。没有部署、重启、新建测试身份、推送或创建事件。
- 用户已确认“手机直接进主页面，手表正常打开”，随后补充手表显示“模拟跌倒”。这是本包显式保留的受控测试入口，不是已触发事件；没有要求或观察到点击。该反馈支持本次升级后未要求重新登录、两端可启动，不替代后台通信证据。
- `connection-replies.log` 记录 11:03:59–11:04:01 初始 ping 为 unavailable；11:04:01.884 后台投递路径在手机前台 appState=0 回复 ok，11:04:04/20 即时 ping 也为 ok；11:04:38.105 有 **background reply method=ping status=ok appState=2**。这是 build10 的一次手机后台成功样本，不能据此认定持续双后台或无线全链路验收通过，也未将初始 unavailable 唯一归因。
- 第2轮请求手机锁屏、Watch前台30秒。用户反馈“看不到报错信息，现在只是在模拟跌倒界面，连接界面看不到”。核对 `AEDResponseWatchApp.swift` 确认 DEBUG + AED_WATCH_SIMULATION 分支替换正常连接页；不能要求用户在此页寻找连接状态。用户已选择“保留模拟入口，用日志继续测”，本轮不切换构建或重设计界面。
- 第2轮 `lockscreen-replies.log` 共11条回复日志，其中7条 `background reply method=ping status=ok appState=2`，0条非ok；首末后台样本为11:06:21.097890和11:09:00.834531。它们证明手机后台处理请求并生成成功回复；immediate/background可能属于同一请求，不能算成11个独立往返，也不独立证明Watch应用已消费回复。采集已停止，exec72346正常退出。
- 当前日志只有手机applicationState，没有Watch场景状态；用户没有另行明确记录锁屏起止时间，不能以该样本宣称持续双后台、精确锁屏时长或拔线Wi-Fi验收通过。`.ping` 在有效绑定缓存内本地回复，并非每次请求服务器；不得用服务器Watch lastSeen不变判失败。
- 第3轮用户已回复“已完成”：按要求保持手机锁屏，Watch回表盘约45秒再只打开Watch约20秒，不划掉App、不点击模拟跌倒。手机场景由日志证明，Watch场景来自用户操作反馈；没有独立Watch场景日志。
- 原实时采集分别于11:16:59/11:16:25到时停止，均退出0。reply日志捕获11:16:56的即时和后台ping ok，但transfer采集结束早于该消息，不将其空白当作传输失败。
- 随后通过普通 `idevicesyslog archive --start-time 1790738190` 回读短期历史成功（未使用DDI/镜像），本机 `log show` 严格筛选AEDResponse/CompanionRelay固定状态字段。11:16:56、11:17:08、11:18:11、11:19:16均有手机后台接收与ping ok，随后分别有 `background response transfer succeeded=true appState=2`。脱敏记录见 `background-resume-20260930.log`。这支持本轮锁屏后台恢复到系统传输完成层级；现有日志无requestID，不能严格逐请求关联，也不宣称Watch应用层消费或救助服务器ACK已验证。
- 临时全设备归档不纳入项目证据；仅保留上述脱敏App记录。下一步拟拔线后按同样步骤恢复Watch，再立即接回并回读拔线窗口；拔线不自动等于服务器流量走Wi-Fi，不能据此区分Apple底层蓝牙/Wi-Fi选路。
- 全设备tar及展开归档已从本次私有缓存精确删除，不留恢复副本；手机数据未动。11:25:32之后普通USB/network均未发现目标设备，等待用户确认是否主动拔线；第4轮尚未开始，管理通道断开不等于App业务断线。全部限时采集已结束。

本轮产物和日志目录：

`[BUILD_CACHE]/build10-20260930.iIvOdD/`

- `Signed/Build/Products/Debug-iphoneos/AEDResponse.app`：实际安装的手机包。
- `Signed/Build/Products/Debug-watchos/AEDResponseWatch.app`：与 Watch 安装回执 hash 对齐的独立包。
- `build-signed10.log`、`install-build10.log`、`watch-install.log`：本轮构建/手机安装/Watch 安装证据。
- `connection-replies.log`：首轮仅 AEDResponse 进程且含 reply method 的通信结果，已结束；没有 token 或坐标。
- `lockscreen-replies.log`：第2轮采集已停止，11条回复/7条手机后台ok/0非ok；无请求ID，不能严格去重往返。
- `resume-replies-1790737919506.log`、`resume-transfers-1790737945805.log`：第3轮手机后台恢复采集，仅安全的回复状态和系统传输完成字段；超时后须开新时间窗，不用旧日志冒充新操作结果。

签名错误依据：[Apple QA1940](https://developer.apple.com/library/archive/qa/qa1940/_index.html)。当前处理是更换生成目录后正常重建，不修改证书、profile 或源码资源，也未使用 Simulator/镜像/DDI。

## 2026-09-29 历史状态

用户要求开始通过 Wi-Fi 测试，仍禁止镜像、Simulator、DDI、真实 Fall/SOS 和外部招募。本轮只做设备/服务只读核对及最新源码签名构建，没有创建模拟事件、安装 App、部署或重启服务器。

开始时普通设备管理通道为 USB 1 台、network 0 台；设备型号 iPhone18,1 / iOS 27.2，已安装 dev.codex.aedresponse 2.0 (8)。CoreDevice 同时列出 iPhone 17 Pro connected、Watch available (paired)。**这是 USB 管理证据，不是 Wi-Fi 安装或业务互通证据。**

构建期间再次读取手机状态得到 Device not found；随后独立复核 USB 0 台、network 0 台。没有执行安装命令。已请求用户接回并解锁手机，保持到安装完成后再拔线；如果本次只能使用 Wi-Fi，则需要手机当前局域网 IPv4 地址继续定向排查。此前询问是否有进行中救助，后来已由服务端只读聚合确认 ACTIVE=0。

## build 10

- 9 月 27 日已签名 build 9 不含次日的登录 UI/启动跳过；9 月 28 日最新 Debug/Release build 9 均未签名，不能拿旧 Signed 包验收新界面。
- 本轮仅将 ios/project.yml 的正式 iPhone/Watch CURRENT_PROJECT_VERSION 9→10，并执行 XcodeGen；生成工程对应四个 configuration 的版本号同步。保留全部既有 dirty changes，没有改业务逻辑。
- 从当前源码做全新目录 Debug 签名构建，显式传入 AED_WATCH_SIMULATION_CONDITION=AED_WATCH_SIMULATION，保留获准的测试版入口；没有开启服务器测试许可或点击入口。默认构建开关仍为空，Release 仍受 DEBUG 门禁保护。
- xcodebuild BUILD SUCCEEDED；iPhone、嵌入 Watch、独立 Watch 分别 codesign --verify --deep --strict 成功。
- iPhone 和 Watch 均为 2.0 (10)，手机 developmentRegion=zh-Hans；构建日志确认编译 LaunchECGView / LaunchPresentationPolicy。
- 手机 profile 包含本轮目标设备，development APNs 与 Time Sensitive=true；Watch profile 包含 Fall Detection=true。profile 分别到期于 2027-09-27、2027-09-20。本轮未刷新或更改开发者后台 profile。

路径：

- 工作目录：`/tmp/aed-device-test-20260929.dWAcaY/`
- 构建日志：`build-signed10.log`
- 安装候选：`Signed/Build/Products/Debug-iphoneos/AEDResponse.app`
- 独立 Watch：`Signed/Build/Products/Debug-watchos/AEDResponseWatch.app`
- 本轮前配置快照：`baseline/project.yml`、`baseline/project.pbxproj`

构建命令（工作目录 ios）：

```sh
xcodebuild -project AEDResponse.xcodeproj -scheme AEDResponse -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/aed-device-test-20260929.dWAcaY/Signed -clonedSourcePackagesDirPath .build/SourcePackages -disableAutomaticPackageResolution -skipPackageUpdates DEVELOPMENT_TEAM=[TEAM] AED_WATCH_SIMULATION_CONDITION=AED_WATCH_SIMULATION build
```

## 本轮服务器只读核验

- current 仍为 `/opt/aedresponse/releases/watch-simulation-20260927-r1`，通知候选尚未切换。
- aedresponse、caddy 均 active/running、NRestarts=0；本机和公网 health 均 200。
- SQLite 使用 readonly + query_only 聚合：历史事件 7、ACTIVE 0、未知状态 0；未读取或输出患者令牌/精确坐标。
- 服务进程 AED_APNS_* 数量为 0，服务配置未发现这些变量名称；没有读取输出密钥值。不能把 health 200 或签名推送权限算作 APNs 已可用。

## 下一步与证据边界

1. 普通通道重新识别目标手机；保持数据与登录，通过签名包覆盖更新，再查询 installed build=10。
2. 通过普通安装日志或用户现场确认核对 Watch 真正安装完成；手机内有嵌入包不等于手表已更新。
3. 先做非救助 UI/连接检查，再拔线区分 Wi-Fi 管理连接与 App 自身网络，验证手机锁屏、Watch 状态及真实后台消息。
4. 新模拟事件必须重新核对隔离授权；旧 r4 已过期。完整锁屏通知业务仍需后端候选与 APNs 配置，不在本轮擅自发布整棵工作树。

本轮没有实机业务通过项，不把准备、签名或发现设备记作验收通过。没有提交、推送、PR 或后台持续日志采集。
