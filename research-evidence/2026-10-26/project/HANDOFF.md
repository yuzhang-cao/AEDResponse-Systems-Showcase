## 2026-10-13 随机模拟路线测速与调度优化

- 用户随后要求随机模拟 AED/患者位置，继续处理算路慢的问题；附近真实 AED 的深圳验收仍延期。本轮独立 build 4 在手机当前位置附近生成固定的 3 个模拟 AED/P，正常 Wi-Fi 直接计时：原版单 AED 301.98/95.50/71.44ms，3 AED 217.17/210.05/302.48ms，所有路线成功。
- 生产 `AppleMapsDirections.swift` 的 calculator 改为腿级补位队列，每轮最多 2 个请求；不再等待同一 AED 的慢腿才启动下一 AED。保留候选顺序、两腿成功规则、最短返回路线语义和后端分配权，不增加缓存或并发上限。`AppleMapsDirectionsTests.swift` 新增 6 项确定性回归；原生 XCTest 15/15、Swift6 检查、正式 generic iOS 构建与 diff 检查均通过。
- 独立 build 5 复用相同场景做原版→优化→优化→原版：346.397/166.666/178.689/164.520ms，四轮 AED ID、分段距离及顺序完全一致。样本少且有缓存影响，不能声称固定提升百分比；当前场景均不足 0.35 秒，先前十多秒含 USB 验收开销。
- [详细证据与本轮增量](docs/evidence/route-speed-2026-10-13/README.md)。精确定位未写入项目证据。未用 DDI/Simulator/镜像，未操作生产或创建真实救助、未提交推送部署；只安装独立验收 build 4/5，正式 App 未重装。8 候选、弱网/蜂窝、冷缓存及业务 HTTP 全流程速度仍待测。

## 2026-10-13 当前位置与附近真实 AED 验收：用户要求到深圳后继续

- 用户改为当前位置 + 附近真实 AED，患者终点选约 300 米演示点。独立“路线验收”build 3 已签名构建、验签和普通 USB 安装；手机定位成功，精度约 5.85m。
- Apple POI 搜索成功但无符合条件候选；本次刷新过的 4 个 OSM 佛山点也均不在手机定位的 3km 内。搜索零结果不是“现实没有 AED”的证明。无真实候选，因此 **未产生任何算路耗时样本**，335ms 是搜索耗时。
- 用户最新决定：“那跳过这一段，等我回到深圳再测试”。已暂停此阶段，不继续地图查询、测试或部署。下次重新取得定位与有来源 AED 后，运行手机内部 ContinuousClock 计时；USB、定位、搜索不计入，单候选/最多 3 候选各 3 轮。深圳既有数据的未知坐标系须先处理。
- 临时 App 的计时实现与精度/数据来源边界见 [本轮记录](docs/evidence/nearby-aed-phone-2026-10-13/README.md)。生产业务源码未改；原始精确定位未写入项目证据。Mac 端反向地理编码曾被自动审批拒绝，未执行或绕过。

## 2026-10-13 iPhone 独立路线验收

- 已完成：在 iPhone 17 Pro / iOS 27.2 安装独立“路线验收”1.0 (2)，复用生产 MapKit helper；上海合成 R/A/P、1 个 AED，两次真实手机返回 260 + 443 = 703m。实际隔离后端确认 FETCH_AED / CLIENT_MAPKIT，AED ID、总距离和 R→A→P 均独立核对一致。用户确认页面通过、高德和 Apple 地图均能正确打开。
- 传输边界：局域网直连报 NSURLErrorDomain/-1004，同 Wi-Fi/权限/监听/防火墙已检查，根因未确认；改走普通 USB 文件桥完成验收，不代表手机 HTTP 直连通过。四轮串行诊断传输首尾约 13.6 秒，不是纯 MapKit 耗时，也不是正式 App 性能结论。
- 导航边界：用户看到较远目的地是固定上海合成点，不是匹配出的附近真实 AED。日志保留患者目标高德/自动 Apple 失败及强制 Apple 成功回调，不把用户“两款均打开”的确认扩写成全部自动回退分支通过。
- 修改与验证：本任务生产业务源码未改，只新增 [验收证据](docs/evidence/mapkit-route-phone-2026-10-13/README.md) 和本交接；generic iOS 构建、系统信任环境严格验签、普通 USB 安装与版本回读通过。未使用 DDI/Simulator/镜像、未连接生产数据或触发真实救助。正式 App build 12 来自并行 UI 安装，本任务只安装 unique routeacceptance 包。
- 清理与下一步：12:01:16 停止临时后端和 USB 桥，token 失效且私有配置删除；手机临时 App 仍在但服务已关闭。当前定位附近真实 AED、最多 8 候选耗时、正式网络联调、真实缺高德/失败回退、AED_ACQUIRED 阶段仍待验收。保持原 dirty work，不自动提交/推送/部署。

## 2026-10-08 手机 MapKit 算路、后端确认、导航高德优先（最新用户决定）

- 当前目标：用户最终选定“统一用 MapKit 算距离；导航优先高德，未安装则用 Apple”，覆盖本轮中途高德 API 方案。不再需要提供或读取地图 Key。
- 本地实现：MapKit 依次比较 `R→A→P` 两段返回步行路线距离；后端新增 GET/PUT `/events/{eventId}/aed-route-calculation`，核查接受资格、事件/任务状态、位置新鲜度、输入变化、AED 可用性/占用后分配；客户端仅采用服务端回执。正式配置为 CLIENT_MAPKIT（生产需显式配置），开发入口默认此模式，旧几何/高德 provider 仅保留显式模式。
- 算路边界：每轮最多八个按两段直线距离下界预筛的候选，保留当前 AED；上下文绑定事件/设备、60 秒有效，患者点必须一致、响应者偏移不超过 25m；上报距离有有限值/上下界及几何下界检查，但 CLIENT_MAPKIT 仍是客户端申报，不是服务器独立验证的 Apple 结果。缓存有界、重启须重算，不增加数据库表。重复报告同内容幂等、冲突内容拒绝，不宣称全库全局最优。
- 导航：UIApplication.canOpenURL 检测 iosamap；安装高德时优先，未安装/唤起失败时 Apple 回退。三种 iOS target 的 plist 及 project.yml 补齐查询白名单。当前 MapKit 方案按任务阶段“先取 AED、领取后去患者”导航，不将 WGS-84 途经点直接当作 GCJ-02。位置示意与真实路线区分。
- 兼容：AED 时间排序/固定步速/取用耗时/300 秒绕行门槛已移除；旧 ETA 任务可解码但距离未知；旧 ETA 改派不接受。新任务字段需要新版前后端配套，旧客户端不兼容新距离路线。
- 主要文件：backend/src/client-mapkit-routes.ts（上下文、报价校验和 provider）、route-provider.ts/service.ts/server.ts/aed-actions.ts/config.ts/main.ts；iOS Models/Ports/APIClient/AppEnvironment/AppStore/AppleMapsDirections/ResponderNavigationView；contracts/openapi.yaml、shared/domain.ts、现有架构/需求/运行说明；对应后端与 iOS 测试；导航 plist 和 ios-smoke.sh。
- 已验证：TypeScript check/build、git diff --check、plist 与脚本语法通过；最终后端全量 741/741 + 21/21（共 762），进程退出码 0，包含新增真实 loopback HTTP 流程与幂等回归（/tmp/aed-mapkit-full-tests-final.log）。iOS build-for-testing 通过，最终相关 25/25 测试通过，含手机计算→上报→采用后端确认任务及地图选择（/tmp/aed-mapkit-ios-tests-final.log）。
- 真实接口证据：Mac 原生 MapKit 使用固定合成上海坐标查询两段步行路线成功，260m + 443m = 703m，未配置地图 Key。脚本 /tmp/aed-mapkit-probe.swift；结果 /tmp/aed-mapkit-live-probe.log。只证明本机 MapKit 接口，不代表 iPhone 安装/导航/后台业务已验收。
- 既有测试限制：testConnectAndLocationChangesPublishStrictResponderPositionThroughRest 在本轮高德阶段和 MapKit 阶段均出现异步 REST 等待超时；该测试不涉及本次路线流程，根因未确认，没有修改其行为或声称整个 iOS 回归全绿。日志 /tmp/aed-mapkit-ios-tests.log。新路线相关 25 项均已通过。
- 未执行：没有部署、提交、推送、真机安装/地图唤起、生产数据库操作或真实救助事件。原有大量未提交修改保留。
- 下一步：经用户授权再配套部署/安装，实测高德已安装/未安装/唤起失败分支和手机断网重试。独立排查上述既有位置上报测试超时。
- 不得破坏：服务端分配权、患者优先、AED 占用/领取规则、在途改派 15 秒确认、WGS-84 定位事实、原有 dirty work；不触发跌倒/SOS，不自动部署。

## 2026-09-20 09:28 Watch 实际安装成功（覆盖此前安装阻塞状态）

手表已注册并刷新 profile；修复 profile 更新后增量产物未重新签名的问题，改用全新构建目录，独立 Watch、嵌入 Watch、iPhone 及 dylib 分别验签通过。新包装入 iPhone 后通过 Watch App 安装成功，用户确认；iPhone appconduitd 明确记录 installed 和 acknowledged。下一步为打开 Watch App 验证启动/授权/业务配对；Mac DDI 调试故障仍未解决，不触发真实跌倒/SOS。详见 [证据](docs/evidence/watch-registration-2026-09-20/README.md)。

## 2026-09-20 Watch 注册与签名刷新复测

Apple Developer 网页已实查手表注册记录，UDID 正确。首次 generic build 仍复用旧 profile；将该缓存文件移至 `/tmp/aed-old-watch-profile-20260920` 保留后，重新执行 `-allowProvisioningUpdates`，成功生成 2026-09-20 01:20:34 UTC 的 Watch profile，包含本表 UDID 且 fall-detection=true。完整 Debug 签名 build 与 codesign --verify --deep --strict 通过，嵌入 Watch 签名也含跌倒权限。

更新后的完整 App 已实际覆盖安装到 iPhone 17 Pro，保留应用数据。产物 `/tmp/aedresponse-registered-20260920/Build/Products/Debug-iphoneos/AEDResponse.app`，日志 `/tmp/aedresponse-profile-refresh-20260920.log`。Mac 直装 Watch 本轮在连接隧道阶段再次报 4000/1001，尚未进入 DDI/安装；不能称 DDI 已解决，也不能用本轮结果判断它仍必然失败。已请用户通过 iPhone Watch App 重试安装，等待实际结果。没有启动跌倒/SOS/救助事件；没有代码修改、提交或部署。

## 2026-09-19 跌倒权限获批后的签名安装与 APNs 接线

本节覆盖旧记录中“Fall Detection 尚未获批 / APNs 手机端未接线”的状态。用户已确认获批，本机 Watch profile 与完整签名产物均证实跌倒 entitlement。完整 iPhone+Watch Debug 开发签名构建通过，正式 App 已在 iPhone 17 Pro 安装并启动。iPhone APNs profile 与签名均已含 development 权限。

本轮补齐客户端远程注册/token 上传/轮换重试/退出回调隔离/通知 REST 对账，保留原有后端与用户授权门禁；27 项 API/协调器回归及 2 项 AppStore 集成测试通过。仍缺用户实际登录与授权结果、APNs .p8/Key ID 及目标服务端配置、Watch 开发连接（实际隧道超时）。未部署、未创建救助事件，不开展真实跌倒/SOS 测试，不将开发签名安装等同于分发/完整业务验收。

具体文件、日志、证据和下一步：[本轮验证记录](docs/evidence/platform-signing-2026-09-19/README.md)。旧“33 项”统计不因本轮部分平台证据直接减项，G03/G04 真机链路尚未关闭。保留既有未提交与并行 UI 变更；未自动提交/推送。

## DeepSeek 本轮交付与交接（2026-09-14，第五轮）

> 本节是给下一位接手者（cdx 审核 / 后续会话）的交接。**先读本节，再读文首“最新范围”与
> [全项目清单](docs/全项目待办与验收清单-2026-09-13.md)**；下面历史章节里的测试数字是各轮快照，
> 不要当成当前值，当前值见第 2 节。

### 0. 用户 2026-09-14 决策（覆盖此前口径，按此执行）

1. **跌倒相关不做实测**：代码保留，验收统一放到后续实机测试阶段；**当前标准=代码能编译通过**。
2. **新增一个事件触发方式**：由用户发现患者后发起一次求助事件（“一案请求”）。**只增加触发方式，其他任何地方不改动**。
3. **G07 导航直接调用 Apple 地图**（手机端步行导航），不再需要高德密钥；服务端路线降级为“就近分配的估算”，模式由 `AED_NAVIGATION_MODE` 显式声明。
4. **G06 先用地图上的 AED 数据**，后续再写爬虫程序；不再把“AED 管理方书面授权”当本阶段前置条件。
5. **G12 不强制第三方服务商**：要求是“锚点不由本部署单独可改写”，可信时间戳服务 / 异机只追加存储 / 公开发布摘要三者任一即可。
6. **冻结范围确认**：G01 真实业务服务边界、G16 通用可访问性/设备适配专项**保持冻结**（不作门槛、不计完成）；G07 正式环境与走路核对、G02/G03/G04/G10/G16 的真机项按第 1 条并入实机阶段。
7. 用户指示：**先把业务跑通**，不再追问上述外部条件。

### 1. 本轮交付（按工作包，含实现入口与证据）

| 工作包 | 交付 | 实现入口 | 证据（测试文件：项数） |
| --- | --- | --- | --- |
| **新增触发方式** | 用户发现患者→发起一案请求；上报者 iPhone 成为患者侧位置来源；观测记录**只有位置与时间**（跌倒字段用 `never` 禁止写入）；按 eventId 幂等；iOS 待命页「上报发现的患者」+ 二次确认 | `backend/src/user-report-creation.ts`、`service.reportFoundPatient`、`POST /api/v2/events/found-patient`、`TriggerSource.userReportedPatient`、`ResponderDashboardView` | `found-patient.test.ts` 3、iOS `AppStoreArchitectureTests` 4 |
| G02 账户与设备 | Apple 服务端授权变更通知（内嵌 Apple Root CA G3 验链 + ES256 + iss/aud；`consent-revoked`/`account-deleted` 撤销该主体全部会话并丢弃 refresh token）；`DELETE /api/v2/me/companion-link` 显式解绑；一张配对 ticket 只对一个 iPhone 有效；重装=新设备行；三类协议状态的账户管理行为验收 | `apple-notifications.ts`、`service.unbindCompanionWatch`/`handleAppleServerNotification`、`companion-link` 相关事务 | `apple-notifications.test.ts` 3、`companion-link.test.ts` 9、iOS 3 项 |
| G04 通知与播报 | 朗读定位卡音频策略：`.playback`+`.spokenAudio`+`.duckOthers`/`.interruptSpokenAudioAndMixWithOthers`、通话中拒绝朗读、系统中断即停不重播、配置失败显式报告 | `SpokenAudioSessionControlling` 端口 + `LocationSpeechService` | iOS `SpokenGuidanceAudioTests` 5 |
| G05 生命周期 | 五类终态文案抽成单一映射（此前散在两个视图的嵌套三元里）；组合测试扩到重复触发/患者自己的手机/接受与结束并发 | `EventOutcomePresentation`、`lifecycle-combinations.test.ts` | `lifecycle-combinations.test.ts` 8、iOS `EventOutcomePresentationTests` 5 |
| G06 AED 资产 | 生命周期用例：核验过期即不可派发、重新核验恢复、过期物理确认不得用于归还、确认归还才释放占用、RETIRE 保留来源 | `aed-assets.ts`（既有）+ 新用例 | `aed-assets.test.ts` 3 |
| G07 路线与改道 | 改道提案的**读取路径**（此前服务端存了问题却没人能读到）+ `assignment:reroute-proposed` 通知 + iOS 倒计时横幅；导航改为 Apple 地图（`AED_NAVIGATION_MODE`） | `service.pendingAedReroute`、`RerouteProposalCoordinator`、`AppleMapsDirections` | `aed-reroute.test.ts` 11、iOS `AedRerouteTests` 4 + `AppleMapsDirectionsTests` 3、`config.test.ts` 3 断言 |
| G08 匿名协作 | App 内联系=**封闭预设消息**：记录类型无自由文本字段（存储校验器拒绝白名单外键）、5 秒限流、每事件每人 20 条、`signalId` 幂等、通知只含不透明 id；iOS 匿名团队界面 | `coordination-team.ts`（team signal）、`POST|GET /api/v2/events/{id}/team-signals` | `team-signals.test.ts` 5、iOS `CoordinationTeamTests` 5 |
| G09 交接与媒体 | 按既有实现逐条勾选并回写证据（真机相机与真实对象存储单列） | `aed-handover.ts` | `aed-handover.test.ts` 14 |
| G11 隐私与留存 | 加密冷封存接入留存作业（**先写副本再封存**、无副本不清除并报告、可自愈重封存）；本人查看（服务端定范围 + 单次 nonce 签名挑战 + 15 工作日审批 + ≤24h 只读 + 到期双撤销 + 无导出）；恢复重放（库外只追加账本 + 水位 + 拒绝启动） | `sealed-store.ts`、`retention.ts`、`self-access.ts`、`restore-guard.ts` | `retention.test.ts` 16、`sealed-store.test.ts` 7、`self-access.test.ts` 10、`restore-guard.test.ts` 4 |
| G12 安全与证据 | 媒体随三年清除删除（先删字节、后删引用，失败即扣留）；封存容器 `keyFingerprint` 与 `WRONG_KEY`；6 个月安全日志（封闭字段白名单 + 路由模板 + 截止时间索引清扫）；权限分离；泄露边界；供应链门禁 | `retention.ts`、`sealed-store.ts`、`security-log.ts`、`ops-status`、`release-gates.test.ts`、CI | `security-log.test.ts` 6、`leakage-boundaries.test.ts` 3、`privilege-separation.test.ts` 1、`backup-verification.test.ts` 7、`release-gates.test.ts` 4 |
| G13 存储可靠性 | 已修问题与分层/故障恢复逐条勾选并回写证据 | `incremental-state.ts`、`g13-operation-scope.test.ts` 等 | `g13-operation-scope.test.ts` 3、`store-commit-cache.test.ts` |
| G14 发布流程 | `scripts/pre-release-check.mjs` 发布入口（法律门禁**强制**、env 模板键、check/build/test/smoke、真实 Caddy 解析，任一步失败即停止）；Caddy 门禁/CI/法律接线/环境隔离/版本回退五项勾选 | `scripts/pre-release-check.mjs`、`.github/workflows/verify.yml` | `release-gates.test.ts` 4 |
| G15 运营能力 | `GET /api/v2/ops/status`（逐项判定 + 阈值表，响应不含 id/坐标/token/消息体）+ `ops-probe.mjs`（0/1/2 退出码）；匿名事件状态 + legal hold 的 **HTTP 入口**（此前只有服务层函数）；本机恢复演练 `restore-drill.mjs`；事故处置手册 | `ops-status.ts`、`ops-probe.mjs`、`ops-event-status`、`restore-drill.mjs`、`docs/incident-playbook-2026-09-14.md` | `ops-status.test.ts` 3、`ops-event-status.test.ts` 1、`restore-drill.test.ts` 3 |
| G16 验收层 | iOS 门禁从 19 个测试类扩到 36 个（**此前 13 个类编译了却从不执行**）；逐需求映射更新 | `scripts/ios-smoke.sh`、`docs/需求实现与证据映射-2026-09-13.md` | Simulator 144 → 393 |

### 2. 门禁（2026-09-14 逐字结果）

| 命令 | 结果 |
| --- | --- |
| `cd backend && npm run check` | 0 错误 |
| `cd backend && npm run build` | exit 0 |
| `cd backend && npm test` | **682/682 通过，0 失败** |
| `cd backend && npm run smoke` | 契约 **5/5**、后端 **18/18** |
| `IOS_SMOKE_SIMULATOR=1 IOS_SMOKE_CACHE_ROOT=/tmp/aed-ios-cache bash scripts/ios-smoke.sh` | iPhone/Watch 编译通过，Simulator **393/393** |
| `cd backend && npm audit --registry=https://registry.npmjs.org` | **0 vulnerabilities**（含 dev） |
| `node scripts/pre-release-check.mjs` | **exit 1**，停在 legal（运营占位符未填，按设计拒绝发布） |
| `node scripts/pre-release-check.mjs --check env-template` | exit 0 |

### 3. 本轮修掉的真实缺陷（都是"看起来已实现"的那种）

1. **Apple 通知端点会拒绝每一条真实通知**：签名校验对证书暴露的公钥又调了一次 `createPublicKey`，而它对已是公钥的 KeyObject 会抛错，被 `catch` 成 `BAD_SIGNATURE`。改为直接用 `X509Certificate.publicKey`。
2. **改道提案没有任何读取路径**：服务端把 15 秒提案写进状态，却没有端点也没有通知，手机无从知道问题存在——功能等于不存在。新增 `GET /events/{id}/reroutes/pending` 与 `assignment:reroute-proposed`。
3. **legal hold 没有 HTTP 入口**：留存承诺里的"依法冻结"只有服务层函数，需要冻结时无人能操作。新增 `POST /ops/events/{id}/legal-hold`（与释放），并断言冻结期间到期事件既不封存也不清除。
4. **被取代的配对 ticket 仍可用于配表**：签发新 ticket 不作废旧 ticket。现在一张 ticket 只对一个 iPhone 有效。
5. **没有显式解绑入口**：手表丢失/换表无法断开。新增 `DELETE /me/companion-link`。实现中曾尝试"连接第二块表就隐式踢掉第一块"，被既有 watch-fallback 测试证明会破坏"一个家庭两块表"的合法场景，因此改为显式解绑并把这个取舍写进条目。
6. **五类终态文案分散在两个视图的嵌套三元表达式里**：任一处改动都会让患者端与响应者端不一致；抽成 `EventOutcomePresentation` 并由测试固定"只有 resolved 声称已结束"。
7. **朗读定位卡从未配置音频会话**：默认类别会打断其它音频，也不会在通话中保持安静。
8. **生产报错文案指向一个不存在的开关**：文案让运维设置 `AED_ALLOW_REFERENCE_ROUTES=true`，但**没有任何代码读它**，照做完全无效；换成真正生效的 `AED_NAVIGATION_MODE`（生产未声明即拒绝启动）。
9. **iOS 门禁扩容当场抓到的 4 个**：三处过期的 presence 夹具（解码失败会让 presence 上传静默丢弃）、`ControlledSessionStoreTests` 的断言与受控测试开关含义相反、隐私政策缺「删除账号/15 个工作日/不做跨 App 追踪」披露、App 内删除账号文案未说明事件记录按留存保留（App Store 5.1.1(v) 要求）。

### 4. 现状：78 项已勾选 / 33 项未勾选（分类见清单顶部表）

- **冻结 2 项**：G01 真实业务服务边界、G16 可访问性/设备适配专项。
- **实机测试阶段验收 25 项**：G02 Watch 证明、G03 全部 6 项、G04 entitlement、G07 两项实机核对、G10 两项实测、G16 签名/真机全流程、G16-S01–S11。按用户 2026-09-14 指示，当前标准=编译通过。
- **真实缺口 6 项**（非冻结、非设备）：G06 真实 AED 数据（用户已定：后续写爬虫）、G11 真实政策 URL + 联系邮箱（只差运营填两个字段）、G12 独立锚点（只差"部署之外的一方"）、G14 TLS/WAF/网络与 DB 策略（真实部署侧）、G15 异机加密备份 + RPO/RTO + 告警（需要第二台主机）、G15 只读后台图形界面（范围选择，等价 REST+CLI 已实现并断言）。

**结论**：不需要设备与外部资源的代码侧工作已无剩余项；剩余项要么等一个外部输入，要么是按用户决定延后。

### 5. 接手后的建议顺序（按解锁成本排序）

1. **运营填两个字段**（`contracts/agreements.json` 的 `privacyPolicyURL`、`contactEmail` + 托管方/地区披露）→ `scripts/check-legal-readiness.mjs` 转 0，`pre-release-check.mjs` 的法律步骤放行。
2. **一个发布地址**（TSA / 异机只追加存储 / 公开摘要）→ 关闭 G12；本地摘要链已具备，接上即可。
3. **第二台主机或对象存储 + 密钥托管 + 告警通道** → 关闭 G15 异机备份并填写 RPO/RTO（脚本与演练已就绪：`backup-sqlite.sh`、`verify-backup.mjs`、`restore-drill.mjs`）。
4. **真实部署网络**（域名证书、WAF、数据库网段）→ 关闭 G14 最后一项。
5. **实机测试阶段**：按 G16-S01–S11 组织；跌倒相关不做实测（用户指示），Watch/APNs/蜂窝/走路由设备完成。
6. **按用户决定延后**：G06 爬虫、G15 后台图形界面。

### 6. 工程约定与陷阱（避免重复踩坑）

- `contracts/openapi.yaml` 由**零依赖 YAML 子集读取器**解析：flow sequence / flow mapping **必须写在单行**，否则契约 smoke 报 "unterminated flow sequence"。
- 新增持久集合必须**同时**登记四处：`models.ts` 的 `PersistentState` + `emptyState()`、`store.ts` 的 `recordCollections`（SQLite 重开白名单）、`RECORD_VALIDATORS`（如需要）、`incremental-state.ts` 的 `fields` 关系索引。缺白名单会在 **SQLite 重开**时才炸（`Unsupported SQLite state collection`），缺索引会让 G13 断言失败。
- 新增 Swift 文件后必须 `xcodegen generate`；新增测试类必须加进 `scripts/ios-smoke.sh` 的 `UNIT_TEST_FILTER`，否则**只会被编译、永远不执行**（本轮扩门禁就是靠这一点抓出 4 个真实缺陷）。
- **G13 约束**：业务/HTTP 路径与 `tick()` 不得整状态 clone 或全集合枚举（`g13-operation-scope.test.ts` 会抓，断言 `clones/keyVisits/rebuilds == 0`）。本轮的账本重放、安全日志清扫、运维状态都按需/按索引读取；一次性维护（身份账本、锚点）只在启动或显式调用时执行，**不要塞进 tick**。
- 生产启动是**硬性拒绝**式的：缺 `AED_FIXTURE_FILE`、缺身份配置、缺/错 `AED_NAVIGATION_MODE` 都直接拒绝启动；`private`/`production` 两档的开关不要为了本地方便放宽。
- 协议正文在 `contracts/agreements.json`（版本 2.0）；iOS 测试会断言必需披露与版本一致，改文案要同步跑 `ArchitectureBoundaryTests`。
- 发布入口 `node scripts/pre-release-check.mjs` 在 legal 处 exit 1 是**设计行为**（占位符未填），不要为了让它变绿而清空检查。
- 并发注意：本轮与其它会话共用 `store.ts` / `models.ts` / `service.ts` / `contracts/openapi.yaml`，一律用增量插入，不要整段重写。

### 7. 本轮新增/改动的关键文件索引

- 后端模块：`src/sealed-store.ts`、`src/self-access.ts`、`src/restore-guard.ts`、`src/security-log.ts`、`src/ops-status.ts`、`src/apple-notifications.ts`、`src/user-report-creation.ts`（另 `retention.ts`/`coordination-team.ts`/`service.ts`/`config.ts`/`server.ts`/`store.ts`/`models.ts`/`contracts.ts`/`incremental-state.ts` 有增量改动）。
- 后端测试：`test/found-patient.test.ts`、`test/team-signals.test.ts`、`test/self-access.test.ts`、`test/restore-guard.test.ts`、`test/restore-drill.test.ts`、`test/security-log.test.ts`、`test/leakage-boundaries.test.ts`、`test/privilege-separation.test.ts`、`test/ops-status.test.ts`、`test/ops-event-status.test.ts`、`test/apple-notifications.test.ts`、`test/backup-verification.test.ts`（另 `retention`/`aed-reroute`/`aed-assets`/`companion-link`/`config`/`release-gates`/`lifecycle-combinations` 有扩展）。
- 部署/脚本：`backend/deploy/azure/ops-probe.mjs`、`backend/deploy/azure/restore-drill.mjs`、`backend/deploy/azure/verify-backup.mjs`、`backend/deploy/azure/backup-sqlite.sh`、`scripts/pre-release-check.mjs`、`.github/workflows/verify.yml`。
- iOS：`Services/AppleMapsDirections.swift`、`Services/DeviceServices.swift`（音频会话 + 测试用定位注入）、`Application/CoordinationTeamCoordinator.swift`、`Application/RerouteProposalCoordinator.swift`、`Domain/CoordinationTeam.swift`、`Domain/AedReroute.swift`、`Domain/EventOutcomePresentation.swift`、`Views/CoordinationTeamView.swift`、`Views/ResponderDashboardView.swift`、`Views/ResponderNavigationView.swift`、`Views/PatientDashboardView.swift`、`Views/SettingsView.swift`。
- iOS 测试：`CoordinationTeamTests`、`AedRerouteTests`、`EventOutcomePresentationTests`、`SpokenGuidanceAudioTests`、`AppleMapsDirectionsTests`（另 `AppStoreArchitectureTests`/`ArchitectureBoundaryTests`/`ControlledSessionStoreTests` 有新增）。
- 文档：`docs/全项目待办与验收清单-2026-09-13.md`（勾选 + 分类表 + 用户决策）、`docs/未冻结项目-DeepSeek执行报告-2026-09-13.md`（第五轮逐项报告）、`docs/需求实现与证据映射-2026-09-13.md`、`docs/backup-recovery-2026-09-13.md`、`docs/incident-playbook-2026-09-14.md`、`docs/release-runbook-2026-09-13.md`（4.1 密钥运维）。

---

## 最终实机阶段补充要求（2026-09-13，用户确认）

- 已将中国境内受控测试与责任边界写入 `docs/全项目待办与验收清单-2026-09-13.md` 的 G16-S01–S11，并在 `docs/release-runbook-2026-09-13.md` 第 5 节加入入口。
- 状态全部待完成：测试安全方案、真人数据同意、独立影响评估、Apple 实际条款核对、救助状态/隐私实机证据；运营主体、培训保险和法律复核只在对应的真实活动/运营阶段适用。
- 本次仅更新文档，没有实施年龄门禁或其他代码修改，没有实机测试、签署、提交、部署或对外发送。年龄按用户最新要求暂不处理；此前成年核验草案不是当前执行授权。
- 下一步在最终实机阶段逐项填写适用性、负责人、证据和结果；真人测试前置事项在开始前完成，不事后补签，不把文档建立标为验收通过。

## G10 参与窗口最终核对 + 队列增长管理（2026-09-13，DeepSeek 子任务）

- 范围：G10 中两项本地可验证工作——(a) 参与窗口最终核对、(b) 队列/隔离/confirmed 增长管理。真实蜂窝/IPv6-only/切网为外部条件，未伪造；待条件与所需设备已写入清单 G10 段与执行记录。
- **(a) 后端新增 `backend/src/position-window.ts` + `service.ts` 对账入口**：按服务端权威窗口算期望秒槽，与已收批次比对，按窗口写显式审计结论（期望/已收、FIX/NO_NEW_FIX 拆分、逐槽缺口及原因、`closedBy`、宽限截止、`final`、`revision`、`correctedByLateEvidence`）。触发点：事件终态、响应者退出 ACK、迟到合法批次到达后重算。**窗口未关闭绝不写结论**，宽限期由 `AED_POSITION_WINDOW_GRACE_SECONDS`（默认 120）配置；结论只能新增事实（守卫拒绝「少收」改写与删除结论）；收到的批次永不被删或改写。路由：`POST /events/{id}/position-window/complete`、`GET /events/{id}/position-window/reconciliations`。
- **(b) iOS 新增 `EventPositionQueueGrowth.swift`**：可配置策略、已确认隔离行封存与**计数式压缩**（最旧优先）、队列深度快照、容量拒绝、删除守卫；`EventPositionQueuePersistenceCoordinator.save` 改为 `.persisted`/`.refused`/`.failed`，超预算先拒绝并把原因交给 UI（`AppStore.eventPositionQueueGrowth` / `eventPositionQueueGrowthRefusal`）、采集保持阻塞；`ProtectedEventPositionQueueStore` 的 append-only 检查跨两个隔离列表，未确认行不得减少。
- 测试：`backend/test/position-window-reconciliation.test.ts`（17 项，已入默认 `npm test`）、`ios/AEDResponseTests/EventPositionQueueGrowthTests.swift`（11 项，已入 `scripts/ios-smoke.sh` 的 `UNIT_TEST_FILTER`）。
- **验证（实测）**：`npm run check`、`npm run build` 退出 0；`npm test` **598/598**；`npm run smoke` 契约 5/5 + 后端 18/18；iOS 编译通过 + Simulator **144/144**；`g13-operation-scope.test.ts` 3/3（无全状态 clone/全集合枚举回退）。
- **负向对照**：后端把宽限期判定改为「关闭即永久」→ 2 项失败，恢复后 17/17；iOS 把容量检查改为「允许裁剪」→ 8 项断言失败，恢复后 144/144。
- 文档：总清单 G10 两项已勾选并附证据与边界；`docs/未冻结项目执行记录-2026-09-13.md` 追加本轮记录。
- **仍未完成**：真实蜂窝/外部 Wi-Fi/IPv6-only/切网、锁屏后台与系统降频实测、进程终止后队列重放、权限撤回/角色切换/患者优先/退出结束 ACK 时序组合（均需真机或双机）；后端窗口结论接入 iOS 增长策略作为「已确认」输入（本机可做，本轮未做）。

## G09 AED 交接与媒体（2026-09-13，并行子代理实施）

- 范围：按清单 G09 与需求 §104 / V2-A11 / V2-A26 实现服务端交接、临时放置点与媒体门槛。未部署、未提交、未连接生产库、未操作真机，未导入任何真实 AED 来源。
- **新增模块 `backend/src/aed-handover.ts`**：`ObjectStoragePort` 端口 + `NullObjectStorage`（拒绝一切操作）、照片参考 schema 与四项边界校验、位置 30 秒/50 米校验、`openHandover` / `confirmHandover` / `settleHandover` / `reportTemporaryPointFollowUp` / `haltHandoverForExitedHolder`。
- **状态模型**：新增 4 个集合 `aedHandoversById`、`aedTemporaryPointDepositsById`、`aedTemporaryPointFollowUpsById`、`aedPhotoReferencesByObjectKey`，并在 `RECORD_VALIDATORS`、全量校验列表、`incremental-state` 关系索引、SQLite `recordCollections` 加载白名单中登记。`aedAssetSchema.custody` 增加 `custodySince` / `depositedAt`（`acquiredAt` 仍记录离开柜机的时刻，不被交接覆盖）。
- **REST（均已写入 `contracts/openapi.yaml` 与 `contract.smoke.ts` 的 implementedRoutes）**：`POST /events/{id}/aed-handovers`、`POST .../aed-handovers/{handoverId}/confirm`、`POST .../aed-handovers/{handoverId}/settle`、`GET .../aed-temporary-point`、`POST .../aed-temporary-point/{depositId}/follow-up`。
- **关键业务规则**：双方各确认一次才可能完成（单方确认保持 PENDING，且有写入期校验，手工改状态文件也会被拒）；接收方由**自己那次确认**claim 且只可 claim 一次（持有人无法在请求体里指定他人身份）；临时点必须**位置与照片同时有效**才创建，任一失败不产生可派发设备；无对象存储直接 422，不写任何记录；FOUND 转移占用、NOT_FOUND 置 UNAVAILABLE 并关闭搜索；**任务结束/退出/事件终结都不释放占用**，退出时 `haltHandoverForExitedHolder` 只把资产移到 `AWAITING_RETURN`。
- **隐私披露**：`contracts/agreements.json` 的隐私政策「收集什么」新增照片与拍摄位置、「不收集什么」把原来的“不收集照片”改为精确表述（不收相册内容、不允许相册选择、只有主动拍摄的单张照片上传）、「保存期限」写明照片属事件证据并私有存储；敏感个人信息协议的范围与用途同步。四项协议仍 schema 有效、段落齐全。
- **验证**：`npm run check` / `npm run build` 通过；`npm test` **598/598**（G09 新增 14 项，已入默认清单）；`npm run smoke` 契约 **5/5** + 后端 **18/18**。
- **负向对照**：把双方确认改为“单方确认即完成”，`aed-handover.test.ts` 由 14/14 变为 **11 通过 / 3 失败**；恢复后回到 14/14。
- **未覆盖**：真实对象存储（上传、服务端重算 sha256、私有读取授权、孤立上传清理）——需要部署侧对象存储与凭据，本轮只有端口、声明校验与 NullObjectStorage 拒绝路径；相机采集与 EXIF 剥离（客户端能力，未改 iOS）；真机交接/走路验收；照片的实际字节在无上传端点时无法由服务端复核，故 `verifiedAgainstStorage` 只有在配置了存储端口时才为 true。
- **并发说明**：与 G07/G10/G12 会话共用 `store.ts` / `models.ts`，本轮只做增量插入；顺手把 `recordCollections` 缺失的 `positionWindowReconciliationsById` / `accessAuditById` / `breakGlassGrantsById` / `rerouteProposalsById` 补齐（此前任何 SQLite 重开都会抛 `Unsupported SQLite state collection`），并把另一会话写入 OpenAPI 的多行 flow sequence 合并为单行（零依赖 YAML 子集读取器不支持多行）。两处均为格式/白名单修复，未改业务语义。

## 当前交接：业务范围已调整，DeepSeek 接手实施（2026-09-13）

- 用户最新指示针对 `[PROJECT_ROOT]/docs/全项目待办与验收清单-2026-09-13.md`：移出与业务无关任务；G14 在逐项解释后也按追加指示全部解冻；此前其明确列出的包/条目继续已解冻。用户仍安排 DeepSeek 完成后交回 cdx 审核。
- **唯一总表**：[全项目清单](docs/全项目待办与验收清单-2026-09-13.md)，先读文首“最新范围”，再读 [DeepSeek 交接说明](docs/DeepSeek-全项目交接-2026-09-13.md)。下方历史冻结声明已被这次范围更新覆盖，不能拿旧记录重新阻止已解冻任务。
- **整包解冻**：G03 Watch 正式运行、G04 通知与患者播报、G14 正式环境与发布流程。**条目解冻**：G02 解绑/换表/换手机/重装/旧会话撤销/新绑定恢复；G05 操作失败与终态后状态恢复；G10 原生蜂窝/Wi-Fi/IPv6-only/切网；G15 异机备份与新实例恢复/RPO/RTO；G16 UI 行为、正式签名/profile/TestFlight、双端真机全流程、V2-A01–A28 证据映射。
- **G14 当前状态**：整包已解冻；2 个旧修复保持完成，6 项恢复实施/验收且仍未完成，逐项解释保留。**仍冻结**：G01 保留的业务边界确认、G16 未点名的可访问性/设备适配专项。已解冻任务缺 Apple/真机/异机条件时标“待外部条件”，不能写回旧冻结。
- **移出当前任务**：发行主体审核策略/商店材料填报、无现行业务依据的迁移/多实例/泛容量工程、纯视觉/多语言/丰富管理展示/无业务目的拆文件；代码和历史证据保留。业务服务边界、用户数据权利/证据/恢复/备份及真实可操作性仍保留；Fall 权限/签名等平台前提归并到 G02/G03/G16，未遗漏。
- **当前实现仍未全部完成**：G13-A、账户逻辑关闭/本地退出、留存本地作业、签名链、资产占用/归还子集已有证据；Watch/APNs/媒体/改道/匿名联系/冷封存/恢复等余项按总清单继续。解冻不等于完成。
- **验证基准未变**：此前后端 check/build、514/514；smoke 5/5 + 18/18；双端编译；应用/身份/退出 Simulator 118/118。此次仅文档变更，源码/契约/测试摘要仍以[收尾证据](docs/evidence/local-closeout-2026-09-13/README.md)为基准，不声称已新增真机或生产证明。
- **业务规则保持**：Apple-only；原 2 万目标取消；账户活动拦截仅手机端、本机退出不等服务器许可、注销 CLOSED 保留既有信息；三次取消救助独立终态；位置与招募同一增量事务；取得 AED 未归还不释放；30 天 SEALED 仍不是加密冷存储；签名数据库须保留对应密钥。
- **工作树**：实际项目 `[PROJECT_ROOT]`，HEAD `64c4759`，含大量原有未提交/未跟踪文件，必须以完整工作树交接。Watch 未验证草稿在任务目录。未提交/推送/部署/连接生产。
- **执行边界**：本次只整理任务；G14 的 CI、环境隔离、发布门禁和版本回退均已纳入 DeepSeek 接手范围，与 G15/G16 联合验收。缺外部条件时明确记录，后续实际操作按用户授权执行。DeepSeek 回交时提供每条状态、变化清单、真实证据和剩余条件，cdx 再独立审核。

## 上一阶段收尾记录（2026-09-13，历史）

- 最新指示：“把你现在做的完成了的结束就行了”。本次执行已收尾；未冻结剩余项仍列待办，只有用户重新指定后再继续。下方“实施中”章节为历史记录，不代表当前仍要自动续做。
- 已完成：手机端活动救助账户拦截、患者/响应者三次确认、本地立即退出、服务器逻辑注销与关闭回执幂等；Apple 挑战真实客户端接线；留存期限/完整清除/失败重试/到期索引；事务签名证据与清除授权；资产命令和实际取得后的占用/归还回归；G13 HTTP/真实 interval tick 分离计量；佛山 4 个未核验地图候选归档。
- 账户设计：`users.lifecycleState=ACTIVE/CLOSED`、`closedAt` 与 `devices.loginState=SIGNED_IN/SIGNED_OUT` 分开；关闭保留既有信息，旧会话/刷新/自动重新登录被拒。活动参与拦截仅在手机端，退出立即本地执行，原持久队列补发远端撤销；不恢复此前服务端活动参与 gate。患者三次取消为独立 `ASSISTANCE_WITHDRAWN`，不算误报或成功救助。
- 最终后端：check/build 退出 0；`npm test` **514/514**；smoke 契约 **5/5**、后端 **18/18**。包含留存 9 项、签名 7 项、资产 HTTP 2 项。iPhone/Watch 编译通过；最新应用/身份/退出 Simulator 定向 **118/118**，不是全套 UI 或真机证据。早先 service hub 退出 75 的测试不计为通过。
- 验收清单已填写各已完成子项，保留 G02/G06/G11/G12 整包“部分完成”。[收尾证据与源码摘要](docs/evidence/local-closeout-2026-09-13/README.md)、[清单](docs/全项目待办与验收清单-2026-09-13.md)、[执行记录](docs/未冻结项目执行记录-2026-09-13.md)。
- 未接线的 Watch 验证器三个新文件已移出 `backend/src`，保存在 `/Users/REDACTED/Documents/ChatGPT/毕设项目 2/未接线草稿/Watch-App-Attest-2026-09-13/`；未编译/测试/集成，不得误算完成。项目保留原验证端口和缺少可信 provider 时拒绝的行为。
- 未完成：Apple code/token/正式 Watch 证明、完整资产停用边界/交接/媒体、改道、匿名联系、最终秒槽核对、加密冷封存、本人查看、访问审计、独立备份锚点与恢复重放等；冻结的发行/Apple/真机项继续冻结。真实 AED 现场条件暂不催办。
- 主要文件：后端 `account-lifecycle.ts`、`identity-access.ts`、`service.ts`、`server.ts`、`models.ts`、`store.ts`、`incremental-state.ts`、`retention*.ts`、`evidence-*.ts`、`aed-asset*.ts` 及相关用例；iOS AppStore、APIClient、账户/患者/响应者视图和退出协调器；contracts、需求/清单及证据文档。
- 不得破坏：保护原有未提交修改；不提交/推送/部署/访问生产；Apple-only、不恢复 2 万目标；位置与招募仍同一增量事务；地图候选不得直接派发。签名数据库启动依赖对应 `.evidence-key.pem`，本地未实现完整备份/密钥运维；30 天 `SEALED` 只是逻辑标记，不是加密冷存储。

## 全项目未冻结工作实施中（2026-09-13）

- 用户目标：完成全项目所有未冻结项目，不再局限于 G13-A。
- 冻结范围按最新清单；已明确 G02 Watch 证明代码及本地验证继续实施，Apple 账户/发行/真机验收冻结。Apple-only 登录和取消 2 万目标保持。
- 当前阶段：核对 G11/G13 留存、删除与恢复；已确认原清除在标记 PURGED 后无法可靠重试，且事件行/通知等仍可能保留敏感事实，需要完整清除及 SQLite 故障验证。之后推进安全/账户、AED/交接、改道/匿名联系及客户端闭环。
- 执行记录：`docs/未冻结项目执行记录-2026-09-13.md`。初始快照在 `/tmp/aed-unfrozen-20260913/baseline/`。
- 未提交、部署或连接生产；本章不表示任务完成，不勾选未通过项。

## 登录方式改为只保留 Apple + 上架范围冻结（2026-09-13）

- 用户指示：① 勾选本人已完成且测试通过的部分；② G02 去掉手机号入口，只保留 Apple 登录；③ 上架相关内容整体冻结，只保留业务、架构与正确性问题。未部署、未提交、未连接生产库、未操作真机。
- **G02 手机号入口移除（代码 + 契约 + 测试 + 政策一起改，不是只删测试）**
  - 后端删除：`/api/v2/auth/phone/challenges`、`/api/v2/auth/phone/verify` 两条路由；`requestPhoneChallenge` / `issuePhoneChallenge` / `verifyPhoneChallenge` / `loginWithPhone`；`PhoneChallengeProvider` 端口、`PhoneChallengeIssue` / `PhoneChallengeVerification`、`normalizePhoneNumber`、`phoneLastFour`、`DeterministicPhoneChallengeProvider`；`phoneChallengeRequestSchema` / `phoneChallengeVerificationRequestSchema`；account 写入路径里的 `phoneLastFour` 分支。
  - 兼容：`AuthMethod` 保留 `PHONE` 仅用于识别旧会话，并新增 `isSupported`，恢复会话时明确拒绝而不是当成 Apple；持久状态里遗留的 PHONE 账户与 challenge 行仍可加载校验，但已无任何写入方（注释写明原因，供后续里程碑删除）。
  - 契约：`contracts/openapi.yaml` 删除两条 PHONE path 与三个 schema，正文叙述改为「Apple subject hash 是唯一登录方式」。
  - iOS：`AuthView` 删除手机号卡片与“或”分隔；`AppStore` 删除 `requestPhoneChallenge` / `verifyPhoneCode` / `phoneChallenge` / `pendingPhoneNumber`；`AuthClient` 协议与 `APIClient` / `TestHostAuthClient` 删除对应方法；`AuthModels` 删除 `PhoneChallenge`、`PhoneNumberValidator` 与手机号相关错误分支。
  - 政策：`contracts/agreements.json` 的「我们收集什么」与「安全」两处改为只使用 Apple 标识、不收集手机号、不存在短信验证码。
  - 需求：`docs/requirements.md` 第 9/13/17/38 行与 V2-A01 同步（登录入口由两种改为一种）。
  - 测试迁移：手机号专属用例随功能删除；账户身份隔离用例改为两个不同 Apple subject；账户删除、HTTP 门禁、限流配额、冒烟 S03 全部改走 `/auth/apple`（挑战由验证器 double 真实签发）；契约冒烟的路由清单同步。冒烟 S03 现在同时断言「不可验证的 Apple token 返回 401」和「已移除的 PHONE 路由不可达」。
- **G11 留存执行引擎（上一轮新增）已在清单勾选**，边界照实写明。
- **上架范围冻结**：G01、G03、G04、G14、G16 整包冻结；G02 发行证书项、G05 真机行为验收、G10 蜂窝/IPv6-only 实测、G15 异机备份与 RTO/RPO 演练按条目冻结。冻结为「暂停推进、不再作为交付门槛」，不是完成，也不删除条目；恢复条件由产品范围决定。
- 验证：后端 `check`、`build`、`npm test` **501/501**、`npm run smoke`（契约 5/5 + 后端 18/18）；iOS iPhone/Watch 编译通过、Simulator 单测 **133/133**。

## G11 留存执行引擎（2026-09-13）

- 范围：实现清单 G11「30 天在线 / 31 天起封存 / 3 年到期处理 / legal hold / 失败重试 / 审计」。用户已确认三项口径：分层按政策原文、满 3 年删精确轨迹/消息/设备关联并保留不可逆聚合、legal hold 纳入本轮。未部署、未提交、未连接生产库、未操作真机。
- **新增 `backend/src/retention.ts`**：`planRetentionSweep`（纯函数，只吃候选+时钟）、`runRetentionSweep`（两阶段：先提交授权、再删除证据）、`eventPurgeSummary`（聚合）、`placeLegalHold` / `releaseLegalHold`。
- **留存时钟**：`transitionEventToTerminal`（唯一终态入口）写 `retention = { tier: "ONLINE", clockStartedAt: resolvedAt }`。没有时钟的事件一律不动——晚清的代价是一份报告，早清的代价是证据被销毁。
- **调度接入**：`tick()` 每轮调用；候选只取**终态**事件，走 `entity:events:state` 关系索引（G13-A 之后不再全量读事件）。实测「无到期项」时整次决策 **0 次全状态 clone**，并有回归守住。
- **删除范围**：位置批次、参与区间、位置回执、timeline、deliveries、assignments、AED 取用回执及其业务键索引。保留：事件行本身 + `PurgedEventSummary`（只有计数与时长，无坐标/设备/身份/AED id/正文）。
- **append-only 守卫没有被削弱**：清除前必须先在独立事务写 `retentionPurgesById`（不可改写、不可删除），`assertEntityWriteAllowed` 只放行该事件的删除；无授权或授权指向别的事件仍然抛错，两种情形都有测试。删除失败进 `deferred` 并在下轮重试，不会在证据仍存在时声称已清除。
- **legal hold**：operator 主体（`operatorToken`）才能放置/释放，必须带 authority 与 reason，写入事件 timeline；冻结期间 30 天与 3 年两个边界都不动作；释放后**不从零重启**时钟，逾期事件在随后两轮内补齐封存与清除。
- **运行指标**：`retentionSweepFailures`（计数器）、`retentionSealedEvents` / `retentionPurgedEvents`（累计）、`retentionDeferredPurges`（仪表，必须回零）、`retentionCandidateReads`（无关系索引时的回退读）。
- **验证**：`npm run check`、`npm run build`、`npm test` **505/505**、`npm run smoke`（契约 5/5 + 后端 18/18）。负向对照：去掉终态留存时钟后 `retention.test.ts` 3 项失败。
- **未做（已在清单保持未勾选）**：备份恢复后 deletion tombstone 重放、15 工作日承诺的执行、封存层加密与境内区域、本人查看申请限时只读；operator 管理面目前只有进程内主体，没有 HTTP 路由（与既有 operator 能力一致，未新增面）。
- 需求同步：`docs/requirements.md` 的 V2-A27 标注该分层已具备可执行作业与 legal hold。

## G01/G05 整改轮（2026-09-13）

- 范围：按 `docs/全项目待办与验收清单-2026-09-13.md` 挑出可在本机验证的问题并解决。未部署、未提交、未连接生产库、未操作真机。
- **G01 已修（需求文档内部不一致，2 处）**：`docs/requirements.md` 的 V2-A21 验收口径改为“REST + 有权限的结构化快照恢复（内部 append-only 审计不对外直返 timeline）”，与正文第 142 行一致；V2-A24 的证据列去掉“公网 Windows”，改为“公网入口端到端记录”并注明入口按第 34 节为受信任 TLS/访问控制的生产入口、Windows 仅作开发/联调/压测控制端。只改文档口径，不改实现或结论。
- **G05 已修（邀请过期/误报取消后的 404 对账）**：原 `AppStore.reconcileEvent` 把任何错误统一写成“REST 状态同步失败”。事件只因邀请可见时，邀请失效后服务端返回 404 是正确答复（`service.ts` 的 `getEvent` 对不可见视图 `notFound`）。新增纯函数 `EventReconcileOutcome.resolve`（`ios/AEDResponse/Application/AppState.swift`）分类：可读→应用；404 且无 tombstone→`dropLocallyInvisibleEvent`（清邀请/任务/患者待处理引用、移除本地事件、补 passiveObservation，不报错）；404 且有 tombstone→静默；其他失败→仍上报。
- **回归**：新增 `ios/AEDResponseTests/EventReconcileOutcomeTests.swift`（5 项），已加入 `scripts/ios-smoke.sh` 的 `UNIT_TEST_FILTER`（此前不在切片内，不会被默认 128 项执行），`xcodegen generate` 后仅新增该文件引用。负向对照：把判定改回“所有失败都告警”，2 项 404 用例失败。
- 验证：后端 `npm run check`、`npm run build`、`npm test` **498/498**、`npm run smoke`（契约 5/5 + 后端 18/18）；iOS iPhone/Watch 编译通过，模拟器单测 **133/133**。
- **清单填写**：G01 该项、G05 该项已勾选并附证据与边界；未做条目保持未勾选。
- **已识别但未做（需要先确认口径）**：G11「30 天在线 / 31 天起封存 / 满 3 年删除、legal hold、备份恢复后 tombstone 重放」与「本人查看申请限时只读」。当前 `DeletionRequestRecord` 只有 `REQUESTED` 一种状态，事件证据没有留存层字段，也没有留存作业。实现前需确认：留存层是否建模为事件字段、3 年到期后要删除哪些集合与保留哪些聚合、legal hold 是否纳入首发、本人查看是首发还是延后。本轮未擅自实现。

## G13-A 完成验收（2026-09-13，498 项后端回归）

- 当前目标：把本轮改动填写到全项目验收清单，并完成 G13-A 剩余入口和同次请求后处理。现已完成本地验收；其他 G01–G16 项目按原状态保留。
- 实现：新增 `incremental-state.ts`（请求局部实体 draft、索引关系与事务 overlay）、`deadline-index.ts`（到期通知索引堆）；接入创建/tick/接受/退出/P/R/批次/presence/Watch fallback 及相关指派/AED/终态用例，outbox 改增量写入。分组索引只维护变化记录，保持全局 recordId 与终态可见性。缺 P 不全扫响应者，生产缺关键索引能力会告警。
- 额外修复：位置回收 SQL 失败会恢复已弹出的到期任务，后续 tick 可重试；已保留的活跃参与者位置会再次检查回收条件。
- 实测：Memory/SQLite、0/250/1,000 远方用户下，创建距离 24/24/24、位置 11/11/11、tick 9/9/9、附近人数 2/2/2、接受 11/11/11；19 类 HTTP 操作远方距离、全状态 clone、全集合枚举、位置索引重建均为 0，各档业务/候选/实体读取一致。真实旧事务 fallback 被范围门禁拒绝，业务输出一致。
- 验证：check/build、`npm test` 498/498、契约 5/5、后端 smoke 18/18；新增 7 个事务/索引用例和 3 个 HTTP 范围用例已加入默认测试。插桩当前版/未插桩版/本轮开始版各 42 条 service 观测 + 10 项边界检查一致；SQL 失败、回滚、重开、通知重排与位置回收重试通过。
- 修改文件：上述 2 个新模块；service、recruitment/tx-recruitment-context、store、entity-transaction、state-read、state-projections、notification-outbox、coordination-aed-reader 与相关事件用例模块；运行指标、package 测试入口与相关回归；全项目清单、本交接和 `docs/G13-A整改完成与验收-2026-09-13.md`。
- 证据：`docs/evidence/g13-completion-2026-09-13/` 含最终日志、计数、44 个后端源码哈希、插桩补丁和验证摘要。`/tmp/aed-g13-completion-20260913/` 是临时基线及实验副本，不作长期唯一依据。
- 下一步：按全项目清单处理尚未关闭的发行/平台/隐私/运维工作；G13 外层历史分层、全库启动和完整故障/异机恢复仍未全部完成。不要重做已通过的 G13-A，也不要将本地测试当作签名、真机/APNs、生产或上架证据。
- 约束：保留既有未提交修改；本轮未提交/推送/部署/连接生产库/修改表结构，iOS 与契约未改且未重跑客户端测试；不恢复已取消的 2 万在线目标。下面各节为历史过程，当前状态以本节和最新清单为准。

## G13-A 候选构造回退修复（2026-09-13，填写清单同轮）

- 背景：上一批共享候选规则把 `tx.keys("devices")` 与患者同账号 `keysWhere` 写成每次调用都执行（谓词作为实参求值，即使身份索引已作答也会跑），draft 侧也先全量枚举再问“有没有索引”。独立复核实测位置写从 15 增至 765/3,015 次设备 key 枚举，draft 候选构造为 40/2,040/8,040。`deviceCandidatesVisited` 只计最终候选，因此该回退没有任何测试能发现。
- 修复：`txRecruitmentContext` 的设备 key 与身份回退改为**惰性回调**；顺序取自已提交 `deviceOrdinal`（`compareByOrdinal`，分三层：已提交→本事务 staged→未知按集合顺序），仅在出现无法定位的 key 时才枚举集合；draft 适配器同样惰性，`candidateDeviceKeys` 内部对集合顺序记忆化。
- 实测：位置写在 0/250/1,000 远方设备（总设备 5/255/1,005）下 `EntityTransaction.keys("devices")`/`keysWhere("devices")` 计数为 **0/0/0**；改为旧适配器立即回升（Memory 计数 7），业务结果不变。
- 新增回归：`backend/test/candidate-source-scope.test.ts`（5 项纯函数契约）、`backend/test/responder-position-transaction.test.ts` 追加 Memory/SQLite 各 1 项枚举计数断言、`test/recruitment-scope-g13a.test.ts` 追加事件创建“索引可用时设备 key 枚举为 0”。两处均做过撤销修复的负向对照。
- 验证：`npm run check`、`npm run build`、`npm test` **488/488**、`npm run smoke`（契约 5/5 + 后端 18/18）。
- 清单填写：`docs/全项目待办与验收清单-2026-09-13.md` 已按“只勾本人改动且测试通过”的规则填写，另加 3 条勾选与 3 条补证；部分完成与未通过项以 **⚠ 部分** / **✗ 未通过** 明写（G13-A 整体、G14 真实反代门禁与归档接线、G02 版本失效分支与真机行为）。
- **仍然未做**：`tick()` 定时补招、接受/退出后的招募刷新、患者位置/事件批次与 presence 变化触发的补招未迁移；位置更新请求后处理仍有全量 clone 与提交后全量位置索引重建；无索引时的正式运行告警未实现。G13-A 的“整个操作范围”“业务入口验证”两条验收标准**未通过**。

## G13-A 第一批独立复核（2026-09-13，先修共享候选查询）

- 当前任务：复核用户提供的 G14/G02/G13-A 第一批整改，并更新全项目待办与验收状态。未读取其他聊天，未修改业务代码、提交、推送、部署或连接生产库；保留原有未提交修改。
- 结论：事件创建距离筛选真实有效（远方 0/250/1,000 时距离调用 24/24/24、最终候选访问 40/40/40）；G13-A 整体验收未通过。
- 新确认：创建候选集仍全量枚举设备、筛选患者同账号设备并建立顺序表，各为 40/2,040/8,040 次；共享候选函数还使原位置事务无条件执行全设备 key/身份扫描，分别为 15/765/3,015 次。仅恢复旧事务适配器后，两类底层访问均为 0/0/0，业务输出不变；Memory/SQLite 均复现。
- 其他整改：Caddy 当前配置真实 adapt/validate 通过，本地反代伪造头 2/2；法律门禁独立正反 fixture 通过；协议前账户入口源码与编译通过，账户入口架构断言另行执行 1/1。归档/CI 接线、真实账户删除 UI、生产反代限流仍未完成。
- 复跑：check/build、后端 480/480、契约 5/5 + 后端 smoke 18/18、iPhone/Watch 编译、模拟器 128/128。插桩当前版、未插桩当前版、旧事务适配器对照各 42 条操作记录 + 10 项正确性检查，业务输出逐项一致；当前 42 个后端源文件运行后哈希未变。
- 修改文件：`docs/全项目待办与验收清单-2026-09-13.md` 更新状态与完整计数要求；新增 `docs/G13-A第一批整改复核-2026-09-13.md` 和 `docs/evidence/g13-first-batch-review-2026-09-13/`；本交接摘要。
- 下一步顺序：先复用 `deviceOrdinal`/`deviceIdsForIdentity`，将全量回退惰性化并保留事务 staged 合并；补 key 枚举/谓词计数回归；再迁移 tick、接受/退出、患者批次与 presence；最后消除同次请求 outbox/投影/索引维护的全量成本，按隔离 HTTP + Memory/SQLite、回滚/重开、业务对照验收。
- 约束：不恢复已取消的 2 万在线目标；保持半径、扩圈、顺序、去重和事务语义。下方旧章节反映各轮历史，当前 G13-A 状态以本节及最新清单为准；本轮尚未实施下一批业务修复。

## 全项目清单整改轮（2026-09-13，G14/G02/G13-A 第一批）

- 范围：按 `全项目待办与验收清单-2026-09-13.md` 修改。未部署、未提交、未连接生产库、未操作真机。
- **G14-a 已修（Caddy `header_up` 层级）**：`deploy/azure/Caddyfile` 删除了与 `reverse_proxy` 同级的 `header_up` 行——它是 `reverse_proxy` 的**子指令**，同级写法会被 `caddy validate` 拒绝。查 [Caddy 文档](https://redacted-host.invalid/docs/caddyfile/directives/reverse_proxy 后确认该行本来也不需要：反代**默认忽略**客户端提供的 `X-Forwarded-*`，只写入自己观测到的连接地址，因此伪造头到不了 Node；只有前面还有 CDN 时才需要 `servers > trusted_proxies` 加块内 `header_up`。文件内已写明这条依据与启用条件，`deploy/azure/README.md` 同步更正（此前写错的“Caddy 会保留客户端头”结论已删除）。
- **G14-a 门禁**：`backend/test/release-gates.test.ts` 新增结构检查——`header_up`/`header_down` 若出现在 `reverse_proxy` 行之前或缩进不深于它即失败，并断言“Caddy 默认防伪”的说明与 `AED_TRUSTED_PROXIES` 交叉引用仍在。本机没有 `caddy` 可执行文件，无法在测试里跑 `caddy validate`，这一点已在 README 写明。负向对照：人为插回同级行，该用例失败。
- **G14-b 已修（法律门禁测试写死占位状态）**：原 `release-gates.test.ts` 断言“仓库协议文件必须失败”，把运营待办变成了永久测试期望——补齐真实政策地址/邮箱反而会让测试变红，最自然的处理就是删掉断言。现改为对**独立 fixture** 验证门禁：全空、`http://`+`example.com`、缺正文段落三种输入必须 exit 1，完整输入必须 exit 0；仓库当前状态不再参与断言。
- **G02 已修（协议前账户管理/删除入口）**：`OnboardingView` 增加“账号管理”按钮（正文按钮 + 右上角图标），打开新的 `PreAgreementAccountSheet`，提供退出登录与删除账号（二次确认、服务端裁定 `store.deleteAccount()`、披露事件证据按留存规则保留）。此前该页面只有“签署”和“退出登录”，未同意协议的用户无法删除刚创建的账号。`ArchitectureBoundaryTests` 增加对应断言；iPhone/Watch 编译与 128 项模拟器单测通过。
- **G13-A 第一批已实施（事件创建入口）**：新增共享候选规则 `candidateDeviceKeys` 与 `recruitmentPatientPositionOf`（`src/recruitment-context.ts`），draft 与 transaction 两个适配器现在用同一套“网格候选 ∪ 患者设备 ∪ 本事务改动设备”的规则，并把“合并后恢复集合顺序”的逻辑收在一处；`src/tx-recruitment-context.ts` 改为调用它，行为不变。新增 `indexedDraftRecruitmentContext`，只给**事件创建**事务使用（`service.ts` 的 `eventCreationRecruitmentContext`）：该事务在招募前只改患者设备与触发 Watch，患者身份本身被资格判定排除，且尚无 delivery，所以此处读已提交索引是安全的——这是 ACCEPT 路径**不能**做的事（那里必须看见本事务刚建的邀请）。
- **G13-A 关键点：只并入“本事务改动的设备”，不是全部设备。** 第一版把 draft 的全部 device key 并回候选集，等于把全扫原样装回去，实测计数不会下降；改为由调用方声明改动集合后才有意义。
- **G13-A 实测（新回归 `backend/test/recruitment-scope-g13a.test.ts`）**：固定 3 名近处候选、患者 iPhone 与 Watch，远方用户 0/250/1,000（总设备 5/255/1,005）时，事件创建的候选访问为 **40/40/40**，邀请对象恒为那 3 名近处响应者，患者手机不进邀请。负向对照：把事件创建改回未接索引的 draft context，两个用例失败（0 远=40，1,000 远=**8,040**）。
- 验证：`npm run check`、`npm run build`、`npm test` **480/480**、`npm run smoke`（契约 5/5 + 后端 18/18）；`scripts/ios-smoke.sh` iPhone/Watch 编译通过，模拟器单测 **128/128**。
- **G13-A 尚未完成（下一批）**：`tick()` 仍按设计走 legacy context（`service.ts` 内有明确注释），`accept/exit` 后的招募刷新仍用旧适配器；位置更新请求的后处理仍有全量 clone 与提交后全量位置索引重建（outbox 旧事务）。清单第 240–246 行的“整个操作范围”验收因此**尚未通过**，本轮只完成“距离计算范围”在事件创建路径上的第一项，不宣称 G13-A 整体完成。
- **仍未关闭（本轮未动）**：G01 发行主体/地区/Apple 适用结论；G04 APNs 与九节点播报；G03/Watch 后台真机行为；G05 邀请过期 404 的对账 UI 路径；G06/G09 AED 归还、交接与媒体；G07 改道 15 秒确认；G08 匿名协作与 App 内联系；G11 留存执行与本人查看申请；G12 证据链与访问审计；G14 CI 与归档入口接线；G15 异机备份与恢复演练；G16 签名包与商店材料。

## 网格整改已加入全项目清单（2026-09-13）

- 按用户要求，在`docs/全项目待办与验收清单-2026-09-13.md`的G13下新增独立子项 **G13-A 招募计算局部化**，状态为待整改/未实施；同步更新总览和实施顺序。
- 范围包括所有相关招募入口复用现有网格、跨格候选与事务内变化、outbox/响应后处理的局部读取和增量索引维护；原招募半径、扩圈、去重、顺序与权限规则保持不变。
- 验收包含远方用户0/250/1000对照、远方距离计算为0且整体成本不随无关用户线性增长、无正常请求全量clone/索引重建、候选语义对照、Memory/SQLite回滚与重开、隔离HTTP+tick/outbox及完整回归。
- 仅更新清单与本交接文档，未修改业务代码、运行新业务测试、部署或提交；不恢复已取消的2万目标，不把加入待办当成修复完成。

## 网格计算范围实测（2026-09-13，仅验证）

- 用户要求实际验证网格是否缩小计算范围。本轮固定3个近处候选，增加0/250/1000名远方合成用户，分别跑Memory与临时SQLite；在源码副本统计真实distanceMeters调用，原业务代码未修改。
- 距离调用次数（0/250/1000远方，两种存储一致）：网格+精确筛选3/3/3；创建事件24/1024/4024；响应者位置更新11/11/11；tick9/509/2009；附近人数2/2/2；接受请求11/761/3011。因此索引有效且部分路径已接入，但创建/tick/接受仍全量算远方用户。
- 位置更新整个请求也未完全局部化：SQLite网格重建设备访问20/1020/4020，来自outbox旧事务等后处理；全量clone次数固定不代表复制的数据量固定。
- 42个阶段的业务结果及原有计数与未修改源码对照一致，42个后端源文件摘要不变；跨格移动、相邻格边界、SQLite重开共10项辅助检查通过；相关现有回归27/27通过。仅业务服务层/合成数据，不是公网HTTP或容量压测，无真实通知、部署、生产库操作。
- 报告`docs/网格索引计算范围实测-2026-09-13.md`，完整计数、脚本、插桩补丁与摘要在`docs/evidence/grid-effect-2026-09-13/`。
- 后续计算范围改造应复用现有事务感知网格查询，补齐创建/调度/决定等入口，并去除后处理不必要的全量复制/索引重建。当前未实施此改造，不重新引入已取消的2万目标。

## 全项目范围清单与容量目标更新（2026-09-13，最新用户决定）

- 用户明确要求去掉2万在线目标，并确认当前容量已满足需求。原固定规模容量压测不再作为本阶段上架门槛；不得继续引用下方历史容量报告要求扩容或重新证明原目标。历史报告保留为历史证据。
- 已同步修改`docs/requirements.md`的容量条款与V2-A28。当前容量按用户确认记为满足；数据一致性、历史留存、异常恢复、备份与监控仍需处理。既有数据库/部署架构另行核对，不以已取消的容量目标强制推进迁移。
- 新增`docs/全项目待办与验收清单-2026-09-13.md`，按16个工作包覆盖整个项目，区分缺实现、部分完成、待验证与待决策；此前优先缺陷不是全项目待办的全部。
- 扩展梳理到的完整需求包括：15秒改道确认、匿名团队与App内联系、AED双人交接/照片临时点、患者九节点播报、最终秒槽完整性核对、数据查看申请、30天/3年留存、证据hash/签名、访问审计、正式CI与运营能力。
- R01/R02/R08/R09与R11配置分支继续保留已复核通过的状态；下方复核中的Caddy语法、协议前账户入口、法律门禁接线及测试夹具问题仍开放。
- 本轮仅新增/更新清单、需求与交接文档，未改业务代码、未操作生产、未重复运行未变化的后端/客户端测试。后续按新清单推进，不重做已完成修复，不将已取消的容量目标重新列为阻塞。

## 修复独立复核（2026-09-13，部分通过，覆盖下方修复关闭口径）

- 本轮只验证当前工作树，未修改业务代码、部署、上传、接触生产库或提交；报告与复现仅写会话目录和/tmp，保留全部原有修改。
- 实际重跑：check/build、npm test 476/476、默认smoke契约5/5+后端18/18、iPhone/Watch编译档、Simulator 128/128均通过；另选中账户删除ArchitectureBoundaryTests用例，1/1通过，但该用例只做源码字符串断言。
- R01通过原SQL trigger故障注入复核：失败后legacy写入磁盘/内存一致，重开保留。R02补充实际取得AED及取得后退出两种场景，均没有再次分配同一台；R08/R09原回归通过；R11缺参/参考provider四个独立检查通过。
- **R12尚未关闭**：Caddyfile:24的header_up写在handle层级，官方Caddy v2.11.4 `adapt`退出1，报unrecognized directive；临时副本将它移入reverse_proxy子块后解析通过。仓库配置未改，不能部署当前文件。后端两个配额测试并未经过Caddy。
- **R07尚需三处修正**：①未签协议/协议失效时仍进入独立OnboardingView，无删除账号入口；新Tab仅改善已签协议后的权限缺失。②法律脚本仅手动调用，正式scheme本地无签名Archive仍成功，包内URL/邮箱均空，未实现自动归档阻断。③release-gates.test.ts固定要求仓库协议文件失败，隔离副本补齐合成字段后脚本成功而测试失败，应使用独立正反fixture。
- 完整复核：`/Users/REDACTED/Documents/ChatGPT/毕设项目 2/AEDResponse-修复复核-2026-09-13.md`。证据`/tmp/aed-fix-verification-20260913/`，含测试、Caddy解析、法律字段对照、无签名Archive和R01/R02复现；临时文件可被系统清理。
- 下一步先修Caddy配置、协议前账户入口、法律门禁接线与测试夹具。R03/R04/R05/R06、R07其余数据生命周期工作、R10/R13继续未完成；本地测试通过不等于签名、TestFlight、真机后台、生产容量或审核通过。

## 审查缺陷修复轮（2026-09-13，按独立审查报告修改）

- 范围：按 `AEDResponse-上架差距独立审查-2026-09-13.md` 的 P0/发布前缺口修改当前工作树，先修正确性再补配置与审核路径。未连接生产数据库、未部署、未提交、未操作真机。
- **R01 已修**：`store.ts` 的 `persistEntityChanges` 不再在 SQL 事务回调里改 `flattenedState`；缓存变更与成功指标改为事务提交返回后才应用。回归：`backend/test/store-commit-cache.test.ts`（4 项）用代理注入“revision 写失败”，验证回滚后缓存逐字节不变、失败不计入 commitCalls/upserts、随后 legacy 写入仍落盘且重开可见、回滚插入不出现。把 `store.ts` 换回 HEAD 版本时 4 项全失败（负向对照）。
- **R02 已修**：新增 `claimedAedIdsForOtherEvents`，`replanAssignments` 的不可用集合并入“其他事件仍持有的 AED”（按 `unavailableAedIds` + 未退出参与且持械状态的 `FETCH_AED` 指派判定）。回归：`backend/test/cross-event-facts.test.ts` 的两个 R02 用例（首事件取走唯一 AED 后，第二事件不得再指派；两个 AED 时两事件各得一具且互不重复）。撤销该改动时两个用例失败。
- **R08 已修**：nearby shadow 校验改为两侧同口径的每半径人数比较，不再比较 Map 大小；默认 `npm run smoke` 的后端已 **18/18 通过**（审查时 S08 返回 500）。回归用例在 `business-processing.test.ts`（12 km 远方志愿者），撤销修复即复现 `indexed=1 scanned=2`。
- **R09 已修**：位置回收豁免不再取第一条 ACCEPTED delivery，改为遍历该设备全部 ACCEPTED 记录，并补齐旧路径已有的“当前指派未退出参与”过滤。回归用例覆盖“旧事件先完成、新事件仍在进行”的组合，撤销修复时该用例失败。
- **R11 已修（配置层）**：production 缺 `AED_AMAP_WEB_KEY` 或缺 `AED_FIXTURE_FILE` 时启动即失败；`createBackend` 在 production 拒绝参考几何路线提供者；`fixtureFile` 改为可选，未配置时以空 AED 库存启动，演示目录不再是生产默认。`deploy/azure/backend.env.example` 已改为生产基线。
- **R12 已修（配置+接线）**：新增 `AED_TRUSTED_PROXIES`，认证限流只采信已声明代理对端发来的 `X-Forwarded-For` 最左条目；未声明时保持原行为。`Caddyfile` 用 `header_up X-Forwarded-For {client_ip}` 替换该头，避免客户端伪造。回归：`transport-boundary.test.ts` 两个用例（代理后不同来源各自配额；未声明对端伪造头不增配额），第一项在撤销接线后失败。
- **R07 部分已修**：`RootView` 在业务权限缺失时改为“权限 + 设置”两个 Tab，账号删除、退出登录与四项协议仍可进入，不再是只能跳系统设置的死胡同；`ArchitectureBoundaryTests` 增加对应断言。新增 `scripts/check-legal-readiness.mjs`：`privacyPolicyURL`/`contactEmail` 为空或占位时退出码 1，归档/TestFlight 前必须通过；`backend/test/release-gates.test.ts` 同时守住“该门禁必须失败”和“必须记录在发布步骤里”。
- 验证：`npm run check`、`npm run build`、`npm test` **476/476**、`npm run smoke`（契约 5/5 + 后端 18/18）；`scripts/ios-smoke.sh` 编译档 iPhone/Watch 均 `TEST BUILD SUCCEEDED`，模拟器单测档 **128/128** 通过。新增/改动的每个修复都有负向对照（先撤销修复确认用例失败，再恢复）。
- 新增文件：`backend/test/store-commit-cache.test.ts`、`backend/test/cross-event-facts.test.ts`、`backend/test/release-gates.test.ts`、`scripts/check-legal-readiness.mjs`；测试清单已加入 `backend/package.json`。
- **本轮未关闭（需要外部条件或后续轮次）**：R03 正式 Watch 证明验证器与 PHONE 短信适配器仍缺；R04 APNs 端到端（entitlement、token 生命周期、四种证据）未接通；R05 Watch 后台/表盘提醒与降腕真机行为未验证；R06 Apple 5.1.5/5.1.1(ix) 适用结论、发行主体与首发地区需向 Apple 确认；R07 剩余部分（托管政策地址/联系邮箱仍为空、Apple 授权码交换与 token 撤销、30 天/3 年留存作业与备份恢复后删除重放）；R10 scheduler/事件批次/outbox/启动加载的全量成本；R13 异机备份、恢复演练与业务探针。
- 状态口径：以上修复只证明本地契约、测试与默认冒烟通过；不代表签名包、TestFlight、真机后台、生产容量或审核结果。

## 上架差距独立审查（2026-09-13，仅审查）

- 目标：只依据当前工作树与本轮验证，评估存储关键优化后距离正式上架的差距；不采用其他聊天或历史测试结论。
- 本轮未修改业务代码、部署、连接生产数据、操作真机或 Git 提交/推送。保留全部已有未提交修改；只新增会话目录的审查报告并追加本交接摘要。
- 本轮验证：后端 check/build 通过、npm test 463/463；默认 smoke 的后端 S08 在 nearby summary 返回500，根因是 shadow 将附近索引结果与含远方用户的全量Map比较；NODE_ENV=production 的本地对照契约5/5、后端18/18通过，不代表修复或生产验收。正式 AEDResponse Release generic iOS（含Watch）无签名编译通过。
- 已独立复现两项发布阻塞：① SQLite persistEntityChanges 在 SQL commit 前修改 flattenedState，注入元数据写失败后缓存污染，后续 legacy 写入可报告成功但重开丢失；② 同一 AED 在事件A已AED_ACQUIRED后，仍被另一活动事件B分配为FETCH_AED。
- 其他确认缺口：正式main缺Watch verifier、通知只有Socket无APNs、权限门禁挡住删除账号、线上政策URL/联系信息为空、Apple撤销及留存执行闭环缺失、生产默认demo/参考路线、代理IP共用认证配额；活动响应者TTL豁免只取第一条历史ACCEPTED，函数级检查复现误判。
- 后续先修存储提交一致性/AED跨事件约束与回归，再打通正式Watch/APNs；并行确认Apple定位紧急服务/提交主体要求及Fall发行能力。scheduler、事件batch、outbox仍有全量成本，容量需按新基线重测，不复用历史人数结论。
- 完整报告：`/Users/REDACTED/Documents/ChatGPT/毕设项目 2/AEDResponse-上架差距独立审查-2026-09-13.md`。日志与纯合成复现证据位于 `/tmp/aed-release-audit-*`，正式Release日志 `/tmp/aedresponse-readiness-release-20260913.log`；临时文件可能被系统清理。
- 尚未完成：缺陷修复、签名/真机后台与完整Watch闭环、生产混合长稳/恢复演练、App Store Connect材料与审核结果。不得把无签名build、本地注入适配器或Socket emit当成这些验收通过。

## 380 MiB 容量复测完成（2026-09-12 14:13 UTC）

- 13档独立合成库测试（256/380对照，30/60/120秒）。380下按100次位置写/s口径，最高已通过档位为 **3,000常驻用户**：60秒5,999/6,000 applied、p95≈350 ms、p99≈605 ms；**4,000@100失败**（p95≈553 ms、p99≈1,440 ms）。2,000@100通过且余量更大。
- 低频纯待命 **5,000@42次/s** 通过120秒，5,039/5,040 applied、p99≈454 ms。10,000@84失败；20,000在380 old-space下仍V8 heap OOM，未监听。
- **旧“1,000@100上限”只是已测档位，并非精确上限**：本轮256 MiB、3,000@100对照也通过60秒（p99≈729 ms）。不能将此次发现解释成调堆后容量提升三倍；没有证明吞吐上限大幅提高。
- 范围：同VM、同release/进程限制、每档新副本、真实HTTP/鉴权/SQLite；无活动事件、Socket在线连接或长期历史。非完整P20/60分钟验收，不把常驻数据量当真实在线人数。
- 报告与原始证据：`backend/logs/p20-380-20260912-1355/report.md`及同目录summary/results/metrics。工具`backend/scripts/loadtest/p20-capacity.py`。服务器独立证据目录`/home/REDACTED/aed-p20-380-20260912-1355`。
- 现场：所有测试单元已清理，20份机队raw-token文件已删；现网PID仍127858、NRestarts=0、380 MiB参数不变、本机及公网healthz正常。未改业务代码、现网库、提交或部署。

## V8 老生代上限调整为 380 MiB（2026-09-12 13:50 UTC）

- 按用户明确要求，将运行服务的 `--max-old-space-size=256` 改为 `380`。使用 `/etc/systemd/system/aedresponse.service.d/90-v8-heap.conf` 覆盖 ExecStart；基础 unit、业务代码、数据库及其他配置未改。
- 原配置已备份：`/var/backups/aedresponse/heap-limit-20260912T135020Z`。已 daemon-reload、重启；实际 `/proc/127858/cmdline` 包含 `--max-old-space-size=380`，本机与公网 healthz 均为200/ok。
- `MemoryHigh=384M`、`MemoryMax=512M`、`MemorySwapMax=512M` 保持原值。380 是 V8 老生代上限，不是进程总内存上限。
- **尚未在380 MiB配置下复测容量**；下方压测报告对应旧256 MiB配置，不得描述为380配置实测。本次不代表2万在线验收通过。

## 服务器 P20 必要门槛压测（2026-09-12，切换后）

- **结论：当前服务器/配置不能达到 2 万在线目标。** 在同 VM、与当前 release 编译哈希一致的隔离实例上测真实 HTTP/SQLite；未动现有实例或数据库。
- 1,000 常驻用户，100 位置 RPS 短测全部 applied，p95 51.8 ms；5,000 用户，167 RPS 时 2,505 个计划请求只有 2,058 个 applied 确认，352 超时+95 未发出，p95≈10 秒；20,000 用户（100,000 行、约 60.2 MiB、integrity=ok）在启动阶段触发 **256 MiB V8 heap OOM / SIGABRT**。
- 机器仍为 2 vCPU/892 MiB RAM，服务 MemoryMax=512M / V8 heap=256M。2 万纯待命用户每 120 秒位置一次就需≈167 RPS；完整 P20 还要求20万注册/100事件/2000参与者/800 REST/4000消息/60分钟，本轮在更轻必要子集已失败，没有继续长稳。
- 不混淆：常驻用户数≠实际Socket连接数；本轮未压Socket/活跃事件/批次。失约比例包含客户端积压丢弃与超时，不等于HTTP错误率。1000用户800位置RPS饱和档有合法stale保护，不认定为数据丢失。
- 增量路径确已使用（fallback=0），但5,000用户约30秒采样仍有30次Legacy tick、60次全量clone、30次flatten。后续先审计启动内存放大和scheduler全量工作，再做完整P20。
- 现有服务PID前后均124286、active、公网healthz=200；所有压测transient units已清理，独立18787端口关闭，合成机队raw tokens已删除。未提交、推送、部署或修改业务代码。
- **完整报告/原始证据**：`backend/logs/p20-20260912-1305/report.md`（同目录summary/result/metrics/server日志，均gitignore）；工具 `backend/scripts/loadtest/p20-{server,loadgen}.mjs`、`p20-run.py`。服务器留存独立合成库/日志 `/home/REDACTED/aed-p20-20260912-1305`。

## 位置主路径增量事务接通（2026-09-12）

- 已删 `updateResponderPosition` 的“相关事件→全量事务”分叉；位置、回执和招募副作用同一次实体事务，只有缺 `transactEntities` 能力才回 Legacy。
- 完整保留旧 gate/全活跃招募范围、拒绝 JSON 与副作用顺序；修复 Tx 地理候选漏无 R 位置患者，以及候选并集打乱患者通知顺序。SQLite 重启与关闭计时模式的索引维护缺口也已补齐。
- 本轮插桩**未复现投影清空**：devices/回执-only 提交前后 size 均为 1；原 API 超时来自漏患者受众。详见 `docs/handoff-4b2-position-path.md` §11，§4 留作历史诊断。
- 验证：check/build 通过；完整后端 **463/463**（基线 404）；新增真实 Memory/SQLite 原子回滚、完整位置差分、索引生命周期和破坏性守卫；`git diff --check` 通过。
- 业务事务零全量 clone/flatten/history compare，四类候选计数非零且无关历史 0→250 时不变。**完整接口尚非 O(Δ+相关集)**：presence 尾段 delivery/assignment 仍随历史增长；有通知时 outbox drain 仍有全量读写；其余键扫描与投影维护也待整体审计。未测 ≥200 次/秒，Phase 1 整体验收未完成。
- 主要文件：`backend/src/{service,tx-recruitment-context,recruitment-context,assignment-index,store}.ts`、三份新测试及三份既有守卫、`backend/package.json`。完整本轮文件/快照/日志与下一步见上述 §11。
- 保留所有已有未提交改动；本轮未提交、推送、建 PR、部署或操作生产数据。不要重做已通过的切换；后续在冻结业务语义下推进完整接口成本与容量验收。

## 后端容量压测与两处运维缺陷修复（2026-09-11，DSH 第七轮）

- **交付**：`docs/load-test-2026-09-11.md`（完整实测报告）、`backend/scripts/loadtest/`（可复现压测工具 + README + 原始扫描日志）。
- **被测对象**：线上 `aedresponse.service`（真实进程 / 真实 `state.sqlite` / 真实 Caddy 入口）。用户首选 Windows 压测机，实测 Windows 离线（最后在线 21h 前）且本机 Tailscale 亦离线，按用户指示回退为服务器本机生成负载。
- **关键结论（实测，非推算）**：写事务硬上限 **~10 次/秒**，且**与并发数完全无关**——`GET /api/v2/events` 在 C=1…64 吞吐恒定 ~10 RPS，延迟线性膨胀（p50 93 ms → 25 s）；p95≤500 ms 在 **C=4 即破**。对照：不碰状态的 `/healthz` 达 **6,800 RPS**，瓶颈 100% 在存储层。
- **根因**：`SQLiteStateStore.transact` 每次写都做 **全量 clone + 全量 Zod 校验 + 全量 append-only 历史检查 + 全量 flatten**，单队列串行。分相实测（955 实体 / 1.42 MB）：clone 6.06 ms、**校验+历史+深比较 40.15 ms**、持久化 ~0 ms。三点放大：①`GET /events` 与 `GET /me/presence` 都调用内含 `transact` 的 `tick()`，读接口实为写；②每次 Socket 连接经 `touchDevice` 开一次事务，**建连上限被钉在 ~10 条/秒**（500 并发连接失败 291 条）；③`listAeds`/`getNearbyVolunteerSummary` 每次 `store.read` 全量克隆（仅 ~65 RPS）。
- **容量随数据量线性下降（线上实测）**：54 用户 9.90 tx/s → 504 用户 6.51 → 2,504 用户 1.86 → 5,004 用户 1.01 → 10,504 用户 **0.41**（单事务 p50 26 s）。内存不是墙（10,504 用户 RSS 306–343 MB，未触 512 MB 上限）。
- **换算"能承受多少用户"**：按需求 §45 待命 120 s/次的流量模型，自洽解 **~560–630 同时在线待命用户**（两组拟合参数一致，取 ~600）；留出事件/读取/重连余量后**实际 250–500 人**；**事件参与者 40–60 人**（每人成本是待命的 24 倍，需求 §47-48 的 1 Hz/5 槽一批）。P20 目标（2 万在线 / 800 RPS / 2000 参与者）**不可达**：空库时写上限即只有目标的 1/80，到承载 2 万用户的数据量后差距 4 个数量级；20 万注册用户外推单事务 ~9 s。
- **边界**：未压事件进行中负载（模拟事件入口未启用白名单）、Watch 备用上传、APNs、60 分钟长稳；压测机与被测进程共享 2 vCPU，故数字为偏保守下界。
- **两处运维缺陷已修复并验证**：
  1. **`aedresponse-backup.service` 每日备份自 09-11 03:18 起静默失败**（`backup-sqlite.sh: No such file`）。根因：`/opt/aedresponse/current` 是指向 release 的符号链接，09-11 02:04 发版整体替换发布树，而该树不含 `deploy/`（`before-controlled-20260908-1315` 之后的所有 release 都没有）。修法：脚本装到发布树之外的 `/usr/local/sbin/aedresponse-backup-sqlite.sh`，unit 的 `ExecStart` 同步改；仓库 unit 与 `deploy/azure/README.md` 已更新并写明原因。验证：手动跑 `success/exit 0`，产出 2,408,448 字节、`integrity_check=ok`、955 实体的备份；timer 下次 09-12 03:21 UTC。顺带清掉备份目录里 4 组 09-08 残留的 0 字节 `-wal`/孤立 `-shm`（清前逐个验过主文件）。
  2. **Caddyfile 残留 09-08 蜂窝诊断路由** `/__native-cellular/20260908-native-1131/*` → `127.0.0.1:8788`（后端已停，502）。修法：用仓库 canonical `Caddyfile` 覆盖（`diff` 证明它与 `Caddyfile.before-native-cellular-20260908` 逐字节一致），`caddy validate` + `reload`。验证：`healthz=200`、未认证 `/api/v2/*` `=401`、旧探针路径 `=404`、证书有效至 2026-12-07。README 已补"临时诊断路由必须显式回退"的检查步骤。
- **现场恢复**：压测前备份 `state.pretest-20260911T124839Z.sqlite`；全部合成用户已清除，`state.sqlite` 还原为压测前原字节（4 账户/4 用户/495 位置批次/46 会话）并 `integrity_check=ok`；服务 `active`、公网 `healthz=200`。修复后 VM 上 backup unit 与 Caddyfile 均与仓库文件**逐字节一致**。

## 冒烟测试套件（2026-09-11，DSH 第六轮）

- **交付**：`scripts/smoke.sh`（统一入口，分层跑并汇总）、`backend/test/smoke/{support,backend.smoke,contract.smoke,yaml}.ts`、`scripts/ios-smoke.sh`、`docs/smoke-testing.md`（设计与用例矩阵）。后端新增 `npm run smoke:backend` / `smoke:contract` / `smoke`，不进入既有 `npm test` / `test:business` 清单。
- **边界**：冒烟只验证关键链路是否还通，不替代 `npm test`、`ios/AEDResponseTests`、真机验收或 `docs/requirements.md` 的 V2-Axx 逐项验收；刻意排除 30 秒/30 分钟/35 分钟真实时序、批次时间窗全组合、SQLite 重开、留存 TTL、并发与限流。
- **后端层**：18 步（S01—S18）在 `127.0.0.1` 随机端口 + 内存 store 上按顺序跑完 登录门禁 → Watch 绑定 → Fall 事件 → P/R 写入与来源不倒退 → 招募与候选隐私投影 → 接受/拒绝 → 严格秒槽位置批次 → `FETCH_AED`（`R→A→P` 路径、`EN_ROUTE`/`ARRIVED_AT_AED`、`AED_ACQUIRED` 201→200 幂等、`aed:acquired` Socket 推送）→ 患者 resolve 与会话收敛 → 16 KiB 报文边界。实测 **18/18 通过、约 0.44 s**（时间推进用可控时钟，无真实等待）。
- **契约层**：5 步（C01—C05）用零依赖 YAML 子集读取器解析 `contracts/openapi.yaml`，校验 36 个 operationId 唯一、201 处内部 `$ref` 可解析、65 个错误响应共用 Problem schema，并用**真实响应体**对照文档 schema（含 `unevaluatedProperties` 组合语义），再核对 `src/server.ts` 的 35 个路由模板全部有文档、demo fixture 符合 `aedSchema`。实测 **5/5 通过**。
- **客户端层**：`scripts/ios-smoke.sh` 分三档——A 编译档（iOS TestHost+AEDResponseTests+WatchLogic 与 watchOS app+测试包，`CODE_SIGNING_ALLOWED=NO`，`-clonedSourcePackagesDirPath ios/.build/SourcePackages` 离线复用，两侧均 `** TEST BUILD SUCCEEDED **`）、B `IOS_SMOKE_SIMULATOR=1` 模拟器纯逻辑单测切片（实测 `Executed 122 tests, with 0 failures`）、C `IOS_SMOKE_UI=1` TestHost UI 冒烟。**Xcode Cloud 不可用**：Apple 要求配置工作流需 Apple Developer Program 会员资格（<https://developer.apple.com/xcode-cloud/get-started/>），本机只有 Personal Team `GR6YBCDW7R`，故改本机执行。排除 `LiveAzureTransportTests`、`testOptInLiveScreenEvidence`、`AEDResponseControlledTests`、`AEDResponseWatchTests`（本机无配对 Watch 模拟器）与 `ArchitectureRepairChecks`；编译档不构成真机/物理 Watch/真实登录/蜂窝证据。

## 真机双机业务测试：17 Pro + 16 全链路（2026-09-11，DSH 第五轮）

- **范围与授权**：用户要求“通过 Xcode 调用 17 Pro 和 17 做真实业务测试”，并指定为**真机 iPhone 17 Pro + iPhone 16**、连 **Azure 联调后端**、跑全流程；用户批准临时重新启用双机模拟事件入口，角色为 **16 患者 / 17 Pro 响应者**（沿用 09-11 已批准方向）。
- **设备与身份**：17 Pro = `REDACTED-ID-1b2244d3fb512e43`（app 设备 `REDACTED-ID-54fff01183c8c2cc`／user `REDACTED-ID-653cf3b0a66ed80d`，APPLE）；16 = `REDACTED-ID-23bf5fb9062ba588`（app 设备 `REDACTED-ID-cc7195170496f8e7`／user `REDACTED-ID-bdf42048c0ea799e`，APPLE）。两机服务端四项协议已签、定位+通知已授权、`availableForResponse=true`。
- **客户端构建**：按当前源码重建 `AEDResponseControlledTests`（Debug，generic/platform=iOS），签名 `Apple Development: [REDACTED SIGNING IDENTITY]
- **构建环境注意**：Xcode 设备构建需要写 `~/Library/Caches/org.swift.swiftpm`，在 workspace-write 文件沙箱下报 `Operation not permitted` 导致 “Could not resolve package dependencies”；本轮按规则一次性提权重跑后成功。后续轮次构建请预期此点。**2026-09-11 第六轮补充**：`scripts/ios-smoke.sh` 支持 `IOS_SMOKE_CACHE_ROOT=<可写目录>`，把 SwiftPM manifest/module cache 与 Clang module cache 重定向到该目录，可在沙箱内完成构建；未设置该变量时仍需提权。
- **VM 配置变更（已回滚）**：模拟事件入口无需新增开关——`enableSimulatedEvents` 由 socket 存在即自动为 true（`config.ts:167`），socket 由 drop-in `/etc/systemd/system/aedresponse.service.d/simulation-admin.conf` 提供，受控账号开关由 `controlled-test.conf` 提供。本轮**只**新增了 `AED_SIMULATION_APPLE_DEVICE_IDS=1E44CA9C-…,7418170C-…`（线上为精确 `includes` 比较，必须与库内原样大写一致），重启后 12:06:14Z healthz 200。备份 `/var/backups/aedresponse/backend.env.before-sim-whitelist-20260911T120613Z`；**测试后已恢复该备份并重启**，服务 `active`、公网 healthz 200、运行时环境已无白名单、临时脚本与清单已删除。事件入口回到“IPC 在听但 Apple 设备不在白名单”的测试前姿态。
- **IPC 客户端可用性**：发布包**不含** `deploy/azure/create-simulated-event.mjs`（需从工作树拷入）；且该校验 socket 属主与调用者一致，必须以服务账号提交（`sudo -u aedresponse`），清单需放在该账号可读位置。已用 `/run/aedresponse/create-simulated-event.mjs` + 服务账号提交两次成功。
- **事件 1（正常结束）`REDACTED-ID-9c13471a1053740f`**：12:09:52.382Z 成立 `ACTIVE/RECRUITING`；delivery `63e3c6fd` → 17 Pro，`VIEWED` 12:09:52.663Z；**用户确认在 17 Pro 屏幕上看到请求卡**；`ACCEPTED` 12:10:04.432Z（创建后 12 秒，30 秒窗内）；assignment `f56ee396` `role=GO_TO_PATIENT` `ASSIGNED` rev1 12:10:05.276Z；响应者退出 → assignment `CANCELLED` rev2、`exitedResponderUserIds=[10406e63…]` 12:11:03Z；患者结束救助 → `RESOLVED/PROBLEM_RESOLVED` 12:11:40.657Z，resolution 归属 `PATIENT`／设备 `7418170C`。timeline 11 条：`EVENT_ACTIVATED→PASSIVE_OBSERVATION×2→RESPONSE_REQUESTED→RECEIPT_ADVANCED×2→RESPONSE_ACCEPTED→ASSIGNMENT_CREATED→ASSIGNMENT_UPDATED→RESPONDER_EXITED→EVENT_RESOLVED`。
- **退出 ACK 权威时间窗（第四轮修复）在真机+真实服务端得到验证**：17 Pro 56 条秒槽记录覆盖 12:10:05→12:11:00，**退出 ACK（12:11:03Z）之后 0 条**；患者 108 条覆盖 12:09:53→12:11:40，终态秒后 0 条。两事件合计 39 个批次；设备释放正确（17 Pro 退出后 `currentEventId=None`+`availableForResponse=true`；患者在事件中 `availableForResponse=false`，结束救助后恢复 true）。
- **事件 2（误报）`REDACTED-ID-57e231d9537523ab`**：12:12:07Z 成立；重复投放的请求卡**再次出现在 17 Pro**（`VIEWED` 12:12:07.992Z，用户确认）；患者确认误报 → `CANCELLED_CONFIRMED_FALSE_ALARM/FALSE_ALARM` 12:12:20.263Z，delivery 转 `EXPIRED`，两机立即回收。timeline 8 条（`…FALSE_ALARM_CONFIRMED`），resolution 归属 `PATIENT`／`7418170C`；患者 12 条记录 12:12:08→12:12:19（终态即停）。
- **“用户没看到请求”未复现**：上一轮撤回的界面展示结论本轮由用户本人确认看到卡片（两次事件各一次），因此不认定界面不展示为既有缺陷；但 `VIEWED` 回执仍在创建后约 280ms 由 `onAppear` 自动置位，**仍不能单独作为“用户看到”的证据**。
- **缺陷记录（用户决定只记录、本轮不修）**：正常终态被当成错误弹窗——「操作未完成／REST 状态同步失败：…」。触发链：`handleResponseOfferExpired`（`AppStore.swift:4830`）→`clearResponseRequest()`→`reconcileEvent`（行 4843）→ `GET /api/v2/events/{id}`；服务端 `getEvent` 对不可见设备抛 **404**（`eventProjection` 在该设备既非患者、又无 live delivery、也非已接受响应者时返回 undefined，`service.ts:580/598-604`），不是 403；客户端 `reconcileEvent`（行 4512）只在 **404 且 `isExitedEventTombstoned`** 时静默忽略，而 tombstone 只对本机执行过的退出写入（行 2228），候选从未接受因此没有 tombstone → `lastError` → `RootView.swift:24` 弹「操作未完成」。**用户确认发生时机为 17 Pro 在误报事件结束后**；同一路径也会在 30 秒自然过期时触发。列表路径 `reconcileVisibleEvents` 有 `isExitEventSuppressed` 过滤，单事件路径没有。修复方向：单事件对账把“服务端已不可见且本地 offer/assignment 已清空”视作正常终态静默丢弃，并补回归测试。用户另提到“第一轮 16 也有”同类弹窗，但弹窗已关闭、无原文，本轮未取到该机证据，需单独复现。
- **观测（未定性为缺陷）**：响应者参与期间 56 条记录只有 4 条 `FIX`，且严格 15 秒一条（12:10:08/23/38/53），其余 52 条 `NO_NEW_FIX`；患者同期 96/108 为 `FIX`、约 1 Hz。逐秒记录语义本身合规（未伪造坐标）。两种待区分成因：静止设备在 `pausesLocationUpdatesAutomatically=true`（`DeviceServices.swift:51`）下被 iOS 降频，或接单后未把待命节奏提升为事件节奏。需在“响应者真实移动”的条件下复测才能定性。
- **本轮未覆盖**：真实 Watch／Fall Detection／Emergency SOS（entitlement 仍未获批）、APNs（未实现，请求只在 App 内出现，无推送）、`FETCH_AED` 与多人 AED 分工（N=1，两机上限）、锁屏/挂起后严格秒槽、纯蜂窝腿、真人登录（本轮为 refresh 续期）。
- 证据：`/tmp/aed-17pro.log`、`/tmp/aed-16.log`（devicectl `--console`，App 无 stdout 输出）、`/tmp/aed-device-build`；服务端事实在 VM `state.sqlite`（事件/批次/delivery/timeline 行）。工作树新增文件为 0（临时脚本放在 `/tmp` 与 VM，未进仓库）。

## iOS 全量测试转绿：退出 ACK 权威时间窗缺陷已修（2026-09-11，DSH 第四轮）

- **结果**：iOS 模拟器全量 `AEDResponseTests` **354 项 / 0 失败**（基线为 18 项失败），后端 `npm test` **203/203**。至此“iOS 全部失败测试”这一目标达成。
- **缺陷根因（靠探针定位，不是猜的）**：退出 ACK 的 `exitedAt` 原来只经 `applyEventPositionParticipationWindow` 的内存路径落盘。当 `persistEventPositionQueue` 因队列暂时不可写而失败时，`eventPositionAwaitingAuthoritativeWindow=true`，而恢复路径要从 `authoritativeEndedAtByContext`（或 `eventPositionContextEndedAt`）取权威结束时间才能重放——但两者都是空的（探针实测 `record(keys=1, saved=false)`、`ended=[:]`），于是设备永远卡在“等待权威时间窗”，密封批次也永远不再上传。
- **修法（四步，每步都有代码与测试支撑）**：
  1. 新增 `recordAuthoritativeExitWindow(eventID:userID:endedAt:)`：在**任何**窗口对账之前，先把 ACK 的排他结束时间写进受保护队列（`authoritativeEndedAtByContext`），上下文来源覆盖持久化批次、持久化开放草稿，以及内存中的活动上下文。
  2. 两个 `applyAuthoritativeExitWindow` 入口（内存上下文路径 / 旧事件 pending 路径）都先调用它，因此**对账失败不再等于 ACK 时间丢失**。
  3. 若这次写入也失败，把该边界暂存到内存 `pendingAuthoritativeExitWindow`（`recordParkedAuthoritativeExitWindow()` 负责重试并消费），因为 ACK 是这个边界的唯一来源，进程内不留任何痕迹就再也拿不回来。
  4. 恢复路径 `applyAwaitingAuthoritativeExitWindow()` 先重试写回被暂存的边界，再用它对内存事实与**持久化开放草稿**（`EventPositionWindowReconciliationCoordinator.reconcilePersistedOpenDraft`）收束，成功后才清除 `eventPositionAwaitingAuthoritativeWindow`。
- **同时修掉一个位置证据语义风险**：上一轮试过把开放草稿对账直接塞进通用 `retryPersistedAuthoritativeExitWindows()`，会让 `testPatientPriorityRestSnapshotClosesMissingResponderContextAndStartsNewPatientStream` 回归——对已被内存路径收束的旧草稿重复收束会复活越界秒槽。现在草稿只由两条明确路径处理（内存 `applyEventPositionParticipationWindow`，或 await 恢复里的 `reconcilePersistedOpenDraftIfPresent`），并在该处写明原因。
- **新增回归测试**：`testPersistedOpenDraftReconciliationIsIdempotentAcrossRetries`（重放同一权威窗口不得重复隔离同一秒、草稿必须保持稳定）。
- 之前为定位加的探针（`authoritativeExitWindowProbe`）已全部删除，`git diff --check` 干净。

## 协议正文与隐私政策可达性（2026-09-11，DSH 第三轮）

- 目标：把 5.1.1(i) 从“只有一行摘要 + 一个勾选”做成**用户真能读到正文**的同意门禁，并把缺的托管 URL / 联系邮箱留成显式替换点。
- **契约新增 `contracts/agreements.json`**：四份协议（患者 / 志愿响应者 / 隐私政策 / 敏感个人信息）的完整中文正文（分章节），外加 `privacyPolicyURL` 与 `contactEmail` 两个待填字段。版本号必须与 `demo-scenario.json` 的 `agreementVersions` **逐字一致**（否则记录的“同意版本”与展示的正文不是同一份）；已有测试强制这一点。
- **隐私政策实际写了什么**（都是与本 App 真实行为一致的披露，不是模板套话）：收集精确位置/手机号摘要与后四位/App 内随机设备标识/跌倒事件与 120 秒内外拨观察；不收集通讯录、短信、照片、麦克风、原始传感器、原始心率，不做跨 App 追踪、不接广告或分析 SDK；待命位置只留最新值 10 分钟删除；事件数据前 30 天在线层、第 31 天起加密封存、满 3 年删除精确轨迹/照片/消息/设备关联；撤回或删除后立即停止新采集并撤销会话，非事件数据 15 个工作日内删除，已形成的事件证据按封存规则保留；不出售个人信息；HTTPS/WSS 传输、凭据进钥匙串。志愿响应者协议明确写“本 App 不会把你变成急救人员”，并要求先自行拨打急救电话。
- **iOS 实现**：`AgreementDocument`/`AgreementDocuments` 模型（`isReadable` 校验正文完整、`isReadyForSubmission` 在托管 URL 非 HTTPS 或邮箱是 example 占位时**保持 false**）；`ResourceLoader.agreementDocuments` 走与 App 相同的契约解码器（有单测证明能解码真实打包资源）；新增 `AgreementDocumentView`（阅读器）+ `AgreementLinkRow`（“阅读全文”入口）。Onboarding 四张卡改为 `agreementCard(...)`：显示正文摘要 + 可打开全文 + 勾选；文档缺失时改为橙色告警卡且**不出现勾选**（fail closed）。Settings 的同意记录每行都可重新打开对应正文，并额外给出“在线隐私政策”入口（配置了 URL 时才显示）。
- **资源接线**：`agreements.json` 加入 App / TestHost / ControlledTests 三个 target 的 Copy Resources（XcodeGen 重新生成工程，`agreements.json in Resources` 6 处、`AgreementDocumentView.swift` 8 处）。已验证资源真的进了产物：`AEDResponseTestHost.app/agreements.json` 可被 `plutil` 读出。
- **本轮测试**：iOS 全量 **354 项 / 1 项既有失败**；后端 **203/203**。新增测试：`testBundledAgreementsAreReadableAndCoverRequiredDisclosures`（版本一致、正文可读、隐私政策必须包含精确位置/10 分钟/30 天/3 年/删除账号/15 个工作日/不出售/不跨 App 追踪等关键词、志愿协议不得自居急救、未填托管 URL 时不得视为可提交）、`testBundledAgreementResourceDecodesWithContractDecoder`（运行时解码真实打包资源）、`testConsentGateExposesReadableDocumentsWhenPresent` / `testConsentGateFailsClosedWithoutReadableDocuments`。
- **仍需用户提供**（否则 `isReadyForSubmission` 恒为 false）：①托管隐私政策的 **HTTPS URL**；②**真实联系邮箱**。填入 `contracts/agreements.json` 顶部两个字段即可，无需改代码。正文本身是工程侧按真实数据流写的，若法务要求调整措辞，直接改同文件的 `sections`。
- **`AEDResponseControlledTests` 与 TestHost 共用 Bundle ID：判定为“有意为之，不改”**。runbook 记录：该 scheme 复用已安装的 Tests 槽位，且该 Bundle ID 就是受控后端注册的 Sign in with Apple audience；改名会让用户的既有设备注册失效并破坏受控 Apple 登录。已在 `project.yml` 写明原因，并确认它不是发布 target。

## 上架阻塞项第一批修复：隐私清单 / 出口合规 / 应用图标 / 账号删除（2026-09-11，DSH 第二轮）

- 本轮在上一批回归修复基础上按 App Store 要求逐项清除阻塞项，全部以真实构建与测试为证。
- **隐私清单（阻塞项）**：新增 `ios/AEDResponse/PrivacyInfo.xcprivacy` 与 `ios/AEDResponseWatch/PrivacyInfo.xcprivacy`，声明 `NSPrivacyAccessedAPICategoryUserDefaults` + 理由 `CA92.1`（发布代码只有 `UserDefaultsAgreementStore`/`UserDefaultsDeviceIdentityStore` 与 `WatchPersistence` 用 `UserDefaults.standard` 读写本 App 自己的键）。`FileTimestamp` 只出现在 `#if DEBUG && (AED_CONTROLLED_TEST || AEDRESPONSE_TEST_HOST)` 的 `ControlledTestAuthSessionStore`，不进发布二进制。`NSPrivacyTracking=false`、tracking domains 空；采集类型刻意留空，改由 App Store Connect 问卷声明（清单里写错采集类型反而更糟）。已实际验证 manifest 进入产物：`AEDResponseTestHost.app/PrivacyInfo.xcprivacy` 存在且 `plutil` 可读出上述键。
- **出口合规**：两个发布 Info.plist 与 `project.yml` 均加 `ITSAppUsesNonExemptEncryption=false`（只用自家 HTTPS，无非豁免加密），避免每次上传都卡在 App Store Connect 的出口合规提示。
- **权限文案**：`NSLocalNetworkUsageDescription` 原文写“连接用户明确指定的 AEDResponse v2 测试服务”，已改为生产语义（iOS + Watch）。
- **应用图标（阻塞项）**：新建 `Assets.xcassets/AppIcon.appiconset`（iOS + Watch 各一套），图标为 1024×1024 **无 alpha** PNG（iOS 图标不允许透明）。`project.yml` 为两个 app target 显式声明 `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`。已验证产物：构建出的 app 内含 `Assets.car`、`[REDACTED_EMAIL]`、`AppIcon76x76@2x~ipad.png`。
- **应用图标重做（用户复审后，2026-09-11）**：用户否掉了首版图标（“这个心不像心，然后把线变得细长一点，最后要突出 AED”）。首版心形由四段自造贝塞尔拼成，实际渲染为洋葱/水滴形；心电波形线宽达画布 5.5%；画面无 `AED` 字样。重做三点：①心形改用经典双瓣心形曲线（`classicHeart`，512 框内 6 段三次贝塞尔，凹口/圆瓣/收窄底点齐全）；②心电线宽 5.5% → **9/1024 ≈ 0.88%**，且除牌匾 3 px 高光外无第二条粗线；③`AED` 用 `.black` + rounded 字重排在画面下方红色胶囊牌匾上（字高 180、牌匾 676×220），成为画面上最大元素，视觉顺序为 **AED → 心形 → 细线**。生成脚本从 `/tmp` 移入仓库 `scripts/make-appicon.swift`，新增 `--install` 直接装进两套资源目录；PNG 由脚本内置编码器直出 **RGB 色彩类型 2**（CRC32 + Adler-32 + `COMPRESSION_ZLIB`），不再依赖 `sips`、也不再走 JPEG 中转（JPEG 会在红白硬边产生振铃）。已验证：`actool --platform iphoneos` 退出码 0 且零警告并派生 `[REDACTED_EMAIL]`/`AppIcon76x76@2x~ipad.png`；`scripts/ios-smoke.sh` 的 iOS 与 watchOS 编译档**双档 PASS**（`** TEST BUILD SUCCEEDED **`），构建出的 `AEDResponseTestHost.app` 内 `[REDACTED_EMAIL]`（`05d977f0…`）与 `AppIcon76x76@2x~ipad.png`（`8fe726c9…`）与 actool 直出产物 sha256 完全一致，`Info.plist` 的 `CFBundleIconName=AppIcon` 与 `CFBundleIconFiles` 正确；watchOS 侧 `AEDResponseWatch.app` 内 `Assets.car` 与 `CFBundleIconName=AppIcon` 均已就位（watchOS 图标编入 `Assets.car`，不落单图）。两套 `AppIcon-1024.png` sha256 一致（`cbab50f9…`）且与脚本重新生成结果逐字节相同；`file` 确认为 `8-bit/color RGB` 非 RGBA；40 px 下 `AED` 仍可读。设计约束与复现步骤见 `docs/design/app-icon-v2-2026-09-11.md`。补充说明：单独跑 `actool --platform watchos` 在本机沙箱内会因 `AssetCatalogSimulatorAgent` 无权写 `~/Library/Developer/CoreSimulator` 而报权限错，与该 catalog 内容无关，watchOS 资源已由上面的 watch app 构建验证。
- **工程再生成（顺带修好陈旧 pbxproj）**：用 XcodeGen 2.46.0 从 `project.yml` 重新生成 `ios/AEDResponse.xcodeproj`，使此前“磁盘上有、工程里没有”的 `LocationFixValidityTests.swift`、`WatchLocationProviderTests.swift` 真正参与编译（测试总数 342 → 349），Bundle ID 与 spec 完全一致。
- **账号删除（阻塞项，三层齐做）**：
  - 契约：`contracts/openapi.yaml` 新增 `delete /auth/account`（202 + requestId/status/requestedAt/erasureStartedAt，401/403）。
  - 后端：`models.ts` 新增 `DeletionRequestRecord` 与 `deletionRequestsById`；`store.ts` 纳入归一化、形状校验与**不可变**审计保护；`identity-access.ts` 新增 `requestAccountDeletion`（幂等；同一事务内删除 provider 凭据与 `accountIdByProviderKey` 索引、Watch 绑定 ticket、该身份全部设备及其待命位置/回执、全部会话记录、user 行，并写入最小审计——审计内**不含**手机号/后四位/provider 摘要/设备 ID）；`service.deleteAccount` 与 `server.ts` 的 `DELETE /api/v2/auth/account`（仅 ACCOUNT bearer 可删，DEVICE bearer 403）。事件证据按需求 §150 保留不删。
  - 客户端：`AuthClient.deleteAccount` + `SessionLogoutClient.deleteAccount`（离线/测试客户端默认 fail closed 抛 `unsupportedOperation`）；`APIClient.deleteAccount()` 用 account bearer 发 DELETE、校验 `status == "REQUESTED"` 后才清本地凭据；`AppStore.deleteAccount()` 先停业务服务、**服务端确认前不清本地登录**，成功后走 `finishLocalLogout(enqueueTransientRevocation: false)`，失败保留登录并置 `pendingConnectionRecoveryAfterDeletionFailure`，下一次前台才重连（不做失败即狂重连）；`isDeletingAccount` 供 UI 反馈。`SettingsView` 新增“删除账号”入口（`settings-delete-account-button`）、二次确认 alert、后果文案明确写出“已形成的急救事件记录按留存规则保留”与“不可撤销”。
- **本轮测试证据**：后端 `npm test` **203/203 通过**（新增账号删除幂等/越权/审计不残留个人信息/HTTP 202 共 3 项，原有 200 项无回归）；iOS 模拟器全量 `AEDResponseTests` **349 项 / 仅 1 项既有失败**（`testExitACKAtWindowBoundaryRecoversAfterTemporaryQueueSaveFailure`，成因见下节，未修）。新增 iOS 测试：删除成功路径（真的请求了服务端、Keychain 凭据清除、协议状态清除、有明确反馈）、失败路径（保持登录与凭据、可重试）、UI 可达性与二次确认边界测试、隐私清单与出口合规边界测试。
- **仍未做（下一批）**：①**隐私政策正文与 URL 完全不存在**，onboarding 却强制勾选“已阅读隐私政策”，Settings 只有接受时间戳——5.1.1(i)/5.1.2 硬阻塞，需用户提供真实政策文本与托管 URL；②`SafetyBanner`（唯一“不替代急救·不自动拨号”声明）是死代码，`ResponderNavigationView` 的“急救已接管”按钮实际只是结束 App 内事件，1.4.1 措辞需改；③Watch 缺“不替代急救/自行拨打急救电话”引导；④生产服务仍硬编码个人 Azure 主机；⑤iPad 已声明但无 iPad 版式；⑥`AEDResponseControlledTests` 与 TestHost 共用 Bundle ID；⑦APNs 未实现（通知权限已申请但从不发通知）；⑧`fall-detection` entitlement 仍未向 Apple 提交。
- 工作树仍未 commit/push；`ios/AEDResponse.xcodeproj` 本次为 XcodeGen 规范再生成结果（此前手工修正的两处 Bundle ID 恢复为 spec 值 `dev.codex.aedresponse.testhost`，与 project.yml 一致）。
- **1.4.1 免责与措辞（本轮后半段完成）**：①`SafetyBanner` 原本从未被实例化（唯一“不替代急救·不自动拨号”声明是死代码），现已在 `RootView` 的**行动页两种角色（患者/响应者）顶部**真实渲染，文案补为“不替代急救 · App 不自动拨号，也不派车”；②`ResponderNavigationView` 按钮原文“急救已接管”会让响应者以为 EMS 已接手（App 无法观测此事），改为“确认已完成现场交接”；③Watch 设置页新增橙色 `watch-emergency-disclaimer`：“本 App 不替代急救服务、不派车，也不会替你报警。如你或他人需要急救，请自行拨打当地急救电话。”；④新增边界测试 `testEmergencySurfacesDiscloseNoSubstituteForEmergencyServices`：要求 `SafetyBanner()` 真被使用、禁止“急救已接管/救护车已到/已派车/已报警/已联系急救”等措辞、要求 Watch 具备自行拨打引导。
- **iPad 声明**：发布 target 由 `TARGETED_DEVICE_FAMILY: "1,2"` 改为 `"1"`（只有 iPhone 版式，声明支持 iPad 属评审风险且不实）；TestHost/ControlledTests 仍为 1,2（仅测试宿主）。已在 pbxproj 确认发布 app 为 `TARGETED_DEVICE_FAMILY = 1`。
- **当前最终证据**：后端 `npm test` **203/203**；iOS 全量 `AEDResponseTests` **350 项 / 1 项既有失败**（`testExitACKAtWindowBoundaryRecoversAfterTemporaryQueueSaveFailure`）。

## iOS 回归基线修复与上架阻塞项审计（2026-09-11，DSH 批次）

- 用户方向变更：不再按“毕设”对待，按 **App Store 上架软件** 收口；本轮先收口 iOS 回归。
- **基线事实**：`AEDResponseTestHost` scheme 模拟器全量 `AEDResponseTests` 在**未改动的提交基线上就有 18 项失败**（用 `git stash` 双向验证过），不是本批引入。修复后全量 **342 项 / 仅剩 1 项失败**（失败用例见下）。后端 `npm test` 200/200 保持绿色。
- 已修的三类失败：
  1. **5 项源码文本边界断言陈旧**（`ArchitectureBoundaryTests`）：批次上传/回执上传已抽到 `EventPositionBatchUploadCoordinator`、`DeliveryReceiptUploadCoordinator`，断言仍在 `AppStore` 里找 `sendEventPositionBatch`/`sendReceipt`/`NO_NEW_FIX`/`positionUpdateId`；`ResponseOfferProjectionCoordinator.advance(to status:)` 形参标签变了；`WatchRuntimeModel.retryPending` 多了 `allowCreation:`、`applyAndActivate` 多了 `sessionGeneration:`。断言已改为指向真实归属处，并补上 coordinator 侧的 seam 断言，没有放宽语义。
  2. **响应者卡片缺 30 秒有效期倒计时**（需求 §81 要求候选人在接受前能看到“30 秒有效期”）：`ResponderDashboardView` 原来只显示绝对“有效期至”。已加 `剩余有效期` 倒计时（`TimelineView(.periodic(by: 1))` 仅当时钟用），并把 `NearbyVolunteersView` 的时钟从 1 秒放宽到 5 秒（其缓存 120 秒失效，需求 §65）。视图层边界测试因此把 `TimelineView(` 从黑名单改为“只允许 `.periodic(` 形态 + 禁止 `store.timeline`/`eventTimeline`/`timelineEntries`”。
  3. **两项异步竞态/真实缺陷**：
     - `EventPositionBatchUploadCoordinator.isPermanentEventPositionFailure` 把 **503 当成永久拒绝并隔离**，会永久丢弃已封口的位置批次 —— 真实缺陷，已收窄为 `[403, 409, 413, 422]`（与 `DeliveryReceiptUploadCoordinator` 一致），并把该测试改成“退避释放闸门 + 断言 503 可重试且永不隔离”。
     - `testDeliveryReceiptSurvivesAppStoreRestartAndDrainsFromSameProtectedQueue` 原断言自相矛盾：接收+查看本来就会产生 **DELIVERED 与 VIEWED 两条** 持久事实，旧断言却要求队列只有 1 条、且依赖“重试尚未发生”的时序。已改为断言真实不变量（首次失败后队列=2 条且顺序为 `.delivered/.viewed`；重启后新进程把两条都发完并清空队列）。
- **仍未通过（1 项，既有缺陷，未修）**：`testExitACKAtWindowBoundaryRecoversAfterTemporaryQueueSaveFailure`。退出 ACK 的 `exitedAt` 目前只经内存上下文写入队列；当 `persistEventPositionQueue` 失败时 `eventPositionAwaitingAuthoritativeWindow=true`，恢复重放需要非 nil 的权威结束时间才能触发，因此 `authoritativeEndedAtByContext` 永远补不上。已为该场景新增 **`EventPositionWindowReconciliationCoordinator.reconcilePersistedOpenDraft`**（持久化开放草稿也能按 ACK 窗口收束并记录权威结束，含 2 项单测），但 AppStore 侧在“本测试路径”仍未接通：把草稿重放塞进通用 `retryPersistedAuthoritativeExitWindows()` 会回归 `testPatientPriorityRestSnapshotClosesMissingResponderContextAndStartsNewPatientStream`（对已被内存路径收束的旧草稿重复收束会复活越界槽位），因此该处**故意保持 includeOpenDraft=false**。下一步若要修此用例：应把 ACK 的 `exitedAt` **独立于对账结果**先持久化，再消费它重放窗口。
- 运行命令：模拟器全量单测走 `/tmp` 派生数据（见 `aedresponse-ios-test-build` memory）：`xcodebuild -scheme AEDResponseTestHost -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath /tmp/aedresponse-tests test`。
- **App Store 阻塞项审计结论（未开始修）**：①无任何 `PrivacyInfo.xcprivacy`（发布代码调用 `UserDefaults` 属 required-reason API）；②无应用内账号删除（违反 5.1.1(v)，客户端/契约/后端三层都没有）；③无隐私政策正文与 URL，但 onboarding 强制勾选“已阅读隐私政策”（5.1.1(i)/5.1.2）；④无资源目录与 App 图标；⑤`com.apple.developer.health.fall-detection` 当时仍**未向 Apple 提交申请**（此后 2026-09-11 已提交、尚未获批，见下文 2026-09-13 更正行；本条其余各项的现状以各自最新记录为准）；⑥唯一“不替代急救/不自动拨号”的 `SafetyBanner` 是**死代码（从未实例化）**，而 `ResponderNavigationView` 的“急救已接管”按钮实际只是结束 App 内事件，1.4.1 措辞风险最高；⑦`ITSAppUsesNonExemptEncryption` 缺失、`NSLocalNetworkUsageDescription` 仍写“测试服务”、生产 Azure 主机硬编码、iPad 声明但无 iPad 版式、`AEDResponseControlledTests` 与 TestHost 共用 Bundle ID。
- 工作树未提交，未 commit/push，未改动 `docs/`、`contracts/` 以外的用户备份工程。

## Xcode签名故障处理（2026-09-11，跨端验收暂停）

- 当前用户要求先修Xcode，未继续发送测试事件。Xcode完整AEDResponse scheme原显示Personal Team/Apple登录profile/17 Pro注册/Watch AppAttest/Fall Detection错误。
- 通过xcodebuild -allowProvisioningUpdates -allowProvisioningDeviceRegistration刷新签名，Xcode Apple Accounts下载profiles并正常重启。GUI团队已从Personal Team刷新为yuzhang cao；未退出账号、删除证书或关闭entitlement。
- 完整AEDResponse Debug真机build仍失败，但当前命令行仅剩Fall Detection capability未获Apple授权两条错误。AppAttest entitlement是有效官方key，保留；Fall权限不删除，不将手机方案成功冒充完整Watch成功。
- 发现ControlledTests Debug/Release Bundle ID在工程里变成dev.codex.aedresponse.test-host，与既有安装及后端Apple audience不一致；先保存当前pbxproj后将这两处恢复dev.codex.aedresponse.testhost，保留其他用户修改。project.yml原本即为正确值。修正后17 Pro目标命令行build成功，签名保留Apple登录。
- GUI active scheme选择AEDResponseControlledTests（联网手机方案）；不修改完整scheme的Watch依赖。原工程、日志在/Users/REDACTED/Documents/AEDResponse-local-baselines/xcode-signing-20260911/。git diff --check通过。回退本轮仅恢复备份中的两处Bundle设置，但恢复错误Bundle会破坏既有登录兼容性。
- 未获Fall审批仍是外部阻塞。之前测试事件b5a64c01-f38f-4f13-8bb2-7c9ae6e0040b最后确认ACTIVE，未代用户关闭；临时双机IPC已停用。请求用户可见验收尚未通过。

## 指定Apple双机测试入口与送达复核（2026-09-11）

- 用户批准16患者→17 Pro响应者，只通过服务器核对16。新增可选AED_SIMULATION_APPLE_DEVICE_IDS：必须配置私有IPC、恰好两个不同UUID；Apple provider且设备在名单内才允许创建SIMULATED_TEST。未启用CONTROLLED_TEST账号签发，未修改Apple登录校验/普通事件权限/位置有效期。原双设备user/device隔离沿用。
- 修改：backend/src/config.ts、server.ts、service.ts；新增配置与完整Apple测试事件/第三设备拒绝/幂等/恢复/正常接受测试。新增用例修改前失败，修改后本地199/199、Azure最终199/199、check/build通过。首次上线校验误拒大写UUID，服务自动回退；补大小写和等价重复测试后按真实配置预检并部署成功。此启动失败为本轮新增，已修复，不归为原有失败。
- 源码基线：/Users/REDACTED/Documents/AEDResponse-local-baselines/apple-pair-test-entry-20260911/；远端旧代码/配置/一致数据库：/var/backups/aedresponse/apple-pair-20260911/。当前release /opt/aedresponse/releases/apple-pair-20260911。回退代码和配置，不能覆盖部署后事实。
- 真实位置准入核对：两机约4米，16定位约292秒、17 Pro约35秒，精度约36/15米，均满足既有规则。通过私有IPC创建测试事件b5a64c01-f38f-4f13-8bb2-7c9ae6e0040b，2026-09-11T02:40:34.873Z提交。仅指定17 Pro产生delivery，02:40:35.069Z为VIEWED，02:41:04.873Z到期，随后EXPIRED，无接受。
- 用户明确反馈未看到任何请求。故“界面展示通过”撤回：仅确认客户端回执到达，视觉展示/用户感知验收失败或证据冲突。ResponderDashboardView外层和请求卡onAppear会触发markResponseRequestViewed；此生命周期回调不证明用户看到，尚未复现具体遮挡/页面/后台原因，不直接判定根因。
- 已要求用户说明17 Pro当时所在页面/前后台，并在16结束测试。不得重发新事件或改30秒期限来掩盖失败；现有事件是否终态需继续查询。未完成真实Watch/Fall/APNs后台通知验收。

## 17 Pro UI自动化实机抽验（2026-09-11）

- 用户要求连接17 Pro进行UI自动化。实际设备D3DF0C66-AB47-562E-8978-DFA10FEB5BA9 connected，Xcode destination [REDACTED_UDID]。
- AEDResponseTestHost Debug，运行现有testDefaultActionHidesSafeTestDialer及testSettingsShowsAccountConnectionCoordinatesAndSystemSettingsOnly；2/2通过、0失败，实际测试19.7秒。完成启动、点击设置、滚动与界面断言，导出两张截图。
- 使用UITestMode本地夹具及TestHost禁止联网路径，不是真实Apple登录/救援/Watch验收。未改测试断言或业务代码。测试后覆盖恢复AEDResponseControlledTests联网版，未卸载或执行退出账号。
- 证据：/Users/REDACTED/Documents/AEDResponse-local-baselines/17pro-ui-20260911/，含test.log、result.xcresult与screenshots。无Git提交/推送。

## iPhone16 蜂窝正式登录实测（2026-09-11 02:11 UTC）

- 用户完成本人Apple登录。原生日志确认蜂窝请求：auth/apple/challenges 201、auth/apple 200；Keychain原条目不存在后新增status=0，登录凭据保存成功。
- session/bootstrap先403后201，随后SOCKET_CONNECTED和SERVER_READY_RECEIVED，GET events 200。与现有设备绑定冲突恢复路径相符，但日志未输出403 problem内容，不能单凭状态码认定具体冲突类型。
- responder-position PUT200及POSITION_ACK；presence PUT200；nearby-volunteers GET200。后端只读核对accounts/devices均4，位置回执97（部署时95），presence回执61（此前59），quick_check=ok。未读取或输出账号身份/令牌/坐标内容。
- 这证明本次真实手机蜂窝登录、业务会话建立、实时连接、事件查询及位置上传确认通过；不证明非空活动事件恢复、进程重启后登录保持、真实救援路线或Watch后台闭环。
- 证据：仓库外route-watch-release-20260911-095528/iphone16-login-redacted.json。此前Wi-Fi超时未复现定位原因，不归因于已确认服务器缺陷。

## Azure 路线/Watch 候选部署与 iPhone16 验收进度（2026-09-11）

- 用户本轮明确确认部署。已切换 /opt/aedresponse/current → /opt/aedresponse/releases/route-watch-20260911-095528；服务在02:07:40 UTC重启，active、NRestarts=0。候选SHA256 731b8093a540c3f213bbdf1ef6aa0aeacd46b547e3baa3bb2122cc944fe462c6。补充4个Windows脚本供既有测试读取，未变更候选业务源码。
- Azure Node24.18.0：npm ci（better-sqlite3原生编译）、npm test 197/197、npm run check、npm run build均通过。隔离测试未连接业务数据库。公网health200，Apple challenge在loopback/Caddy TLS/电脑无代理直连均201。Mac默认网络另一次SSL失败、iPhone Wi-Fi请求-1001超时，不能据此宣布手机登录通过。
- 备份 /var/backups/aedresponse/route-watch-20260911-095528/ 包含旧current完整目录、backend.env和停服后一致state.sqlite。备份及现有数据库integrity_check=ok；事件1→1、历史位置批次311→311、位置回执95→95。原配置逐项保持，新增受限高德配置；上传暂存Key已删除，未写入候选包/日志。
- Azure调用真实高德：合成北京坐标，转换1次+步行3次HTTP200；启用的provider返回AVAILABLE，walking921秒、ETA981秒。只运行派生报价，无业务写入、真实求助或通知。不是手机端真实路线验收。
- iPhone16：新ControlledTests签名build成功、覆盖安装成功、原生启动成功。诊断显示Wi-Fi路径、authenticated=false、agreementsComplete=false、Apple challenge请求超时(-1001)。未执行卸载/退出/替用户Apple确认；已请用户关闭Wi-Fi改蜂窝后本人完成登录。未确认手机登录、事件恢复或Watch运行通过。
- 本地证据与ROLLBACK.sh：/Users/REDACTED/Documents/AEDResponse-local-baselines/route-watch-release-20260911-095528/。回退仅切代码和配置，保留部署后事实；若需数据恢复必须单独评估新增事实，禁止直接覆盖数据库。无Git提交/推送。
- 下一步：观察iPhone16蜂窝原生challenge/login/session/恢复请求结果；真实Watch/OS后台及完整路线救援验收仍未完成。不把部署健康检查当跨端闭环。

## ROUTE-WATCH 收尾（2026-09-11，覆盖下方早期接线待办）

- 状态：本地实现与验证完成；未部署、未安装本轮候选版、未完成真实跨端验收。仓库根无 AGENTS.md，遵守用户提供的规则。保留已有工作区修改，无提交或推送。
- 路线权威：新增 AmapAedRouteProvider 接管配置 AED_AMAP_WEB_KEY 时的路线报价；事务外调用高德，事务内按当前精确输入读取匹配报价并提交任务。原几何 provider 仅用于未配置 Key 的参考环境，高德失败不切回几何报价。accept 等待报价后复验身份；tick 异步预热，不阻塞到期业务，报价就绪后才重排。
- 边界：GPS→高德坐标只作派生转换，原始定位事实不改；缓存成功15秒/失败5秒，最多2048项、256个待处理报价、4个并发任务。报价缓存不是持久业务权威，也不是位置有效性判定。尚未证明目标负载下性能。
- Watch：按用户批准的“手机可达但后端10秒无有效手机位置”规则，快照返回 fallbackAllowed，写入事务再次判定。既有幂等重放及合法终态历史保留。过期 candidate 重放不得提升为当前位置。准入变化403使用 fallback-admission-changed，客户端暂停采样、重新查询，保留待上传事实；普通权限错误仍独立处理。
- 最终后端 npm test：197/197，通过日志 /tmp/aed-route-watch-release-tests.log；npm run check 通过。原生 runner 43 Phone +82 Watch +2本地HTTP/重启阶段通过（/private/tmp/aed-route-watch-final2）；此后仅准入竞态改动由27项 WatchFallbackCoordinatorTests 覆盖（/tmp/aed-watch-admission-race.log）。最终 Watch generic Simulator BUILD SUCCEEDED（/tmp/aed-route-watch-release-build.log）。这些不是 Simulator运行或实机验收。
- 过程失败：首次原生编译误传 serverAllowsFallback 给上传payload，已移除；首次全后端因严格快照断言未包含新增字段失败，已更新期望并全量重测，未放宽断言。最终无已知新增失败。同一执行者复审 provider、事务接线、错误分类及测试证据，非独立审核。
- 候选包：/Users/REDACTED/Documents/AEDResponse-local-baselines/route-watch-release-20260911-095528/，含 manifest.json、backend-candidate.tar.gz 和 DEPLOYMENT-REVIEW.md；包含累计未部署后端整改，排除凭据。代码基线：route-integration-20260911-094354 与 route-watch-20260911-092848，均位于同一 baselines 目录。
- 回退：按上述快照逐文件恢复本批差异，不重置已有工作；无本批数据库迁移。保留业务事实/Keychain队列，代码回退不等于数据回退。远端部署前另备份代码、配置和一致SQLite，不能用旧数据库覆盖部署后的新事实。
- 下一步：取得现有 Azure 联调后端候选包部署授权后，配置仓库外 Key，再进行 iPhone16 原生联调；真实 Watch/Fall entitlement、OS后台、真实APNs及目标负载仍待验证。原始授权明确排除部署，因此不能把“收尾”解释为已授权更新远端服务。

## 高德Web服务凭据与真实接口验证（2026-09-11）

- 用户提供Web服务Key。仅保存于仓库外 ~/Documents/AEDResponse-local-secrets/amap.env（目录0700、文件0600）；不得复制Key到源码、文档、日志或聊天。
- AmapWalkingPlanner实际使用合成北京坐标调用1次GPS坐标转换和3次v5步行路径规划；四次HTTP200、status=1、infocode=10000。返回AVAILABLE，步行596秒，总ETA731秒（含夹具楼层/门禁/核验成本）。没有真实患者数据、求助或推送。
- 此证据是供应商接口连通与解析，不是生产任务分配接入或实机路线验收。当前异步planner尚未接管service中同步assignment route provider，必须在事务外取报价并在事务内校验对应输入后再提交，不得仅新增adapter宣称完成。
- 用户已批准手机可达但后端10秒无有效P时允许Watch备用上传。相关fallbackAllowed查询/服务端再校验和过期candidate重放修复已改源码；此前领域63/63通过，Watch新增用例与跨端契约/构建仍待收尾。
- 当前最近设备核对是iPhone16 connected；17 Pro与Watch为available(paired)。后续实际跨端测试先核对绑定与活动事件，不把可见设备当已完成Watch独立运行。

## INTEGRATED-BOUNDARIES-RECOVERY（2026-09-11）

用户要求后端剩余用例、可靠通知、历史存储与跨端后台一起整改。本轮按事件创建→通知→存储选择→Watch生命周期推进；不改变路线/人数/AED等未决规则，不部署不触发真实求助。

| 工作项 | 本轮实际接管/修复 | 证据与剩余边界 |
| --- | --- | --- |
| 后端用例边界 | watch-event-creation.ts拥有创建事务、重放幂等、患者设备关联、激活通知和历史审计；service仅权限/时间校验及recruit/priority/query适配。原内嵌创建事务已停用 | 创建事务失败全回滚、ACK丢失后的重放测试通过。其他位置写入口和招募内部逻辑仍在service，不宣称全部迁移完 |
| 可靠通知 | status-confirmation-requested发送时复验当前confirmationId/PENDING/deadline；已回答旧提醒SUPPRESSED | 新测试修改前失败、修复后通过。创建后发件箱ACK丢失→服务对象重建→同message重发且事件仅1条通过；真实APNs未验证 |
| 历史存储 | StateReadView.select提供有界、脱离原状态的单collection选择；outbox取100条due不再复制全部事件/位置历史 | 本机50k历史/500通知扫描原全状态约48.03ms，新选择约1.59ms；0/1k/10k/50k各档重启计数一致。仍线性扫描collection，事务clone/validate和发送授权全状态读取保留；不能称存储性能整体已解决 |
| Watch/OS恢复 | lifecycle恢复前后、hasValidWatchSession快速路径和Fall权限回调增加session代次检查，旧回调不能操作新配对UI/继续后续恢复 | watchOS generic build通过。没有固定后台频率承诺，真实Watch/OS后台与完整跨账号位置补传尚未验收 |

- 验证：修改前本轮后端190/190；最终全后端193/193（/tmp/aed-integrated-backend-final.log）、TypeScript check通过。领域/存储专项80/80；旧提醒修复另有先失败后通过日志/tmp/aed-obsolete-prompt-before.log与after.log。
- 原生链：43 Phone +81 Watch +2真实本地HTTP/进程重启阶段通过（/private/tmp/aed-integrated-recovery-checks）；fixture已停止。该runner不包含WatchRuntimeModel运行测试，其变化仅由/tmp/aed-integrated-watch-build.log构建覆盖。
- 存储实验：/tmp/aed-integrated-storage.log，原始JSON在/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aedresponse-storage-load-htekaV/result.json；50k档reopen约251ms、no-op事务约143ms，单次本地合成探针不代表目标负载SLA。
- 回退基线 /Users/REDACTED/Documents/AEDResponse-local-baselines/integrated-repair-20260911-091009/。按本轮差异恢复源码/测试/文档；新usecase模块可移除并恢复原入口，保留已提交事件/通知/历史数据。没有schema或生产迁移，不用代码回退替代数据恢复。
- 同一执行者复审真实差异、事务回滚断言、通知发送时授权和原状态隔离；未冒充独立审查者。git diff --check通过，未commit/push。
- 下一继续点：位置写用例和招募内部边界；完整跨账号位置历史补传故障注入；目标负载/积压与真实设备后台。上一组账号撤销/重认证修改仍未部署，不把本轮本地运行当线上验收。

## REAUTH-LOGOUT-RECOVERY（2026-09-11，用户确认重新登录原账号）

- 用户决定：旧凭据过期且记录已清理时重新登录。已实现requiresReauthentication持久状态，401后停止旧bearer发送；提示原账号重新登录，同issuer/user才尝试恢复。仅恢复204后ACK删除。
- 新生成pending记录保存ownerUserID、deviceInstanceID、requestedAt；仍只放独立Keychain。源码sender仅auth/logout与auth/logout/recover，阻止redirect，不用旧token登录或刷新。
- 后端新POST /auth/logout/recover需要当前ACCOUNT+session:bootstrap，事务内复验当前Principal。旧account记录存在时只撤销原refresh family且拒绝当前family；记录已按统一refreshExpiresAt清理时确认inactive，不撤销新family。iPhone恢复要求原device归属当前账号，按原requestedAt处理旧设备sessions/未消费tickets/旧Watch绑定及相关旧refresh families；新bootstrap和新Watch绑定保留，跨账号拒绝。
- 重复恢复无新增权限，completion标记使用原首次时间；不授予业务Principal，不清空事件/位置队列。
- 验证：后端全套190/190（/tmp/aed-reauth-all-tests.log）；后续扩充旧Watch撤销/新Watch保留断言，认证专项28/28（/tmp/aed-reauth-watch-protection.log）。TypeScript check通过；客户端DurableRevocationTests4/4运行通过（/tmp/aed-reauth-client-tests.log），含401持久状态、错误账号不发送、正确账号恢复后删除、旧bearer只发送1次。iOS generic build-for-testing通过（/tmp/aed-reauth-build.log）；OpenAPI解析与git diff --check通过。
- 未部署/未安装：真实Apple重新登录和线上recover联调未执行。本地闭环覆盖新格式记录；旧格式缺少owner/device/boundary元数据时仍保留待显式迁移，不推断原账号、不假确认。
- 备份 /Users/REDACTED/Documents/AEDResponse-local-baselines/reauth-revocation-20260911-005835/；逐文件回退本批源码/契约接线，保留Keychain记录；旧版本不理解requiresReauthentication或recover接口，回退不能当作撤销完成。无数据库结构迁移、无生产写入。复审由同一执行者完成。

## LOGOUT-ACK-REPLAY（2026-09-11）

- 针对204响应丢失：SessionRecord新增可选logoutCompletedAt，IdentityAccess在原logout事务内与撤销效果共同提交。auth/logout在普通principal校验前走专用logoutToken入口：仅已持久化显式完成标记+revokedAt可回放204，不生成Principal、不放行业务请求、不重新触发配对撤销。
- 保持既有401边界：过期但未明确logout、refresh rotation、未知token、正常清理后不存在的会话均不能凭空确认。没有扩大旧token撤销新Watch会话的权限，没有更改会话保留期或生产数据库结构。
- 客户端上一批logout-only transport已只接受204，因此无需再次改客户端；旧服务继续保留401记录，新服务部署后可确认仍保留完成标记的重试。
- 测试：新增显式logout重放/业务权限仍拒绝、事务失败无标记、过期不等于撤销、HTTP两次204及未知token401。HTTP测试初稿缺必填challengeId而400，补齐合法合成请求后通过，未放宽API校验。
- 认证/Apple/存储专项50/50、全后端npm test 188/188、npm run check、git diff --check通过。日志 /tmp/aed-logout-confirmation-final.log 和 /tmp/aed-logout-confirmation-all.log。未部署、未调用真实用户logout、未重跑iOS构建。
- 回退 /Users/REDACTED/Documents/AEDResponse-local-baselines/logout-confirmation-20260911-004745/，按本批源码/契约差异回退；保留已写marker/Keychain记录，不删除数据。可选字段无迁移，旧服务不提供重放确认，回退后客户端继续保留待处理记录。
- 限制：完成标记随现有session清理周期一起移除；超出该窗口、首次请求已过期、旧版本成功但无marker等仍需要后续确认机制，不能声称永久或任意过期凭据都可完成撤销。复审为同一执行者。

## DURABLE-SESSION-REVOCATION（2026-09-11）

- 用户授权待撤销凭据安全持久化。新增独立Keychain item pending-session-revocations-v1，AfterFirstUnlockThisDeviceOnly；仅保存原issuer、撤销bearer、步骤种类和来源登录token标记。不保存refresh token，不写UserDefaults/普通文件/诊断日志。
- 生产logout使用APIClient actor快照（等待已有refresh/bootstrap完成）→持久化prepare→清理登录Keychain→本地signedOut→独立发送owner。暂停期间isLoggingOut关闭业务门；存储失败保持原登录凭据和可重试退出，不伪称注销成功。注入测试环境无durable store时沿用原进程内fake路径。
- 冷启动先读取待撤销队列：若原登录token已有退出意图，则清理该登录项，不允许冷启动刷新重新登录；队列损坏/Keychain不可读时关闭恢复门。源token标记覆盖actor刷新与UI持久化回调之间的窗口。前台恢复重试。
- 网络恢复只能POST原APIConfiguration的auth/logout，无重定向/刷新/业务调用；仅204才ACK。ACK写失败保留记录；每轮4次有界重试（1/2/4s），401/过期/其他错误不丢弃记录，不宣称全部远端会话或Watch已撤销。
- 验证：DurableRevocationTests原生macOS运行3/3（真实独立Keychain测试item、重建store后读取、ACK写失败保留、损坏不覆盖），/tmp/aed-durable-revocation-targeted.log。测试仅以合成凭据/发送闭包运行，没有真实注销。iOS generic build-for-testing通过（/tmp/aed-durable-revocation-final-build.log）。已有runner38 Phone/81 Watch及2 HTTP重启阶段通过，但新Durable测试通过独立filter运行，不借用旧总数；已将新测试纳入后续默认filter。
- 实际OS杀进程后端到端恢复、iPhone真机Keychain失败、远端204响应丢失后恢复尚未执行；原生测试的store重建不是OS跨进程测试。401保留待处理，需要服务器进一步提供幂等撤销确认/过期凭据撤销能力。
- 同一执行者差异复核，git diff --check通过；没有部署、没有手机退出账号或真实用户通知。
- 回退基线 /Users/REDACTED/Documents/AEDResponse-local-baselines/durable-revocation-20260911-003315/。逐文件撤销本批接线；保留Keychain待撤销item，不删除凭据。旧版不消费新队列，回退前需记录未完成撤销，不能以代码回退宣称远端撤销已完成。

## ACCOUNT-RECOVERY（2026-09-11）

- 用户授权撤销失败恢复、旧历史补传、Watch跨账号恢复。处理类型F/S/V，不更改事件或资产规则，不部署/不退出手机账号。
- SessionRevocationRecovery接管进程内撤销：独立记住device/account成功步骤，1/2/4秒退避后保留失败步骤，前台恢复重试；失败提示只进入原登出代次，不能污染新账号。旧AppStore一次性remoteLogout路径停用。该owner尚未持久化，进程终止仍可能丢失待撤销凭据，不能宣称跨进程撤销恢复完成。
- DeliveryReceiptUploadCoordinator补transportGeneration，cancel后的旧defer/错误/ACK不影响新任务；已有受保护回执按原context重读，新增A→B不可读→重建→A可读断言。不清空历史、不换属主。位置历史全窗口和账号切回仍需进一步验证。
- Watch新增显式recoverCompanionLink，复用同一redeem内部用例；原strict redeem仍拒绝不同pair，runtime恢复入口允许同issuer新pair走独立stable device namespace。candidate不改变当前配置；App Attest和后端ticket验证成功后提交linked配置。新linked配置以单个UserDefaults字典发布，旧字段只作为迁移读取，避免新pair/旧device混写。配对ID→设备ID表保留原映射，返回A可恢复原sourceBinding；pending trigger/fallback事实不重标不删除。
- 原生runner通过38 Phone/81 Watch和2个HTTP服务重启阶段；最后配置原子发布修改后定向重测SessionRevocationRecoveryTests、DeliveryReceiptPersistenceTests、WatchCompanionLinkTests，21/21通过（/tmp/aed-account-recovery-targeted.log）。撤销新测试不在旧runner默认filter中，明确通过单独filter执行，未借用旧总数。
- iOS generic build-for-testing成功（/tmp/aed-account-recovery-final-build.log）；watchOS Simulator generic build亦成功（/tmp/aed-account-recovery-watch-build.log），覆盖runtime接线。git diff --check通过。同一执行者复审。
- 回退基线 /Users/REDACTED/Documents/AEDResponse-local-baselines/account-recovery-20260911-002240/；逐文件回退本批差异。保留新linked配置、pair映射和所有队列，不删除数据。旧代码不读取新linked配置，回退后必须经重新配对验证，不用git回退宣称恢复了账号绑定。
- 尚未完成：Keychain持久待撤销队列与过期/已撤销响应语义、真实旧账号位置历史补传、Watch真机/真实AppAttest兑换；不得把本地双身份合成测试称为真实双账号验收。

## PERMISSION-CONTEXT-ISOLATION（2026-09-11）

- 风险：旧通知/定位权限回调在登出或换账号后仍可写权限、同意记录或激活服务。类型F；只修复回调有效性，不改变通知/Always/精确定位门禁或业务规则。
- AppStore以permissionContextGeneration统一认证上下文；新登录、认证恢复及stopBusinessServices更新代次。六入口覆盖onboarding、requestRequiredPermissions、authorizationCheckTask、appDidBecomeActive、establishConnection与location onAuthorizationChange。成功/错误/defer先校验有效性；协议保存绑定原userId。连接检查另复验connectionGeneration。
- 新增阻塞权限授权→登出→释放授权回调测试，断言不能完成onboarding、授予本地权限或启用业务。新增XCTest已编译；generic build-for-testing成功（/tmp/aed-permission-isolation-build.log）；git diff --check通过。
- 定向运行使用已有xctestrun跳过包解析：/tmp/aed-permission-runtime.log。等待约两分钟仍无用例启动记录，已中断。日志含设备服务passcode protected错误，但未证明其为根因；运行未完成，不能把编译算成行为验证。
- 备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/permission-isolation-20260911-001357/。回退仅AppStore本批权限代次和对应测试，保留账号/设备隔离及历史队列。没有数据库变更、部署或手机账号操作。
- 复审由同一执行者逐行检查：旧defer不释放新任务；权限检查不在await赋值前写入；定位Task也受同一代次约束。仍缺同账号重新登录及OS真实权限弹窗运行验证。

## ACCOUNT-AUTH-CALLBACK（2026-09-11）

- 三个显式认证写入口（手机号challenge、手机号验证、Apple登录）共享authenticationActionGeneration和single-flight gate。登出使旧代次失效并释放UI gate；await成功/失败写回前检查代次、任务取消和仍未登录，旧defer不得清理新登录任务状态。
- 新增阻塞Apple登录→登出→手机号登录→释放旧Apple响应测试，验证新账号与Keychain fake保存内容均保持新账号。原设备/pair namespace与队列未修改；手机账号未被登出。
- generic build-for-testing通过，日志 /tmp/aed-login-generation-build.log。定向Simulator test-without-building等候超过3分钟仍停在Resolve Package Graph，未进入用例，已中断（/tmp/aed-login-generation-runtime.log）；设备服务另报passcode protected，不断言它是模拟器阻塞根因。
- 本批备份为/Users/REDACTED/Documents/AEDResponse-local-baselines/login-generation-20260911-000542/（含SHA256SUMS）；回退只比对AppStore和AuthenticationArchitectureTests本批差异，不撤销之前设备身份修复，不删除数据。
- 未完成：权限弹窗旧回调隔离、撤销失败恢复、跨账号历史补传、Watch重新绑定。没有部署、没有真机新登录测试；同一执行者复核。

## ACCOUNT-DEVICE-CONTRACT（2026-09-10）

- 范围：账号切换设备绑定错误契约及回归；不部署，不操作手机当前账号，不删除或转移历史事实。
- 后端 bootstrap 绑定冲突增加明确 problem type device-account-binding-conflict，保留403/title/detail；AppStore使用ProblemDetails分类，旧服务器仅精确generic403+原detail兼容，其他403禁止迁移。
- 新增实际用例测试：B不能覆盖A绑定、拒绝无副作用、B独立绑定、B设备和账户依次撤销后令牌失效、返回A仍保留双方独立身份。
- 修改前新增测试在专用type断言失败；修复后认证/Apple 28/28通过。测试初稿误将账号撤销视为自动撤销设备，按实际iPhone双撤销流程补齐调用后保留原失效断言；未改变账户/设备撤销语义。
- companion-link专项7/7通过；Swift直接执行生产ProblemDetails源码，5种typed/legacy/无关拒绝断言通过；TypeScript check与git diff --check通过。iOS generic build-for-testing通过（/tmp/aed-account-boundary-ios.log）；新增XCTest仅编译，未运行真机测试。
- 备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/account-boundary-20260910-235022/；逐文件撤销本批差异，不改账号设备或数据。客户端兼容线上旧格式，当前未部署新后端。
- 未完成本工作项：登录/权限异步旧回调统一隔离、远端撤销失败的恢复、旧账号历史补传全链、Watch跨账号重新兑换/恢复。账号级注销与设备级注销是两个入口，单独账号注销不等于所有设备撤销；不得宣称完整账号切换闭环已验收。
- 复审：同一执行者核对错误类型、原状态不变断言、旧部署兼容和撤销入口，无独立审查者。

## 2026-09-10 23:45 真机 Apple 登录恢复验证

17 Pro已登录App执行terminate-existing重启成功；后端23:45:09新会话、23:45:11通信恢复；Apple账号/设备各1，身份组合摘要不变。局部认证回归27/27通过。详细证据 docs/reviews/apple-login-device-recovery-20260910.md。未执行注销重登、Watch或求助流程，不宣称全部测试完成。

## DEVICE-ACCOUNT-ISOLATION（2026-09-10 23:39）

- 用户报告 Apple 认证后 bootstrap 返回 deviceInstanceId is already bound to a different authenticated account。源码确认 AppEnvironment 原安装级固定 ID 与后端不可覆盖账号绑定冲突。
- 本批仅修改 iPhone：UserDefaultsDeviceIdentityStore 对明确拒绝的 issuer/user 开启稳定 namespace，设备和 pair 同时隔离；旧 ID 不变，其他账号仍沿用原 ID，重新打开 store 仍取得同一 scoped ID。AppStore 所有设备/pair 读取使用同一个当前身份入口。
- 只在 bootstrap 精确 403 detail、当前连接代次/账号仍匹配、无活跃 capture 时迁移一次并重试；普通403、网络错误、第二次失败均不继续生成身份。清除旧配对票据并按新context恢复队列；旧磁盘事实不删、不改属主，不修改后端权限。
- 签名设备构建通过：/tmp/aed-account-device-build.log。原生 Swift harness 执行生产 identity store 源码，AuthSession/APIConfiguration 用最小stub；验证用户/issuer隔离、重建store稳定、只迁一次、legacy保留和UUID有效。该证据不是完整 AppStore 或跨进程验证。新增 XCTest 源码尚未执行。
- 已将修复包覆盖安装到17 Pro。后续亲自启动登录态App并确认bootstrap恢复；不以安装成功当作业务连接成功。
- 备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/device-account-fix-20260910-233729/。代码按本批文件差异回退；保留账户隔离标记与所有队列。回退旧代码会重新遇到绑定冲突，不应删除服务器设备或将历史改绑。
- 尚未验证 Watch 新pair兑换、跨账号旧历史补传、真实bootstrap恢复；身份规则仍由服务器判定。复审由同一执行者完成，无部署、无DB修改。

## Apple 登录 profile 与服务器启用（2026-09-10 22:16）

- 用户明确授权更新联网测试 profile、启用服务器 Apple 配置，17 Pro connected。
- xcodebuild AEDResponseControlledTests，真实17 Pro destination，allowProvisioningUpdates/DeviceRegistration 构建成功；codesign 产物包含 applesignin Default 和 [TEAM].dev.codex.aedresponse.testhost。
- 已覆盖安装并启动联网测试 App，无卸载、无删除数据；日志 /tmp/aed-apple17-sign.log。
- SSH 主机公钥与 known_hosts 的 [REDACTED-HOST] 匹配。服务器已有 AppleJWTVerifier，缺 audience；仅追加 AED_APPLE_CLIENT_IDS=dev.codex.aedresponse,dev.codex.aedresponse.testhost，保留原 pepper/全部配置，restart 后 active。
- 服务器回退文件 /etc/aedresponse/backend.env.before-apple-20260910141609，root/0600。需要回退时恢复该文件并重启 aedresponse；未执行数据库迁移或删除。
- 尚需用户在17 Pro亲自完成 Apple 系统授权；未声称真实账号登录成功。Python HTTPS检查因本机CA链失败，改用系统curl保持证书验证。

## Apple 登录签名核对与测试目标接线（2026-09-10）

- 本机正式 profile 的 application-identifier 为 [TEAM].dev.codex.aedresponse，applesignin=[Default]，到期 2027-09-10；只输出能力与到期信息，没有导出凭据。
- 受控联网目标 AEDResponseControlledTests 原无 CODE_SIGN_ENTITLEMENTS；已在 project.yml 和工程 Debug/Release 配置接入现有 Apple entitlement 文件。离线 TestHost 未改。现有 testhost profile 无 Apple capability，仍需经 Apple 侧配置更新，不能作为已可登录。
- 验证：showBuildSettings 检查目标 entitlement 接线；git diff --check 通过。正式 AEDResponse generic iOS 签名 build 失败：嵌入的 Watch Fall Detection entitlement 尚需 Apple 审批（/tmp/aedresponse-apple-signed-build.log）。没有删除该 entitlement 绕过审核，未安装或启动设备。
- 此构建失败是既有外部 capability 阻塞，不是 Apple 登录验签失败。正式 iPhone profile 的 Apple 能力已确认，但完整签名产物和真实 Apple 登录仍未验证。
- 回退基线：/Users/REDACTED/Documents/AEDResponse-local-baselines/apple-signing-20260910-215431/；只撤销本批两个构建配置的 entitlement 接线，不修改数据库、会话或历史队列。同一执行者复核。
- 下一步：为联网测试 App ID 配置 Sign in with Apple 并更新 profile，或在 Watch 审批完成后构建正式组合 App；随后配置服务器 audience（当前公网此前返回 503）、保留原 pepper，执行真实登录。未部署、未自动申请 capability。

# Apple 登录业务接线（2026-09-10）

- 公网 challenge 接口实测 503：APPLE authentication is not configured on this backend。没有部署或修改服务器。
- 本批增加 backend/scripts/check-apple-login.ts 与 npm run check:apple-login；在服务同一环境检查显式 audience 和稳定 pepper，不开库、不创建账号、不打印密钥。
- AuthView 捕获 challenge issuer 和 Apple 请求 issuer；拒绝不同地址的旧 challenge，授权结果提交到原 issuer。修复 Debug 地址切换期间的身份令牌错投风险。
- Apple REST 专项 6/6 通过，扩展同一身份使用新 challenge 重登复用账号验证；npm run check 通过。配置检查缺项退出 1、合成配置退出 0，均符合预期。
- 仅本地实现；授权码交换、Apple 撤销通知、实际签名及真实账号登录未完成。下一步核对实际目标的 capability/profile，并经部署授权配置现有服务的 audience，保留原 pepper。
- 修改前备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/apple-login-20260910-215000/。按文件对比回退本批差异；新脚本可移除，不更改队列或数据库，不撤销其他已有修改。

# HANDOFF

## 2026-09-10 P0-APPSTORE-AUTH-RESTORE-GENERATION（当前继续起点）

- 修复冷启动认证恢复旧任务：新增 authentication restore generation；logout、显式新登录和恢复失败会取消/失效旧 refresh task，旧结果不得保存 session、finish signed-in 或激活业务服务。
- 新增阻塞 refresh 后 logout 回归；`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-auth-restore-generation-runner1` **38 Phone + 80 Watch + 2 HTTP/重启阶段通过**；generic `build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-auth-restore-generation-build1.log`）；`git diff --check` 通过。
- 未运行 Simulator runtime、真机或真实 refresh 服务。下一步继续审计其余认证/会话 task，再进入电脑合成负载试验。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-auth-restore-generation-final/`；源码、测试、工程和文档副本已完成 `SHA256SUMS` 校验。

## 2026-09-10 P0-APPSTORE-AUTH-REFRESH-GENERATION（当前继续起点）

- 修复 LiveSession token refresh 旧回调：捕获 connection generation 和账号 userId，只有同一代次、同一账号且仍认证时才可持久化轮换 session。
- `python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-auth-refresh-generation-runner1` **38 Phone + 80 Watch + 2 HTTP/重启阶段通过**；iOS generic `build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-auth-refresh-generation-build1.log`）；`git diff --check` 通过。
- 未运行 Simulator runtime、真机或真实 token rotation 服务。下一步继续审计其它认证/会话 task 的旧回调，然后进入电脑合成负载试验。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-auth-refresh-generation-final/`；源码、测试、工程和文档副本已完成 `SHA256SUMS` 校验。

## 2026-09-10 P0-APPSTORE-COMPANION-TICKET-GENERATION（当前继续起点）

- 修复 Watch companion ticket 旧回调：task 清理仅在原 connection generation 生效时执行；失败回调复验 generation、认证和业务服务激活状态，旧错误不会污染新会话。
- `python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-companion-ticket-generation-runner1` **38 Phone + 80 Watch + 2 HTTP/重启阶段通过**；iOS generic `build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-companion-ticket-generation-build1.log`）；`git diff --check` 通过。
- 未运行 Simulator runtime、真机 Watch 或真实配对切换。下一步继续检查其它 task 的旧回调清理/错误写回，然后进入电脑合成负载试验。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-companion-ticket-generation-final/`；源码、测试、工程和文档副本已完成 `SHA256SUMS` 校验。

## 2026-09-10 P0-APPSTORE-STATUS-CONFIRMATION-GENERATION（当前继续起点）

- 修复患者 `CONTINUE` 状态确认异步回调：捕获并复验账号、event ID、confirmationId、患者 active 状态和 connection generation；旧连接/旧账号响应不再写 `lastStatusConfirmationResult`、错误或触发恢复。`disconnect()` 释放状态确认提交 gate。
- 新增延迟响应回归和架构边界断言。首次 generic build 发现本批新增 Swift `defer` 语法与 XCTest async autoclosure问题，已修正；最终 `build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-status-confirmation-generation-build3.log`）。
- Runner `/private/tmp/aedresponse-status-confirmation-generation-runner1` **38 Phone + 80 Watch + 2 HTTP/重启阶段通过**；`git diff --check` 通过。未运行 Simulator runtime、真机或生产状态确认。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-status-confirmation-generation-final/`；源码、测试、工程和文档副本已完成 `SHA256SUMS` 校验。
- 下一步：继续复核其它 AppStore 异步操作的旧回调门，优先处理仍直接以服务成功/Socket hint修改投影的路径；然后进入电脑合成负载试验。

## 2026-09-10 P0-APPSTORE-ASSIGNMENT-TIMEOUT-REST（当前继续起点）

- 修复 `assignmentTimedOut` Socket 分支：保留终态相关采集暂停、timeline 和 `reconcileEvent`，移除 `assignmentProjectionCoordinator.markTimedOut` 的本地写入。REST 快照现在是 `TIMED_OUT`/重派/保持原任务的唯一客户端状态来源。
- 新增 AppStore 回归断言：REST 读取失败时 assignment 状态不会先变成 `TIMED_OUT`；架构边界测试确认 AppStore 不再调用本地 timeout writer。后端超时 writer、重派和业务规则未改。
- 验证已完成：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-assignment-timeout-runner1` **38 Phone + 80 Watch + 2 HTTP/重启阶段通过**；iOS Unit `build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-assignment-timeout-build-for-testing1.log`）；`git diff --check` 通过。未启动真机、Simulator runtime 或生产服务。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-assignment-timeout-rest-final/`；源码、测试、工程和文档副本已保存并通过 `SHA256SUMS` 校验。
- 完成本批验证后，继续从 Presence/Assignment 其它异步入口复核；若无第二写入权威，再进入电脑合成负载试验。

## 2026-09-10 P0-APPSTORE-EVENT-OUTCOME（当前继续起点）

- 新增 `ios/AEDResponse/Application/EventPositionBatchOutcomeCoordinator.swift`，接管已封口事件位置批次的 ACK 强校验/精确删除和永久拒绝 `blockedReason` 隔离；不拥有上传、退避、权限、参与窗口或持久化。`EventPositionBatchUploadCoordinator` 仍只负责 transport single-flight、不可变 batch 和代次 lease。
- AppStore 的 `commitEventPositionBatchAck`/`isolateEventPositionBatch` 现在只负责调用 outcome、写受保护队列并更新 ACK/错误投影；无匹配旧回调不再无意义写盘。新 outcome XCTest 覆盖 ACK 只删原批次、错 ACK 保留、永久拒绝保留 payload 与后续批次、无匹配 no-op。
- 工程/runner/边界测试已接线。`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-window-outcome-runner3` **38 Phone + 80 Watch + 2 HTTP/重启阶段通过**；`xcodebuild ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-window-outcome-build-for-testing1.log`）；`git diff --check` 通过。无物理设备、Simulator runtime、OS 后台或生产通知证据。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-appstore-event-outcome-final/`；源码/工程/测试/runner/文档副本已保存并完成 `SHA256SUMS` 校验。下一步可检查 AppStore `Presence/assignment` 编排的第二写入入口，或进入电脑合成负载试验。

## 2026-09-10 P0-APPSTORE-EVENT-WINDOW（当前继续起点）

- 新增 `ios/AEDResponse/Application/EventPositionWindowReconciliationCoordinator.swift`，接管后端已确认参与时间窗的值级对账：越界原因、未 ACK 批次按原 `recordId` 重组、开放草稿隔离、`quarantinedEvidence` 和旧 context 的持久批次恢复。它不拥有 REST 权限、队列 I/O、上传、ACK 删除、终态或 AED 业务规则。
- `EventPositionFactCoordinator` 新增 `EventPositionOpenFacts` snapshot/apply；AppStore 只负责窗口来源与当前认证 context、持久化成功后应用快照、封口和 transport gate。退出 ACK / 新事件切换时，旧 context 使用 `reconcilePersistedBatches`，不修改新事件开放槽。
- 新增 `EventPositionWindowReconciliationCoordinatorTests.swift` 与 `ArchitectureBoundaryTests` 单 owner 断言；工程三套 iPhone source target、测试 target 和本地 runner 已接线。静态差异复审确认旧四个窗口 helper 已从 AppStore 移除。
- 验证：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-window-reconcile-runner3` **33 Phone + 80 Watch + 2 HTTP/重启阶段通过**；`xcodebuild ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-window-reconcile-build-for-testing3.log`）；generic build **BUILD SUCCEEDED**（`/tmp/aedresponse-window-reconcile-unit1.log`）；`git diff --check` 通过。目标 Simulator XCTest 因 `NSMachErrorDomain Code=-308 (IPC server died)` 未形成运行证据，不能写成测试执行通过。
- 本批没有后端源代码变更；后端 **183/183**、业务 **120/120** 沿用上一批已确认结果。未运行物理设备、Watch OS 后台或正式 APNs/路线 provider。窗口缺失、终态、跨事件争用、Watch fallback 有效 P 和 AED 生命周期仍不作新规则解释。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-appstore-event-window-final/`；已保存源码/工程/测试/runner/文档副本并完成 `SHA256SUMS` 校验。恢复前逐文件比较，不删除队列或数据库。
- 下一步：按 P0 优先检查事件位置批次 ACK/永久拒绝隔离与 AppStore 其余 presence/assignment 编排是否还有第二写入入口；之后再决定是否进入小规模电脑合成负载试验。不要清空受保护队列，不做数据库/生产迁移，不把 generic build 当真机能力。

## 2026-09-10 P0-APPSTORE-EVENT-FACTS（当前继续起点）

- 新增 `ios/AEDResponse/Application/EventPositionFactCoordinator.swift`，接管开放事件位置 slot、候选 fix、clock/APP_NOT_RUNNING 标记、草稿恢复、movement 计算和封口后的清理；AppStore 保留服务端参与窗口、账号/连接代次、受保护队列、ACK/隔离和 UI 投影。
- AppStore 的 `receiveLocationBatch`、`captureEventPositionSlot`、恢复 slot、开放草稿写入和封口路径已接入 coordinator；原始 `CLLocation.timestamp`、同 slot latest fix、先持久化再确认、ACK 前不删除不变。
- `ArchitectureBoundaryTests` 新增单 owner 检查；`run_architecture_repair_checks.py` 纳入新 coordinator。最新本地链 **33 Phone + 80 Watch + 2 HTTP/重启阶段通过**，证据目录 `/private/tmp/aedresponse-event-position-fact-runner2`；iOS Unit generic `build-for-testing` 通过。
- 未完成：后端/服务端权限和 event window 仍由 AppStore adapter 处理，事件批次 ACK、退出窗口 reconciliation、assignment/Presence 等职责尚未迁移；未运行物理设备或 Simulator XCTest。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-appstore-event-facts-final/`；含 coordinator、AppStore、工程接线、测试、runner 和文档副本，`SHA256SUMS` 已校验。

## 2026-09-10 P0-ROUTE / STATUS / WATCH ADMISSION / APPSTORE RECEIPT / STORAGE（当前继续起点）

- 路线 authority：新增 `backend/src/route-provider.ts`，`ReferenceAedRouteProvider` 封装现有确定性几何算法；`service.ts` 的 estimate/refresh/replan 和 `aed-actions.ts` 的 AED 替代都经注入 provider，非法输入/提供方不可用 fail-closed，不虚构旧 route 或 assignment。未配置真实地图/路线 provider，未改变 AED 业务待决规则。
- 状态确认：新增 `backend/src/status-confirmation.ts`，同时接管 CONTINUE response 的幂等/截止/审计事务和 tick scheduler 的 PENDING/超时/请求写入；service 只做权限和 callback 适配。30 分钟/5 分钟/终态原因保持原规则。
- Watch fallback admission：新增 `WatchFallbackAdmissionPolicy`；默认 policy 保持 iPhone ACTIVATED+reachable 抑制与 WAN 门槛，未决的“后端是否已收到有效 P”只能注入 `blockedPendingBusinessRule`，不会采集/发送或删除已有证据。新增阻断策略 XCTest。
- AppStore 剩余回执编排：新增 `ios/AEDResponse/Application/DeliveryReceiptUploadCoordinator.swift`，接管 receipt context admission、append/drain/retry/ACK/cancel；AppStore 仅维护会话 context 和 UI 错误/投影。新增跨 AppStore 实例共享 durable queue 的重启测试，generic Unit/Watch build-for-testing 通过。
- 存储成本：SQLite `committed flattened rows` cache 只在成功写入后前移，避免 no-op 重复 flatten；`measureStorageCost` 和 storage-load 输出实体/字节/历史/批次/PENDING 指标。50k synthetic 档约 9.82MB、287ms reopen、67ms full read、50ms entity read、138ms no-op transaction、1.08s 八串行事务；只是合成成本证据。
- 代码与验证：后端 `npm test` **183/183**、`npm run test:business` **120/120**、`npm run check`、`npm run build`、`git diff --check` 通过；iOS `AEDResponseUnitTests` 与 Watch `AEDResponseWatch` generic `build-for-testing` 通过。模拟器 targeted test 因 CoreSimulator launch IPC server died（`NSMachErrorDomain Code=-308`）未形成运行通过证据；未把它写成成功。
- 当前未完成：完整 AppStore runtime/事件位置事实迁移、物理 iPhone/Watch 后台/蜂窝、正式路线 provider、APNs/App Attest、目标负载与生产容量；AED 生命周期、跨事件争用、失联补位、活动登出、Watch fallback 有效 P 等规则仍待用户/产品决定。不要清理受保护队列、不要执行数据库迁移或生产操作。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-route-status-receipt-storage-final/`；含源码/工程/测试/文档副本、`VALIDATION.md`、`REVIEW.md`、`SHA256SUMS`，校验已通过。恢复前逐文件比较，不用 `git reset` 或清空持久队列。

## 2026-09-10 P0-WATCH-OS-01 / 权限恢复批次（当前继续起点）

- 已完成 Watch/OS 侧的结构整改：`WatchRuntimeModel` 把进程启动、`scenePhase == .active` 和周期机会统一到 `recoverAfterLifecycleBoundary`，恢复会话、待确认触发、fallback、已知事件状态并保留 generation/受保护队列；进程内 5 秒机会仍明确不是 watchOS 后台频率保证。
- Core Motion callback 现在在受保护本地 Fall 事实落盘后立即 completion，网络/Watch fallback 恢复异步继续，避免把网络等待延长为系统回调生命周期；这仍不等于 OS 后台频率或物理 Fall Detection 证据。
- `LocationFixValidity` 由 `ios/AEDResponse/Domain/Models.swift` 供 iPhone/Watch adapter 共用，拒绝越界/非有限坐标、非正或非有限精度、非有限时间和未来 fix；Watch fallback coordinator 对注入/恢复样本再次 fail-closed，历史样本仍保留原时间补传。没有新增 freshness 或产品阈值。
- 后端 B1/B2 行为保持：撤销断连、实时发送授权、Watch 专用状态查询和投影字段白名单没有扩大；`IdentityAccess.assertCurrent` 只加在 `replayPendingResponses` 内部恢复入口，撤销/过期/重绑的旧 principal 返回 401，不绕过每请求认证。
- 本批新增测试：`ios/AEDResponseTests/LocationFixValidityTests.swift`、`ios/AEDResponseWatchTests/WatchLocationProviderTests.swift`、Watch fallback future-sample 回归及 `backend/test/auth.test.ts` stale principal 回归。后端全套 `npm test` **179/179**、业务套件 **116/116**、`npm run check`、`npm run build`、`git diff --check` 通过；iOS 与 Watch generic `build-for-testing` 均通过，日志为 `/tmp/aedresponse-p0-watch-os-final-unit.log` 与 `/tmp/aedresponse-p0-watch-os-final-watch2.log`。隔离本地 runner `/private/tmp/aedresponse-p0-watch-os-runner-1789028543` 实际 **33 Phone + 79 Watch + 2 个真实 HTTP/重启阶段** 通过。未运行物理 Watch、watchOS XCTest、系统挂起/终止后台、APNs 或蜂窝网络。
- 复审方式：本批由同一执行者逐行复核并重跑测试，没有冒充独立审核。准确下一步是补路线 provider 的 fail-closed/错误分类，或在设备恢复后执行物理 Watch/OS 证据；不把本批 generic build 当成真机后台通过。
- 本批可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-watch-os-final/`，校验见其中 `SHA256SUMS`；恢复前需和前一批快照逐文件比较，不删除任何持久队列或数据库。

## 2026-09-10 新目标与最新验证

- 新目标已登记：完成六项业务关键整改后，先做隔离的小规模试验；存储容量、历史增长、队列积压和目标负载由电脑通过 HTTP 向测试服务器发送合成数据验证。试验不触发真实求助、不发送真实通知、不操作生产数据库。正式身份/App Attest/APNs/真实路线/物理 Watch capability与 Xcode Cloud 两类 P2 延后到基础测试通过后再处理。
- 六项范围固定为：后端接受/退出/任务用例事务权威、跨进程事实恢复、路线 provider 权威边界、Watch/OS后台恢复与有效位置判定、会话/查询/实时权限、可靠通知发件箱与授权重试。未决业务规则不在试验中自行决定。
- 当前可复现结果：后端 `npm test` **179/179**、`npm run test:business` **116/116**、`npm run check`、`npm run build`、`npm run architecture:storage-load`、`git diff --check` 均通过；既有隔离 SQLite 探针重启后保留历史/通知/位置批次计数。iOS generic unit build 通过；物理 iPhone `AEDResponseUnitTests` 全套 309 执行、0 失败、29 跳过。
- 真机测试发现并修复 `WatchPersistence.swift` 的 Keychain 更新属性错误：更新操作只写 `kSecValueData`，可访问级别只在首次新增时设置。修复前 9 个 WatchMonitoring 持久化用例失败，修复后全套通过；日志分别为 `/tmp/aedresponse-ios-device-tests-20260910.log` 与 `/tmp/aedresponse-ios-device-tests-fix-20260910.log`。这属于跨进程恢复相关的真实 P0 缺陷修复。
- 当前仍不能声称 Watch 真机、APNs、Fall Detection entitlement、后台系统执行频率或生产容量已通过；在线 iPhone 可运行 XCTest，物理 Apple Watch 当前离线。
- P0-RECOVERY-01 已完成源码整改：delivery receipt 队列新增 `recover()`，保存失败的合法回执暂存于 blocked 保留区，重新登录/连接时先恢复持久化再 drain；`AppStore` 不再让连接重建永久绕过 blocked 队列。通用 iOS `build-for-testing` 通过（`/tmp/aedresponse-p0-recovery-build-20260910.log`）。本轮真机定向测试因 iPhone 在执行前掉线未运行，Mac Designed-for-iPhone 因 provisioning profile 不包含 Mac 设备未运行；两者均为环境阻塞，不是新增断言失败。下一项是后端接受/退出/任务用例边界。
- P0-USECASE-RESPOND-01 已完成：`backend/src/response-decision.ts` 接管响应请求 ACCEPT/REFUSE 的 decision fingerprint、delivery 幂等、资格复核、参与区间、assignment/recruitment 同事务写入；`EmergencyService.respond` 只保留认证入口和提交后通知适配。后端 `npm run test:business` 100/100、`npm test` 163/163、check/build 通过；新增静态边界测试确认旧 `respond` 不再保留第二个 `store.transact`。下一子批才处理响应者退出或任务状态，不同时改业务规则。
- P0-USECASE-EXIT-01 已完成：`backend/src/responder-exit.ts` 接管退出幂等、单响应者确认、参与窗口、offer 过期、assignment 取消、AED 已取得事实保留、设备撤权和补招重算；`EmergencyService.exitEvent` 只保留认证入口与提交后通知适配。后端 `npm run test:business` 101/101、`npm test` 164/164、check/build 通过；新增静态边界测试确认旧 `exitEvent` 不再保留第二个 `store.transact`。下一项再处理 assignment 状态入口，不提前改 AED 生命周期。
- P0-USECASE-ASSIGNMENT-01 已完成：`backend/src/assignment-status.ts` 接管普通 assignment 状态图、权限/退出撤权、因果时间、revision、完成招募阶段和同事务 recruitment 更新；`EmergencyService.updateAssignmentStatus` 只保留 scope、依赖适配与提交后通知。后端 `npm run test:business` 102/102、`npm test` 165/165、check/build 通过；新增静态边界测试确认旧入口不再保留第二个 `store.transact`。专用 AED/超时/退出终态入口未改变。
- P0-NOTIFY-DECISION-01 已完成：`response:decision-recorded` 由 `runResponseDecision` 在同一 `StateStore.transact` 内写入 durable outbox；`service.respond` 停止该消息的事务外直发，提交后统一 drain，发送时重新检查患者/已接受响应者及设备 context。受控 publisher 不可用时两条记录保持 PENDING，恢复后同一 payload 只派发一次；同内容重试不新增记录，退出后响应者记录会被 SUPPRESSED。`assignment:created`、路线刷新、补招和 `response:requested` 等其它路径仍未迁移。
- P0-NOTIFY-ASSIGNMENT-01 已完成：普通 `updateAssignmentStatus` 在同一事务内写入 `assignment:updated` outbox，提交后停止该路径的直发；发送时检查当前 assignment ID/revision、事件 ACTIVE、任务本人、接受关系和退出撤权。publisher 不可用时记录保持 PENDING，恢复后只派发当前 revision；退出后旧记录 SUPPRESSED。后端 `npm run test:business` 107/107、`npm test` 169/169、check/build/storage-load 通过。接受重算、路线刷新、AED 替代和补招 assignment 通知仍待下一批。
- P0-NOTIFY-REPLAN-01 已完成：响应接受触发的 `assignment:created/updated` emission 在 `runResponseDecision` 同一事务内写入 outbox；`service.respond` 停止该集合的事务外直发。publisher 不可用时接受、响应决定和任务通知共同保留，恢复后按当前 assignment revision 派发；重复接受不新增记录。后端 `npm run test:business` 107/107、`npm test` 169/169、check/build/storage-load 通过。退出补招、路线刷新、AED 替代和患者位置重算的 assignment 通知仍待下一批。
- P0-NOTIFY-EXIT-REPLAN-01 已完成：响应者退出触发的 assignment 重算 emission 在 `runResponderExit` 同一事务内写入 outbox；`service.exitEvent` 停止该集合的事务外直发。publisher 不可用时退出与剩余任务通知共同保留，恢复后只派发给仍参与且 revision 有效的设备；退出者和旧 revision 被抑制。后端 `npm run test:business` 108/108、`npm test` 170/170、check/build/storage-load 通过。路线刷新、AED 替代和患者位置重算通知仍待下一批。
- P0-NOTIFY-ROUTE-01 已完成：患者位置更新、事件位置批次和 Watch fallback 促成的路线刷新 assignment emission 在 `refreshPatientRoutes` 所属事务内写入 outbox；位置接口提交后先 drain，再发布位置/招募投影。publisher 不可用时路线更新保留 PENDING，恢复后按任务本人和当前 revision 派发一次。后端 `npm run test:business` 110/110、`npm test` 172/172、check/build/storage-load 通过。AED 替代和其它非位置驱动 assignment 通知仍待下一批。
- P0-NOTIFY-AED-REPLACEMENT-01 已完成：`AED_UNAVAILABLE` 事务内创建的 replacement assignment 现在写入 `assignment:created` outbox；`reportAedUnavailable` 停止该替代任务的事务外直发，仍保留 `aed:unavailable` 参与者广播。publisher 不可用时替代任务记录保持 PENDING，恢复后按任务本人派发一次。后端 `npm run test:business` 112/112、`npm test` 174/174、check/build/storage-load 通过。其它 AED 业务生命周期和跨事件争用规则未改变。
- 本轮继续完成核心后端用例与可靠通知 P0：新增 `backend/src/aed-actions.ts`，把 AED 取得、AED 不可用/替代的 fingerprint、权限、因果时间、唯一事务和替代 assignment 入箱集中到专用用例；新增 `backend/src/event-resolution.ts`，把 resolve、false-alarm 和终态通知意图集中到同一结束用例。`service.ts` 仅保留认证/依赖适配/提交后 drain；状态确认 tick 与尚未定义业务规则的 assignment `TIMED_OUT` writer仍未声称迁完。
- 可靠通知现在覆盖 `response:requested`、offer 过期、患者激活、患者位置/coordination、状态确认、退出、AED 广播、assignment emission 与终态；旧候选 `SENT` 直发重试已停用，发送记录统一按当前设备/账号/pair/事件/接受关系/revision 重新授权。新增 `event-resolution-boundary.test.mts`、`reliable-notification-boundary.test.mts`；最新后端业务套件为 **116/116**，完整套件为 **178/178**。
- 路线权威边界已写入 `docs/architecture-repair.md` 与 `contracts/events.md`：后端保存 P/R、AED、R-A-P route、ETA/assignment revision 和失败状态；iPhone/Watch 只提交事实、缓存展示和恢复意图。当前 `makeAedRoute` 仍是参考几何估算，真实 provider/超时/fail-closed/路线凭据另列工作包，未把地图 SDK 当选路真相。

## 2026-09-10 渐进架构整改：A/B/C核心链已逐批完成，D1/D2/D3/V1/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14/D15/D16完成本地复审，E-STORAGE-01/E-STORAGE-02及E-POSITION-INTERLEAVE-01完成本地复审，整体整改仍未完成

- 实际仓库是Desktop/毕设项目；任务默认Documents目录不是产品源码。分支codex/architecture-repair-20260909，HEAD仍8362af26a1cfcadd7dc1753f3f4ba9310456ae2e。原72个tracked dirty及大量untracked已保留；没有提交/推送/部署。不能把旧HEAD差异当本轮diff。
- 统一台账docs/architecture-repair.md，含基线/三份评审复核/所有权/每批前置、证据、兼容与回退。私有可恢复源基线、B1–C5、D1/D2/D3/V1各批patch/归档/哈希/日志在 /Users/REDACTED/Documents/AEDResponse-local-baselines/20260909-0540/；原source基线211文件。不是生产DB备份，未包含忽略的密钥/真实运行库。
- B1身份与Socket撤销、B2audit与恢复投影分离、B3真实fix时间，C1共同终态writer、C2事务outbox、C3Phone结束意图、C4a/b/c/d Watch查询/历史/不丢记录/配对代次，均已独立只读复审并修正发现问题。C4d最新真实Watch组件57/57、unit编译与production iOS+Watch Release通过。详细差异与红绿证据在台账，不能只凭文件大小或编译声称完成。
- C5已有可重跑入口：python3 ios/scripts/run_architecture_repair_checks.py --output <仓库外新目录>。13个真实Phone API/结束组件＋2个实际URLSession/loopback/SQLite阶段通过：丢end及首恢复响应、原日志同body重试；Watch在phone可达时终态封口、完整原历史字段补传；另起Node后端进程后REST恢复无新end。独立复跑及完整fact比较补强复核通过。2条outbox保持PENDING，未伪称送达；所有fixture均退出，凭据/DB仅私有临时目录。
- 当前D1：state-read/三种内建store按已提交快照逐实体复制；IdentityAccess认证/Socket复验与Watch GET已停用原全量read，事务与DB格式未动。161/161后端、check/build及成本脚本strict检查通过；D1-native-chain再跑13+2真实链通过。副本隔离/版本稳定/关闭拒绝/兼容外接store及权限失败全覆盖。D1独立9项针对复审通过，12文件与清单一致，无新增阻塞，本轮源码批次已结束。
- D1同进程交替对比5万合成audit（9.14MB）：读同一个device旧46.8874ms、新0.0309ms中位；原空事务120.6167ms。仅进程内实体读取改善，SQLite仍全状态加载/写入，其他调用仍有全量成本；不是并发或目标容量证明。保留并行测量日志与后来独立跑的quiet日志，不拿极值当SLA。
- 用户明确先修架构、修好再真机，继续禁止16设备操作/排障。此前独立test bundle签名安装成功但3次XCTest建连前code74/DTX退出，0业务断言；原联网bundle未覆盖，主工程入口未改。最小宿主也失败，不得归因AppStore初始化。
- 缺口：C5是核心REST/持久化链，不是AppStore/UI/OS完整运行。C3新增API路由现已在Mac真实源码跑通，AppStore两项按钮测试仍只有编译+源码复审；真实AppAttest、WCSession、GPS、后台频率、APNs/送达和容量未验证。V1已将旧WatchCoordinatorContractTests的600秒断言按批准需求修正为120秒，原baseline2项1失败与修正2/2分开；活动Watch测试target的generic watchOS Simulator build-for-testing也通过（V1-watch-compile.log），系统运行仍未执行；Mac验证直接链接相同实际测试。Apple Developer Program会员资格现已获批，正式签名、App Attest、APNs和物理设备工作包解除会员资格冻结，但架构完成前仍按用户要求不启动真机验收。
- V1仓库统一入口 python3 ios/scripts/run_architecture_repair_checks.py --output <仓库外新目录> 已同时运行13 Phone、67 Watch组件及2个真实HTTP阶段；不是私有66项的同一集合（移除1个私有额外兼容、加入2个活动契约）。首轮警告已修raw regex，strict Python检查通过；V1-independent-checks最终独立完整复跑13+67+2通过，源SHA/完整事实/退出和端口核实。未更改业务源/依赖，选中0测试必须失败。
- 下一准确起点：D16已迁 delivery receipt 队列持久化 owner；继续验证持久化失败后的人工/会话恢复入口，再按P0从 backend 接受/退出/任务用例边界、路线 provider 和 Watch/OS后台恢复中选择不改变业务规则的路径。不要让旧路径和新路径并行写入；未知Watch旧记录仍只能在GET证明事件存在且当前会话有权访问后原样重放。
- D2最终66/66 Watch组件、unit编译、iOS+Watch Release和13+2真实HTTP链通过；D3最终补齐fallback来源/损坏context、outbox交接和来源/代次竞态后，D3-final2-native为93项执行、2项跳过、0失败，后端161/161，D3-final2-chain为13 Phone+78 Watch+2 HTTP，iOS unit、Watch generic与iOS Release通过。第一次iOS unit并行构建仅遇DerivedData build.db锁，独立目录D3-final2-unit-derived已TEST BUILD SUCCEEDED。D3不是实际后端误归属/真机重装证明，fallback全历史来源/OS后台仍未验收。
- D3最终独立只读复审5/5通过，确认outbox交接、来源/GET proof/ACK代次和最后入队guard；最终93项执行、2项跳过、0失败与13+78+2集成证据一致。最后guard是静态竞态修复并由专项回归覆盖相邻阶段，不声称物理设备复现。
- D4已将iPhone待命/搜索圈最新值R的pending、稳定positionUpdateId、任务、重试、ACK tier迁入Application/LatestPositionUploadCoordinator.swift；Domain/LatestPositionUploadPolicy.swift仍只保留阈值策略。AppStore保留模式/连接代次、UI投影和事件一秒批次，旧drainPositionUploads已停用。最终D4-native为15 Phone+78 Watch组件、2个真实HTTP阶段；新增503重试和错误ACK同ID重试均通过，iOS unit generic与iOS Release generic均通过。
- D4独立只读复审发现并修正错误ACK静默丢样本及401冲突语义两处迁移偏差；当前APIClient组件8/8通过，错ID回归验证invalidResponse后同ID重试，冲突集合保持403/409。模拟器测试宿主仍在任何断言前Testing canceled，不能当作完整AppStore runtime证据。
- D5已将连接重试目标URL、退避次数、等待退避任务和取消generation迁入Application/ConnectionRetryCoordinator.swift；AppStore保留connectionGeneration、LiveSession、ConnectionState和REST-first恢复，旧desiredBaseURL/reconnectAttempt/reconnectTask状态已停用。当前D5原生链为16 Phone+78 Watch组件、2个HTTP阶段，unit/Release generic build通过；独立复审确认无新增阻塞。D5不宣称bootstrap在途期间的全流程single-flight。
- D6已将REST恢复的等待、1/2/4/8/16/30秒退避、同代次follow-up合并和取消generation迁入Application/RestoreCoordinator.swift；AppStore保留reconcileVisibleEvents、connectionGeneration、restoredConnectionGeneration及恢复后投影顺序，旧restoreRetryTask/restoreAttempt/restoreFollowUp*状态已停用。Socket暂断使用cancelWaiting保留原退避次数，新连接/主动断开使用reset清零。D6原生链为17 Phone+78 Watch组件、2个HTTP阶段，unit与iOS+Watch Release generic build通过；独立复审确认可收口。D6覆盖恢复调度，不宣称完整AppStore runtime single-flight。
- D7已将事件投影过滤、同ID合并、终态单调性和coordination revision门迁入Application/EventProjectionReducer.swift；AppStore仍唯一写入visibleEvents并负责pending patient、assignment、response request、位置窗口和Presence副作用。D7原生链为18 Phone+78 Watch组件、2个HTTP阶段，unit与iOS+Watch Release generic build通过；投影规则回归通过。D7不宣称完整AppStore runtime或真机。
- D8已将当前响应邀请、DeliveryStatus和DeliveryReceiptMachine迁入Application/ResponseOfferProjectionCoordinator.swift；AppStore保留UI镜像、VIEWED/过期/角色门禁、REST respond和内存待发送回执队列。接受/拒绝异步结果增加连接代次及三项邀请标识复验，旧回调不能污染新邀请。D8原生链为19 Phone+78 Watch组件、2个HTTP阶段，unit与iOS+Watch Release generic build通过；独立复审确认结构可收口。内存回执队列跨登出/进程恢复仍未解决。
- D9已将当前 assignment、acceptedResponseEventID、按 assignment 的 AED receipt 幂等状态迁入Application/AssignmentProjectionCoordinator.swift；AppStore保留角色/退出门禁、REST task、timeline、事件位置窗口和Presence副作用。assignment/AED异步回调共同复验认证、连接代次、event/assignment ID、revision与原status；跨会话不再用旧 AED_UNAVAILABLE 结果启动新REST读取，超时投影会使旧状态回调失效。D9原生链为20 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；独立复审确认无新增严重回归。完整AppStore runtime、真机/Watch后台和AED业务规则仍未证明。
- D10已将 Presence latest-state 上传迁入Application/PresenceUploadCoordinator.swift；AppStore保留连接/认证/恢复门禁、lastPresence镜像和ACK后附近摘要副作用。相同signature抑制重复、临时失败复用同一presenceUpdateId、force生成新ID、最新pending替换旧pending；发送前及await后复验connected/LiveSession/业务权限/恢复代次，reset后的迟到ACK/错误不回写。D10原生链为22 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；独立复审确认无新增严重回归。附近摘要查询、事件位置、完整AppStore runtime和真机仍未证明。
- D11已将附近志愿者摘要查询迁入Application/NearbyVolunteerSummaryCoordinator.swift；AppStore保留中立/权限/任务/邀请门禁、离线预览和nearbyVolunteerSummary镜像。查询task、generation、取消和新鲜度由协调器维护；refreshNearbyVolunteers仍等待查询完成，旧调用者取消不会清理新generation。D11原生链为23 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；独立复审确认无新增严重回归。事件位置、完整AppStore/UI runtime和真机仍未证明。
- D12已将事件位置 UTC slot scheduler 迁入Application/EventPositionSchedulerCoordinator.swift；AppStore继续唯一维护eventPositionContext、slot事实、持久化draft、FIX/NO_NEW_FIX、恢复分类、封口和批上传。scheduler按开始时间/最后封口slot逐秒catch-up，context lease失效自动停止；TestHost仍显式驱动slot。D12原生链为24 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；独立复审确认无新增严重回归。事件位置恢复/批上传完整交错、OS后台和真机仍未证明。
- D13已将事件位置恢复 grace scheduler 迁入Application/EventPositionRecoverySchedulerCoordinator.swift；AppStore继续唯一维护恢复窗口、APP_NOT_RUNNING事实、持久化draft、封口和批上传。scheduler先等待5秒，再按context lease循环推进，pending清空或context失效自动停止；TestHost仍直接驱动controlled recovery。D13原生链为25 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；独立复审确认无新增严重回归。恢复/批上传完整交错、OS后台和真机仍未证明。
- D14已将事件位置批上传 transport single-flight、immutable batch 重试和连接/账号/设备代次 lease 迁入Application/EventPositionBatchUploadCoordinator.swift；AppStore继续唯一选择已持久化 batch、执行业务门禁、ACK 后删除和永久拒绝隔离。D14原生链为27 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；测试覆盖重复启动、503后同批重试和reset后迟到ACK抑制。恢复/批上传完整交错、OS后台和真机仍未证明。
- E-STORAGE-01已修复三种内建 StateStore 的 no-op transaction 写放大：完成验证和 append-only 校验后，未变化状态不再发布/持久化，SQLite revision 不再无条件递增；真实状态变化与队列事实保持原语义。后端 `npm test` 162/162、check、build 通过，storage cost 探针结果保存在 `/tmp/aed-storage-capacity-baseline-20260910.log`。全状态 clone/validate、启动加载、历史增长、目标负载仍未解决。
- E-STORAGE-02已新增 `backend/test/architecture-repair-native/storage-load.mts` 与 `npm run architecture:storage-load`，测量 0/1k/10k/50k 历史、通知/位置队列增长、SQLite 重启和 8 个串行化事务；50k 档约 9.82MB、168ms 重启、37.6ms entity read、1.06s 八事务，重启后计数一致。后端162/162、check、build和探针均通过；仅为合成成本证据，不是目标负载验收。
- E-POSITION-INTERLEAVE-01已验证原批次 REST 挂起时恢复 grace 追加第二个 pending batch，原批次 ACK 只删除原批次且恢复批次保留。实际链为28 Phone+78 Watch+2个HTTP/重启阶段，Unit、ControlledTests与iOS+Watch Release generic build均通过；完整 AppStore runtime、OS后台和真机仍未证明。
- D15已将事件位置队列 I/O load/save 与失败生命周期迁入Application/EventPositionQueuePersistenceCoordinator.swift；AppStore继续唯一维护队列业务事实、draft、封口和ACK删除。D15原生链为29 Phone+78 Watch组件、2个HTTP阶段，unit、ControlledTests与iOS+Watch Release generic build均通过；损坏文件保留、reset不清事实和blocked失败门回归通过。完整AppStore runtime、跨进程恢复、OS后台和真机仍未证明。
- D16已将delivery receipt队列的持久化、服务/账号/设备context隔离和精确ACK删除迁入Application/DeliveryReceiptQueuePersistenceCoordinator.swift与Services/DeliveryReceiptPersistence.swift；AppStore不再拥有pendingDeliveryReceipts数组，logout只reset内存owner。D16最终原生链为32 Phone+78 Watch组件、2个HTTP/服务重启阶段；Unit与ControlledTests generic build、Watch Release unsigned generic build通过。生产Release签名构建因AEDResponse/AEDResponseWatch未配置Development Team阻塞，未猜测Team ID；完整AppStore runtime、APNs/用户查看、OS后台和真机仍未证明。
- 后续四类事项已分开登记：正式身份/App Attest/APNs/Xcode Cloud与路线/OS后台/真机属于外部能力工作包；存储属于可继续的本地结构/负载验证；AED生命周期、跨事件争用、失联补位、活动logout属于业务待决，不能自行选择规则。未配置的真实供应商、云端workflow、APNs发送、硬件和生产迁移均未触发。
- Xcode Cloud单列为XCLOUD-01外部能力工作包：当前工作树无ci_scripts、workflow配置、develop分支引用或xcode-cloud CLI；会员资格获批只解除冻结，不等于仓库已连接或有首个云端构建。未创建workflow、未触发云构建、未写入App Store Connect。
- 2026-09-10已按业务影响重新排序：P0先做后端接受/退出/任务用例权威、D16回执跨进程恢复、路线provider边界和Watch/OS后台可观测恢复；P1处理存储目标负载与业务决策门；正式身份/App Attest/APNs/真实路线/真机按外部前置推进；Xcode Cloud仅作为自动化调试辅助评估，暂缓配置和触发。具体批次与前置见docs/architecture-repair.md的“业务影响优先级调整”。
- Fall Detection申请状态（2026-09-13更正，旧行写“尚未提交”已过期）：**已于2026-09-11通过Apple官方表单提交，等待审核、尚未获批**。Watch App ID为dev.codex.aedresponse.watchkitapp，代码已声明com.apple.developer.health.fall-detection和NSFallDetectionUsageDescription，尚未取得含该key的profile。该能力**在开发者网站上没有可勾选位置、提交后也没有可查记录**，编号只能从Apple回执邮件抄回；本机客观证据是重新下载的Watch profile是否出现该key（2026-09-13 16:03复核：不含）。申请材料、英文说明和提交后验收步骤在docs/apple-fall-detection-entitlement-request-2026-09-10.md；不得把本地entitlement或generic build写成Apple批准。
- 签名配置已推进：从本机 development profile 核实 Team ID 为GR6YBCDW7R，已写入ios/project.yml项目级DEVELOPMENT_TEAM并回读iOS/Watch/ControlledTests三个scheme；allowProvisioningUpdates已生成主bundle profile，但Watch profile拒绝Fall Detection且不包含当前Watch AppAttest entitlement。当前签名阻塞已从Team缺失收敛为Apple能力授权/entitlement配置，不得移除受限能力来伪造通过。
- 回退分开：D2/D3必须保留新增本地身份、来源指纹和throws错误边界；不得退回旧decoder重写后盲重试或把UserDefaults坏数据当空状态。D1只是读API源码，无数据迁移；C2新outbox collection的旧reader会拒绝，必须前向兼容读取，不能删行/恢复旧库。C3日志独立保留；C4b/c/d的封口/隔离/拒绝/confirmedID/fingerprint新字段必须兼容保留，不能让旧decoder重写而丢数据。原被旧版删除的事实无法恢复，不补造。
- Apple Developer Program会员资格已获批：正式签名与安装、App Attest、APNs、物理iPhone/Watch capability和授权链路不再因会员资格冻结。它们仍需真实配置/账号/设备分层验证，不能把本地stub或generic编译当成完成；用户仍要求架构整改完成后再启动真机。
- 业务待决维持：无人回答关闭、重复跌倒、人数/VIEWED、失联补位、AED无替代/持有退出/交接归还、活动登出/权限下降、phone可达但后端无有效P的fallback。当前Watch不可达立即备份、backend10秒仲裁；不能恢复旧30秒规则。事件结束不等于AED实际归还。
- Wi‑Fi 可调用手机已记录为后续真机验收的传输条件；按用户要求，架构批次未完成前仍不启动真机。后续启动时必须把 Wi‑Fi、蜂窝和离线证据分别记录，不能用手机可达代替后端已收到有效位置。

## 今日17阶段完成：真实联网版待命正常，双机留后续

- 17最后版本已安装，21:42:49蜂窝nearby-volunteers请求200、门禁全true、连接
  connected、legacy=false。已恢复无诊断环境正常启动。16本阶段未动。
- 现有模拟事件已误报终结，R待命、队列0；没有新事件，后续不要默认还在患者态。
- 修复/证据/限制完整记录docs/connectivity-repair-2026-09-08.md。后端124项通过；
  MainActor补录分段与时间codec复用已实机恢复批次上传。不得写成全部上架就绪。
- 旧199秒历史空缺保持记录不伪造；双机蜂窝、后台APNs、正式登录/Watch权限、
  境内生产存储与压力验收仍待完成。用户今天明确只17，下一轮若要16须看新指示。

## 最新终态确认：17误报结束成功，今天16不动

- 用户确认17点击误报。真实蜂窝POST confirm-false-alarm于13:38:46Z返回200。
  服务器CANCELLED_CONFIRMED_FALSE_ALARM/FALSE_ALARM，resolvedAt13:38:46.744Z；
  17 currentEventId=null，最新位置R，最后待发批次ACK后pending=0。
- 累计服务器311批次1516条证据。历史199秒缺口如前段所列，不倒填、不声称
  整段严格每秒验收。新修复后单机蜂窝状态/位置/结束闭环有证据，双机没有。
- 用户“修复到上架程度”不能标为已完成：APNs后台/双机/真实身份/Watch能力/
  生产数据层与压测仍待。详见docs/connectivity-repair-2026-09-08.md。
- 当前追加待命R和presence ACK后刷新附近人数，解决先查询后同步的竞争；
  正在构建安装17最后版本，日志nearby-final-build.log。不再触发事件或碰16。

## 最新修复：仅17实测，网络发送/恢复及主线程积压已修

- 用户要求联通修到上架程度，随后明确今天仅17，不操作/更新16；保留实机
  真实联网构建，禁止离线宿主覆盖。今天双机不验收。
- 后端新增私有Unix IPC simulation-admin.ts，CLI改发给活跃服务，取消停服/独立
  writer；默认关闭，生产不装测试drop-in。createSimulatedEvent事务后实际emit。
  Socket重连补发有效请求；持久SENT每5秒补发至回执或到期，不改ID/30秒超时。
- 本地及Azure124/124通过（含真实Socket+IPC、重连补发、过期抑制、重试），
  已部署/opt/aedresponse/releases/connectivity-repair-20260908候选src/dist及脚本。
  RuntimeDirectory=/run/aedresponse为0700，simulation.sock0600；CLIroot:aedresponse0640。
  备份/var/lib/aedresponse/backups/before-connectivity-repair-20260908.sqlite与
  /opt/aedresponse/releases/before-connectivity-repair-20260908。账号/表结构未改。
- 17升级真实联网版（不再设置legacy频率兼容flag，现false）。已修错误归属清除、
  回前台REST补取/附近人数刷新。用户确认17出现模拟患者页。
- 新确认根因：事件历史补录/封口在MainActor长循环，阻塞异步网络恢复。已从
  最后封口槽继续、逐槽Task.yield、恢复每段5槽让出执行权，不删除/伪造记录。
  时间编解码改每codec复用锁保护ISO格式器；1500记录精度测试0.47秒→0.08秒。
- 17最终安装/运行日志/tmp/aed-connectivity-release.gGDotU/iphone17-final.log，
  console session56972。21:35起真实网络响应均cellular=true，批次持续200；
  积压队列已到0，30次取消路径后续均200。服务器有真实FIX和NO_NEW_FIX。
- **历史缺口仍须披露**：服务器slots审计唯一无重复，但13:24:56–13:28:14Z
  缺199个秒槽，发生在旧阻塞/反复重启阶段。没有倒填或删除。最新修复后的时间
  段未观察到缺口，不能因此声称整段历史严格每秒全通过或整个产品上架就绪。
- 已请用户仅在17模拟患者页点“误报”一次结束，等待确认及终态核对；不新建事件。
  eventId=REDACTED-ID-77cb6ef20beae373。16今日保持不动。
- 新恢复分段回归源码已补、build-for-testing仅编译通过，未安装/运行离线宿主。
  新codec独立Mac测试通过。上架缺口仍包括APNs后台、双机蜂窝闭环、特殊Apple
  能力/正式身份、分层生产存储与压测；不得把17单机或合成回归当成全部验收。

## 最新断点：SIM-02模拟请求仅生成、没有实时发送

- 用户明确16从未出现请求。服务端16后续13:13:02Z有新在线，早于此的请求
  13:10:40Z已EXPIRED，0回执/0接受/0任务。事件仍ACTIVE，不得重造或删记录。
- 确认测试工具缺陷：CLI service默认noopPublisher；createSimulatedEvent
  只调用refreshRecruitmentForEvent并丢弃发送结果，没有像Watch路径那样
  提交后emit patient-activated/response:requested。live Socket连接只发ready。
  该轮依赖重连REST补取，停服/恢复又消耗30秒offer有效期。
- 不能因此声称16持续断网或派单算法坏了；为何未及时重连还未证实。
  需要修测试投递链路并增加实际publisher/Socket回归，不能延长原业务超时、
  重置过期请求或伪造回执。详见docs/simulation-run-2-2026-09-08.md。

## 最新：截图确认16连接；首个实际模拟事件已创建但请求过期

- 用户16截图21:08显示已登录/服务已连接/附近人数暂不可用。服务器查证16
  13:08:28Z刷新账号、13:08:29Z新设备会话、13:08:30Z位置入库，证明此前
  “无新请求”的状态已恢复。附近人数不可用是独立问题，不能说16一直断网。
- 已按用户批准方向创建17患者/16响应者的SIMULATED_TEST事件：
  REDACTED-ID-77cb6ef20beae373，管理工具成功、非replay。
  清单/tmp/aedresponse-simulation-support.C8agIa/run-2.json（requestedAt13:09:52Z）。
  实际停服/创建/恢复在13:10:10Z，备份before-simulation-run-2-20260908.sqlite。
- 请求46bf3bf5-4ed4-44da-8da1-c78a11752012截止13:10:40.291Z，最终EXPIRED，
  decision=null，无送达/查看/接受回执，无assignment。**不能声称端到端传递通过**。
- 17实测此前所有业务请求cellular=true；重启后13:10:11Z发bootstrap，后续日志
  暂无完成响应。16服务端lastSeen仍13:08:30；服务器13:11:43health正常。
  不能单凭缺回执判为16网络或分配算法错误；停服重连与30秒offer时窗需排查。
- 已异步请用户在16行动页接受/若无请求发截图，尚等反馈。不重复造事件。
  当前事件可能仍ACTIVE，不能再开下一轮或回滚到旧解析器，先核对/正常结束。

## 最新实测：17真实蜂窝通过，16收端尚未恢复业务证据

- 用户已确认两台设置内关闭Wi-Fi、开蜂窝、16App前台。17 USB wired。
- 17真实联网build/install完成；diag /tmp/aedresponse-17-cellular-live.log，
  console session8381。13:01:36Z路径cellular=true/wifi=false；真实URLSession
  BUSINESS_TASK_NETWORK记录refresh200、bootstrap201、events200、R/presence200，
  均cellular=true、proxy=false、fetchType=1，收到SERVER_READY_RECEIVED。
  这不是仅看蜂窝开关，也不是隔离探针。17→公网服务器收发已证实。
- 16在13:02:06Z查询仍lastSeenAt=12:54:08.525Z，没有本轮新请求证据。
  不把Xcode unavailable等同业务离线；也不把用户说前台直接当收端通过。
- 已异步请用户发16当前界面/连接状态截图，Wi-Fi保持关闭，等待具体状态。
  没有发模拟事件，发送端改17/收端16的方向已确定，不复用旧清单。
- 16上本轮已安装真实联网构建（不再跑离线宿主）。SIM-01权限此前已修，
  错误残留修复通过225项真机回归；本轮不再以离线宿主覆盖任何手机。

## 最新切换：17 Pro USB发送端，16蜂窝接收端

- 用户要求改用17进行“use控制”，已明确按USB理解并现场确认17 transport=wired。
- 当前方向17 Pro→公网服务器→16；仍禁止把Wi-Fi业务计作通过，只使用真实联网构建。
- 16真实联网版已安装成功，bundle路径1DB89871-A0A5-4728-8F6A-CFBCA1C2A57E/
  AEDResponseControlledTests.app。16随后不连Xcode（unavailable），不能等同断开业务网络。
- 正在用原17兼容编译条件构建蜂窝metrics观测版本，日志/tmp/aedresponse-17-cellular-build.log，
  DerivedData=/tmp/aedresponse-simulation-support.C8agIa/iphone17-build。不运行离线宿主测试。
- 已异步请用户两机在设置关闭Wi-Fi、开蜂窝，16App前台，完成回复“好了”。未确认前
  不新发业务测试请求；安装走USB可继续。模拟角色若继续事件应改17患者/16响应者，
  不可复用此前16患者的清单；目前仍未创建事件。
- 下一步17真实业务URLSession metrics需cellular=true并匹配响应，16看服务器回执/
  UI接收；不把普通网络路径快照或server健康单独当双机任务验收。

## 最新范围：仅16真实联网构建，业务必须蜂窝；等待USB准备

- 用户已允许修复当前阻塞；SIM-01已改为root:aedresponse0640，服务账号
  node --check通过，服务持续active，未触发事件。
- 已实现连接恢复只清除自身旧错误、保留较新业务错误（含相同文案）；新增2测试。
  先前已启动的真机回归225项：209通过16跳过0失败。用户随后明确禁止再用
  离线宿主覆盖手机，因此后续只build/install AEDResponseControlledTests，不运行该宿主。
- 当前只测试16接收服务器信息，不测任务、不触发事件、不更新17。业务必须
  蜂窝；Wi-Fi只能供Xcode控制。查16实际仍localNetwork调试，已异步请用户接USB。
- 已检查发现16留有离线TestHost（上次被中断前回归安装），正在构建真实联网版
  装回。不能把离线宿主的界面或测试结果当服务器通信。
- APIClient新增DEBUG+CONTROLLED_TEST限定的真实URLSession task metrics记录，
  phase BUSINESS_TASK_NETWORK含requestId/cellular/fetchType/status，和CLIENT_RECEIVE
  对账；不增加探针、不改路由、不打印令牌。SDK本地头文件确认isCellular支持。
- 构建日志/tmp/aedresponse-16-cellular-build.log；设备状态/tmp/aedresponse-16-cellular-device.json。
  USB确认后要求设置中关闭Wi-Fi，启动真实联网App，验证cellular=true的实际响应
  及system:ready；不得将Wi-Fi请求当作通过。尚未获得本轮蜂窝成功证据。

## 最新：用户指出16网络问题；已只读确认失败后恢复

- 16在20:50:00 bootstrap失败-1005，随后20:50:04 bootstrap201、20:50:06
  Socket ready、位置/状态200，服务器最新R入库匹配。不能描述成没有网络错误，
  也不能把此前失败等同于持续断网。与20:49:49短暂停服时间相关但根因未证明。
- connect失败写lastError，成功/connected没有直接清除，可能仍显示旧弹窗；
  未查看屏幕，因此只是代码推断，未修复。详见docs/iphone16-network-observation-2026-09-08.md。
- 用户“好继续”承接网络检查，不擅自当作允许chmod修SIM-01。模拟任务仍未开始。

## 最新：首轮模拟被SIM-01测试工具权限阻塞，按要求未修复

- 用户“准备好了”后尝试runId=REDACTED-ID-c41b3ba6720acbcc，
  requestedAt=2026-09-08T12:49:25.000Z。备份完成、清单送达、停服后执行管理工具。
- Node读脚本EACCES，createSimulatedEvent未执行。实际脚本root:root0600，
  运行用户aedresponse；上级目录可遍历。是助手上一轮umask077/root复制脚本
  后未核对服务账号可读性的部署错误，不是用户权限或分配算法问题。
- 遵守只记录不修：没有chmod/chown/root绕过或重试。恢复trap成功；20:50:13
  health ok、服务active、SQLite完整性ok，events/deliveries/assignments均0。
- 详见docs/simulation-run-1-2026-09-08.md；等待用户允许仅修SIM-01后再测。
  旧清单过期，重试用新runId和requestedAt，不覆盖失败尝试/备份；其余bug不修。

## 最新：模拟支持已部署，等待用户准备操作后触发首轮

- 用户“允许”批准具体测试支持与部署。实现、证据见docs/simulation-support-validation-2026-09-08.md。
- 后端SIMULATED_TEST独立观察/不可改写绑定、两用户设备白名单、管理方法和
  默认关闭的本机CLI已实现；公开server/main不变，没有伪造Watch字段。
- 隔离候选取自线上原114测试基线，Azure115/115；主工作区122/122。
  原Apple challenge及服务端定位分层改动没有带上线，COMM-01仍未修。
- 两机测试支持包已安装。17用DEBUG AED_CONTROLLED_TEST AED_LEGACY_LATEST_POSITION_CADENCE
  保留旧最新值队列无门控行为（诊断true）；16兼容开关false。不是修COMM-02。
  正式/Release无法启用该分支。新模拟标记及契约2测试加入，16真机223项：
  207通过16跳过0失败。没有卸载/复制账号/更改权限协议。
- 20:45:42服务器更新并恢复，两机自动Socket重连ready；health和SQLite完整性正常。
  候选/备份分别/opt/aedresponse/releases/simulation-support-20260908、
  /opt/aedresponse/releases/before-simulation-support-20260908；DB备份
  /var/lib/aedresponse/backups/before-simulation-support-20260908.sqlite。
- **没有创建模拟事件**，仍2用户/2设备、0事件/任务。已异步询问用户是否准备
  解锁保持前台并在17点击接受；等待其准备确认，不再问测试范围/部署授权。
- 触发时使用现有16/17用户设备ID（前段记录），生成新UUID runId、新requestedAt，
  管理清单必须在30秒内使用。停止服务再用systemd-run的既有env，以服务账号
  运行deploy/azure/create-simulated-event.mjs，显式AED_ENABLE_SIMULATED_EVENTS=true。
  正常服务不需要此变量，不能为方便增公开入口或直接写SQLite。一次只运行一个事件。
- 模拟记录出现后不能直接回旧解析器或恢复旧库删后续证据。业务bug只记不修。
- 本地候选/tmp/aedresponse-simulation-support.C8agIa；live日志含精确位置不外发。
  16日志iphone-16-live.log（console session32735），17日志iphone-17pro-live.log
  （session51150）。可继续读取阶段/状态，不输出精确位置。Release iOS+Watch
  未签名编译通过，不代表真实特殊能力验收。

## 最新：双机场景已批准，测试入口的具体改动待确认

- 用户“同意”批准既定基础双机场景。两机connected、服务器active。
- 只读检查确认线上事件入口只接Watch观察，模型强制Fall observation，没有
  独立模拟来源/标记。不能用脚本伪造Watch后声称满足方案。
- 按已批准方案第4条，已在docs/two-phone-simulation-plan-2026-09-08.md
  列出具体新增测试支持：独立模拟来源/白名单、仅管理驱动、手机标记及契约、
  隔离补丁的备份部署。涉及安装/部署/持久化表示，等待这组具体改动确认。
- 当前仅改文档，未生成事件/修改业务代码/修bug/部署。尤其不能全量发布本地
  脏工作区而顺带修掉COMM-01/02。正式测试范围不再需要重新询问。

## 最新：16独立身份已准备，模拟事件仍待方案批准（2026-09-08 20:31）

- 用户“是”批准16身份准备和拟定模拟方案。已一致性备份、停服使用原管理
  脚本创建独立受控账号并立即恢复；未更新代码/配置/数据库结构或修复bug。
- 16 userId=REDACTED-ID-7736feeccab306b2，deviceId=REDACTED-ID-11d1af8b4a528811。
  Keychain导入、refresh200、bootstrap201、Socket ready及R写入回执均成功。
  17原有users/accounts与备份相比变化0，持续正常R上传。现有2用户/2设备。
- 16初始协议门禁false，后续正常bootstrap；没有替用户签协议。手机一次性
  导入文件已自动移除，Mac/VM副本已删除，Keychain有效凭据保留，不再复用旧文件。
- 备份服务器/var/lib/aedresponse/backups/before-iphone16-identity-20260908.sqlite。
  日志/tmp/aedresponse-iphone16-identity.BS6JxS/iphone16.log含真实位置，不公开。
- docs/two-phone-simulation-plan-2026-09-08.md为待批准方案，尚未创建模拟事件。
  需明确模拟标记、仅两账号白名单、非公开管理入口；不伪造系统Fall/AppAttest、
  不拨打急救电话。原bug保持不修。两机仅一响应者，不能冒称多人AED/补位验收。

## 最新：双机通信检查，用户要求只记录不修复（2026-09-08 20:27）

- 本轮仅现有安装与服务器验证，严禁将先前开发授权解释为可修复当前发现。
- 17 Pro refresh200/bootstrap201/Socket连接/真实R上传和前5条持久回执匹配。
  16公网Apple challenge收到401，但无有效身份、无业务会话。两台均Wi-Fi，
  不是蜂窝验收。服务器仅1用户/1设备，0事件/0请求/0任务，分配尚未可测。
- 已登记未修复：COMM-01，16新客户端challenge路由与旧后端不匹配；COMM-02，
  17旧安装包22秒5条待命更新、距首点最多0.012米，过频问题重现，不是新版回归。
- 未部署/安装/修码/改配置/签发账号/伪造事件；仅报告和本交接变化。两台App
  诊断结束后正常重新启动；16独立身份和安全模拟事件方案需确认后再推进。
- 详见docs/two-phone-communication-audit-2026-09-08.md。原日志
  /tmp/aedresponse-two-phone-audit.LfIqOg含精确位置，不公开整份。

## 最新授权：补齐正式流程并保留测试开关（2026-09-08，开发进行中）

- 用户明确恢复所有正式流程开发，保留测试代码并用代码控制，当前开启，
  17 Pro/16 可用。旧“真实登录代码暂停”不再限制本批本地实现。
- 短信服务尚未开通；用户随后说明会员已开通、相关注册申请待审核。不能
  把这解释为 Fall entitlement 已获批，不代付或代申请。
- 清单为 docs/formal-flow-progress-2026-09-08.md。当前先正式登录/测试开关、
  Apple验签与nonce、定位分层，然后继续其余缺口；不得称“所有流程已完成”。
- AED_ENABLE_TEST_FEATURES 当前测试Debug开启，AuthView不再被等待页替代，
  受控Store兼容正式身份且不让导入覆盖正式账号。相关真机单元测试通过。
- 新 backend/src/apple-auth.ts 提供固定Apple JWKS、RS256签名及claims验证、
  五分钟服务端nonce挑战与一次消费，503密钥故障与401凭据拒绝分开；新增
  /auth/apple/challenges 路由及 main 的显式client-ID配置。6项本地RSA/HTTP
  测试与typecheck通过；客户端已接入挑战准备、SHA256 nonce和state校验，
  失败可重新准备。真实Apple授权码交换/撤销同步仍待配置；未部署到Azure。
- 最新值R的120秒/100米、搜索圈15秒/30米门控已实现，实际回调驱动，
  待处理回调在ACK后再次检查，重试保持幂等标识；事件秒槽独立不变。
  后端R ACK可选positioningTier为实时调度信息，重放时重新计算；圈内拒绝/
  offer过期不直接降为待命，离圈降级。新版服务未发布，公网频率尚未复验。
- 最新后端121/121及check通过，日志/tmp/aedresponse-formal-cadence-backend-20260908.log。
  16解锁后221项真机单元测试：205通过、16跳过、0失败；日志
  /tmp/aedresponse-formal-regression-iphone16-20260908.log。11项源码检查、5项
  公网诊断跳过；不是真实Apple/SMS/Watch/后台验收。导入测试ISO时间精度
  断言已修复。之后只补了AuthView关闭测试时隐藏/忽略地址覆盖、失败重试。
- 后续联网Debug签名构建与codesign校验通过；iOS+内嵌Watch Release未签名
  编译通过；另构建测试开关NO的联网Debug通过。实际Info总开关分别YES/NO/NO。
  20:22:58已把YES联网版装回16并无debugger启动，回读PID10822仍在；没有卸载、
  新建账号、复制17凭据或更新17。证据/tmp/aedresponse-formal-{install,launch,processes}-iphone16-20260908.json。
- 本批阶段结束，全部正式流程尚未完成。下一阶段按清单处理短信供应商与Apple
  实际配置/申请、Watch AppAttest等缺口，外部发布与数据库变更先确认；不要把
  本地合成验证或编译写成供应商/公网/后台/Watch真机验收。测试开关关闭的产物
  只做编译未安装，当前16上保留开启的联网测试版；服务器仍旧代码。
- 后端修改前114/114通过。不能为继续开发移除真实身份门禁、伪造Watch事件、
  复制17的凭据到16、购买服务或直接修改生产数据库。管理后台图仍待UI审核。

## 最新：Xcode Run 签名修复；16 已安装启动，登录方案待确认（2026-09-08 17:20）

- 用户截图指 Xcode Run，图中的 AEDResponse/codex/ios-mvp 实为项目/分支
  控件；实际 active scheme=AEDResponseControlledTests、destination=iPhone16。
  16:57 的 D5C1EE65 构建日志明确报 requires a development team，不是此目标
  缺 Apple/Watch 特殊权限。不要再把此按钮故障归因于必须购买年费账号。
- 用户随后明确“16连接了”，本轮仅用 16 验证构建、安装与打开 App，不做
  双机事件或救助业务测试；17 Pro 仍 unavailable。
- 修复：ControlledTests 在 canonical project.yml 引用 Config/Signing.xcconfig，
  可选包含被 Git 忽略的 Signing.local.xcconfig。本机文件填入已验证的
  Team GR6YBCDW7R；另有不含个人 Team 的 example。正式 targets/entitlements、
  bundle ID、身份逻辑和后端不变。生成工程不会丢失本机 Team 配置。
- 不传任何 DEVELOPMENT_TEAM 命令行覆盖，showBuildSettings 已解析正确 Team；
  同一 Xcode DerivedData 的物理 16 destination 签名 build 成功，codesign
  --verify --deep --strict 通过。17:16:59 起安装成功，17:19:17 无 debugger/
  start-stopped/诊断环境启动成功（PID 8801）。没有运行 XCTest/UITests。
  GUI 自动化接口未成功触发 Run，因此不把 CLI 构建/安装写成自动点击通过。
- 证据：/tmp/aedresponse-xcode-run-iphone16-20260908.log、
  /tmp/aedresponse-iphone16-runfix-install-20260908.json、
  /tmp/aedresponse-iphone16-runfix-launch-20260908.json。
- 用户看到“等待受控测试账号”后指出这不是其产品需求。该文案来自
  AuthView 的 AED_CONTROLLED_TEST && DEBUG 分支；这个构建不显示真实
  手机号/Apple 登录。受控账号仅为此前暂停真实登录后的联调例外，不是正式
  产品需求。尚未为 16 创建/导入账号，不得擅自继续签发或绕过登录。
- 真实手机号/SMS 与 Apple provider、Watch 特殊能力仍暂停。若用户要求 16
  直接按正式登录进入，需要先确认恢复相关开发/配置；不能仅删除等待页而
  假称真实登录已完成，也不能把“安装启动通过”写成“登录和业务通过”。
- 用户同时询问 Apple 年费：正式使用 Sign in with Apple 及本 App 接收系统
  跌倒通知需匹配的正式开发者会员/团队与 capabilities；Fall Detection 还需
  单独申请 entitlement，付费不等于获批，不会让号码/短信等未开放 API 可用。
  本轮没有申请/购买会员、更改证书或恢复这些功能开发。

## 最新：只读管理后台 UI 概念稿，等待批准（2026-09-08）

- 用户要求“搞一个只读管理后台，先渲染 UI，批准后再开发”。本轮仅生成
  4 张静态 Image Gen 效果图：运行总览、设备与定位、事件与任务、AED 资源。
  文件和设计边界位于 `docs/design/read-only-admin-v1/README.md`。
- 图片全部为虚构示例，顶部明确“界面预览 · 示例数据 · 未连接服务器”；
  不是已经部署的网页，也不是新一轮真实业务验收。未连接服务器或手机。
- 仅有搜索、筛选、刷新和查看设计；没有编辑、删除、导出、派单、结束事件
  或重启服务。不显示手机号、Apple subject、精确经纬度、轨迹或交接照片。
- 所有页面均已逐张视觉检查：中文、导航、表格、匿名样例、无敏感字段和
  写操作；没有运行浏览器或交互测试，因为尚未获准实现页面。
- 现有 operatorProjection 不含全部拟展示字段。后续需独立鉴权、服务端
  只读权限、字段白名单和访问审计，不能把现有可写 operator token 暴露给
  前端。不得把设计批准解释为放宽现有隐私投影或允许数据库裸露公网。
- 仅新增设计图片/说明并更新本交接；未修改客户端/后端业务代码、数据库、
  环境或部署。等待用户审核 UI 后再开发；16/双机实测仍等用户连接后安排。

## 最新：自动连接已修复并实机入库（2026-09-08 15:54）

- 用户“马上搞好”授权修复连接缺口，范围仍仅 17 Pro，不涉及 16/新功能/特殊
  Apple 或 Watch 权限。15:39 权限快照已证实 Always、精确定位、通知、后台
  刷新、蜂窝均开启，NWPath satisfied/cellular=true、wifi=false。不要再要求
  重签协议或声称是用户网络权限没开。
- AppEnvironment.automaticallyConnectOnReady 仅正常联网构建启用；AppStore
  在全部原门禁通过后自动调用现有 connect，串行防重复、初次失败退避重试，
  注销/撤权取消任务；LiveSession 在 bootstrap 返回后检查 Task 取消，阻断
  迟到结果重新开 Socket。未改服务端、数据库、系统开关或证书。
- 新 6 项自动连接测试 + Keychain 回归在 17 Pro 7/7 通过；全量 iPhone 单元
  测试 209 项：193 通过、16 跳过、0 失败（11 源码检查、5 独立公网诊断未开启）。
  新 AEDResponseUnitTests scheme 避开无关 UI Runner profile 不含该设备的
  阻塞，没有更新 profiles；canonical project.yml 已生成。Release 未签名
  编译通过，ControlledTests 已重新真实签名安装。
- 15:50:46 实际自动 bootstrap HTTP 201、SOCKET_CONNECTED，15:50:47 收到
  system:ready；随后 Core Location 真实 R 经原公网 REST 上传并持久化。
  同一 userId=REDACTED-ID-4b0f37dea05bc146，deviceId=
  REDACTED-ID-7a84f23aad91cf92，仍为 NEUTRAL，不是患者/响应者事件流。
- 4 分钟观察（15:50:43–15:54:43）217 个唯一持久化回执全部匹配客户端发送和
  ACK；216 个可观察最新坐标快照逐字段一致。HTTP 均 200，0 请求失败、0
  重复/过期，1 次 Socket 连接、0 断开。首条接收15:50:47.538、末条15:54:42.172。
  平均间隔1.0863秒，最大11.72秒；长间隔均在启动前23秒，新fix时间同步推迟。
  后213条平均1.0013秒、最大1.121秒。不要称为严格每秒新定位已通过。
- 新发现待修复偏差：docs/requirements.md 冻结普通待命 R 为120秒或100米，
  实际 latest-only 通路仍近1Hz、没有 cadence 控制；本轮只修连接，未改频率。
  必须向用户明确传输接通不等于全部定位需求合规。搜索圈另为15秒或30米，
  事件参与者仍为严格秒槽/5秒批次，后续不得混改这三种分级。
- 证据目录仍 /tmp/aedresponse-17pro-validation.8BaVWL：autoconnect-live.log、
  autoconnect-server.jsonl、autoconnect-summary.json。观察 session41960 已完成，
  手机 console session41076 仍在接收输出，App 保持正常运行。目录含精确位置
  与已撤销旧凭据副本，禁止公开整体目录/输出token；不要重复创建用户。
- SERVER_INTEGRATION_TEST_REPORT.md 已更新最新矩阵：前台蜂窝R传输通过、
  待命频率FAIL；PatientP/任务/后台/锁屏/真实切网/16/Watch/APNs仍未验收。
  本轮不 commit/push。下一步先修待命/搜索圈 cadence，再做相应实机分级验收。

## 最新只读检查（2026-09-08 15:31，用户要求先核对已开权限）

- 用户说 Tests 的网络等设置应已开启。本轮不改系统权限，不代签，不修复业务
  流程；仅读取手机容器/服务端/源码，并补充现有 opt-in Debug 权限快照。
- 14:45 实读当前受控账号 preferences：四项协议在 14:27:43.352 CST 已全部
  确认 v2.0。之前以“无业务请求”推断待确认不准确，已向用户更正并更新报告。
  不要再让用户重复签署。
- 确认结构缺陷：App 内没有 AppStore.connect(baseURL:) 调用者，只有 XCTest
  显式调用；身份恢复/权限激活没有建立设备会话，Settings 的 Ping 也不连接
  业务。这足以阻断 bootstrap/Socket/位置，与服务器仅账号会话的现状一致。
  此缺口本轮尚未修复，不要将其归因于用户关闭网络。
- App 已真实 HTTPS 200，但当前系统定位/通知/后台刷新/蜂窝限制的逐项实值
  尚未拿到。只读 LLDB 查询未返回有效结果，已结束该诊断会话；不能伪称权限
  关闭或全部已确认。随后手机断连，15:31 CoreDevice=unavailable，最后连接
  约 14:50；开发连线状态不等于手机业务网络状态。
- IntegrationDiagnostics 新增 recordPermissionsOnce（只读 public API，无
  requestAuthorization），双开关 AED_VALIDATION_LOGGING=1 与
  AED_PERMISSION_SNAPSHOT=1；仅 controlled Debug 存在。generic iOS 签名
  构建通过，未安装到当前离线手机。没有修改证书、系统设置或业务数据库。
- 证据：/tmp/aedresponse-17pro-validation.8BaVWL/current-preferences-1444.plist，
  permission-check-device-state.json；不能输出整个 prefs 或凭据。
  只读观察 session 56003 已结束，600 秒 deviceCount=0/receiptCount=0。
- SERVER_INTEGRATION_TEST_REPORT.md 已加入此更正和新问题。后续先读最新内容，
  不重复建账号，不重发已轮换的旧 refresh token，不恢复 16/Watch 范围。

## 当前实机验收批次：仅 iPhone 17 Pro（2026-09-08 14:25，进行中）

- 用户提供持续通信/业务 E2E 验收清单，最新只测 17 Pro，16 不处理；不新增功能/
  大重构，仅已证实 bug 最小修复。需生成 SERVER_INTEGRATION_TEST_REPORT.md。
- 14:08 17 Pro 已 wired connected、解锁、Developer Mode enabled，iOS 27.0 /
  24A5430a。证书指纹、profile 与 9 月 6 日成功包完全相同；正确 Team 是
  GR6YBCDW7R，不是证书 CN 后缀 H463W287GN。14:09 明确 Team 的签名构建成功，
  14:10 新 ControlledTests 2.0/3 已真实安装；未更改钥匙串、证书或特殊权限。
- GUI 工程 Team 仍未持久配置，直接 GUI build 报 missing team；本轮 CLI 明确
  传入正确 Team 可成功。此前 errSecInternalComponent 的暂时性根因仍未证实，
  不得谎称因换证书/解锁钥匙串修复。
- 14:13 原业务 SQLite 创建唯一受控账号 iphone17pro：userId
  REDACTED-ID-4b0f37dea05bc146，accountId
  REDACTED-ID-8b01030fef69fd88。已安装 controlled-test.conf，开关 true。
  CLI 在业务服务停止时由 aedresponse 用户运行，随后正常重启；旧库备份
  /var/lib/aedresponse/backups/before-iphone17pro-account-20260908-1413.sqlite。
- 14:22 真机证实 KeychainAuthSessionStore.save 错把含 kSecClass 的查询字典
  用作 SecItemUpdate 的 attributesToUpdate，返回 -25303。仅修正 update/add
  参数；保护级别不变。14:24 同台重跑 KEYCHAIN_ADD=0、导入成功、真实 Azure
  POST /api/v2/auth/session/refresh HTTP 200（773 ms），刷新会话 KEYCHAIN_UPDATE=0。
  手机导入凭据副本已自动移除，未删业务数据。
- 新增 opt-in IntegrationDiagnostics（AED_CONTROLLED_TEST && DEBUG 且
  AED_VALIDATION_LOGGING=1）：只记白名单请求元数据/状态码、Keychain 状态、
  Socket/Lifecycle/位置 ACK。没有 token、HTTP body 或请求 headers 日志。
- 14:25 已请用户在手机自行确认四项协议及通知/Always+精确定位；尚未收到完成
  回复。不能代签协议。此时还不能报真实位置持续上传通过。
- 证据目录 /tmp/aedresponse-17pro-validation.8BaVWL；client-diagnostic.log 为
  修复前，client-fixed.log 为修复后。当前 App console exec session 21168。
  密钥文件 controlled-session.json 仅 0600，严禁输出其内容；服务器副本亦 0600。
  后续可用同目录 observe-position.mjs 只读观察同一 SQLite，不得并发写入。
- 患者 P 仍需合法 Watch 触发与服务端事件；不可在 17 Pro 手动创建或伪造事件。
  双机/16/Watch/APNs/真实 Apple-SMS 登录未由本批验收。
- 已生成根目录 SERVER_INTEGRATION_TEST_REPORT.md，包含实际架构、签名对照、
  修复前后真机证据、会话轮换记录和逐项验收矩阵。位置/Socket/后台/双机等
  未测项均为 NOT TESTED，不得把账号刷新 200 当成持续位置通过。
- 新 Keychain create/update XCTest 的 generic build-for-testing 已通过，未
  单独运行 XCTest；真实 App 路径的新建与刷新保存已通过。git diff --check 通过。
- 只读观察 exec session 56003 自 14:28 开始，最多 600 秒，输出同目录
  server-observation.jsonl；截至 14:35 仍无 device/position。下一步先确认用户
  已完成手机首次使用门禁，再读现有 console/观察文件；不要重建账号或重发旧
  refresh token（首次导入副本已被正常轮换撤销）。

## 最新：受控账号例外已批准，正式位置链路实施中（2026-09-08）

- 用户回复“对，就是这样”，同意仅受控账号替代首次登录，其他鉴权/协议/定位/
  设备绑定/业务接口/同一 Azure SQLite 数据库按既定规则运行。不另建临时位置
  服务或隔离业务库、不删数据。下方“身份前置待确认”已被本次批准取代。
- 真实 Apple/SMS 登录及 Apple/Watch 特殊权限工作仍暂停，不改证书/钥匙串 ACL。
  常规 iPhone 无特殊能力包的签名、安装和真实位置测试在当前范围内。
- 新增后端 CONTROLLED_TEST provider、默认关闭开关、本地管理签发脚本；没有
  公共测试登录接口。新增 AEDResponseControlledTests Debug scheme，复用正式
  手机代码，仅受控文件导入 Keychain 作为首次会话来源。普通构建拒绝该身份。
- 本机和 Azure 完整 114/114 后端测试、check/build 通过（纯业务 76/76）。
  ControlledTests generic iOS、普通 Tests/UITests build-for-testing、生产
  Release 未签名编译通过；新增 XCTest 仅编译，未运行，不是实机验收。
- 13:16 CST 新后端部署到原 /opt/aedresponse/current；旧代码保留在
  /opt/aedresponse/releases/before-controlled-20260908-1315，库备份为
  /var/lib/aedresponse/backups/before-controlled-20260908-1315.sqlite。
  SHA-256、SQLite、HTTPS health、匿名 REST/WSS 拒绝及 JSON 边界通过。
  本轮没有修改原环境/证书/数据库表，没有删除数据。
- 受控账号开关仍为 false，未安装 opt-in drop-in，也未签发线上受控账号。
  业务库仍仅有原有 2 个 AED；先恢复手机签名/安装，再启用、签发并导入凭据。
  没有实际位置入库，不能以自动化合成坐标或旧 echo 诊断替代。
- 普通 Tests 包签名仍报 errSecInternalComponent（不含特殊 entitlement）；
  当前 Xcode GUI 因 Mac 锁屏暂停，已请用户解锁；13:15 左右 iPhone 17 Pro
  也变为 unavailable。不得放宽私钥 ACL 或假称安装通过。
- 完整边界、部署顺序、改动点及证据见 docs/controlled-account-position-validation-2026-09-08.md。

## 最新验收要求：复用正式业务链路（2026-09-08，身份前置待确认）

- 用户拒绝另建临时定位测试通道或隔离业务库，要求直接使用现有 App/正式业务接口、处理规则及数据库，按之前需求验收。测试数据由用户在上线时决定清理；现在不执行删除。
- 之前“登录及 Personal Team 相关工作暂停”仍未明确解除。正式接口要求有效身份会话，当前没有真实登录 provider、用户或会话，且生产签名存在已确认的 capability 门槛。
- 不得自行把“测试期”解释为关闭认证、接受任意身份或改用回显接口。待确认是否允许仅用受控测试账号建立会话、其余全部走正式规则；如身份建立也必须完全与上架版一致，就需要先恢复真实登录及匹配签名能力。
- 本轮仅核对代码/既有实测记录，没有创建测试账号、签发会话、改变权限或上传真实位置。

## 最新范围修订：登录及 Personal Team 能力工作暂停（2026-09-08）

- 用户最新要求“登录先不用，涉及到 personal team 权限的都不要先做”。真实 Apple/SMS 登录适配、Apple/Watch capability 与签名工作暂停，不更改钥匙串、证书、entitlement，不再尝试 provisioning 更新。
- 本次暂停前只读取了认证源码及 Apple 官方文档，并复查签名：Personal Team 明确不支持 Sign In with Apple / Fall Detection Notifications。没有新增认证实现、登录 challenge、数据库结构或安装绕过能力的 App。
- 仅继续此前获准、不依赖这些能力的客户端 Azure 地址配置：生产 `ios/project.yml` 指向已部署的 HTTPS `/api/v2/`。TestHost 的离线限制、fake auth 隔离与生产真实身份门禁不变。
- `xcodegen generate` 已同步配置；`AEDResponse` Release generic iOS 构建在 `CODE_SIGNING_ALLOWED=NO` 下通过（`/tmp/aedresponse-azure-url-20260908.log`），`git diff --check` 通过。没有签名、安装或启动新 App；这只是编译验证，不是位置传输验收。
- 正式“App 当前位置→业务数据库”仍因缺少真实会话而未完成。若用户希望先验证位置传输，只能另行确认独立诊断范围（临时凭据、单独位置记录、与业务库隔离），不能把这种诊断称为正式业务链路通过；当前尚未创建或运行该诊断。

## 当前位置上传核对（2026-09-08 12:30，尚未打通业务）

- 用户要求查看 App 能否将当前位置传到新服务器并记录。本轮仅核对该链路，没有开发登录适配器、更改服务配置或绕过认证，也未发送真实坐标。
- 实时检查 Azure `aedresponse` 与 `caddy` 均 active；公网 HTTPS `/healthz` 为 200。无 bearer 的 `PUT /api/v2/me/responder-position` 为 401；仅使用明确无效诊断字符串请求 Apple 登录，返回 503：`APPLE authentication is not configured on this backend`，未创建账号或会话。
- 远端运行入口为 `/opt/node/bin/node --max-old-space-size=256 dist/src/main.js`，实际源/产物仍只调用 `createBackend({ config })`，未注入真实身份验证器。只读 SQLite 核对：`state_items` 仅有 2 个 AED；users/accounts/devices/sessionsByTokenHash、positionUpdateReceiptsById、eventPositionBatchesById 均 0，最新位置为 null。没有读出或打印密钥、token 或个人坐标。
- iPhone 17 Pro 已连接且解锁；实时安装清单只有 `dev.codex.aedresponse.testhost`（AEDResponse Tests 2.0/2），没有 `dev.codex.aedresponse` 生产 App。当前 TestHost 业务 `allowsLiveNetworking=false`；生产 `ios/project.yml` 中 `AEDResponseServiceBaseURL` 仍为空。
- 结论：服务器可达不等于真实位置写入可用；需先补齐真实身份会话、生产服务地址及可安装的客户端，再从真实 iPhone 发送样本并核对数据库。此前 native-cellular 诊断为合成 payload 回传，不是当前位置写入业务数据库。不得用测试身份或临时回显入口宣称位置业务已验收。

## 最新：原生蜂窝传输（2026-09-08，批量复测进行中）

- 用户明确不要 Safari，要 iPhone 蜂窝数据。Wi-Fi（17 Pro）/USB（16）仅为开发调试链路，业务诊断必须 `requiredInterfaceType=cellular`，同时核对每条实际 `NWPath`；不使用 Tailscale 或 Mac 转发业务数据。
- Safari 临时入口已关闭、原临时服务已停止，浏览器数据不计验收。没有更改钥匙串、开发证书或 Apple/Watch entitlement；通过 LLDB 在已签名的 `dev.codex.aedresponse.testhost` 内执行独立 Network.framework 诊断，未绕过业务登录。
- 真机已通过：16 起初报告 `Denied over cellular interface`，用户开启网络服务后，LTE `cellular=true,wifi=false`、HTTPS health 200；17 Pro 为 `pdp_ip0[nr_sa_sub6]`、同样 cellular-only + health 200。证据在 `backend/logs/azure-20260908/cellular-health-iphone{16,17pro}.json`。
- 初次上传批次：两台各有 1 包 576 字节完成蜂窝上传、Azure 原样回传、手机内容一致校验；两端 receiptID / sequence / bytes / SHA-256 一致。不能报 20 包全过。前台重新激活后才执行超时回调；已为复测加入活跃状态启动与测试期间临时保持亮屏，结束恢复原值。
- 诊断代码：`ios/scripts/cellular-health-probe.mm`、`cellular-health-lldb.mjs`、`cellular-upload-probe.mm`；服务端 `backend/deploy/azure/native-cellular-probe.mjs` 无网页、无真实位置、无业务数据库，独立短期 token、16 KiB 限制，监听 loopback 8788。
- 当前临时复测服务为 `aedresponse-native-cellular-retest`、runId=`20260908-native-1131`，Caddy 精确路径 `/__native-cellular/20260908-native-1131/*`。30 分钟自动停止；收尾必须关闭入口并停止服务。先核对 `/etc/caddy/Caddyfile` 与 `/home/REDACTED/aed-native-cellular-Caddyfile-1131` 一致，再恢复 `/etc/caddy/Caddyfile.before-native-cellular-20260908`、reload，验证原业务 health 与临时路径 404。不得把上一个临时 Caddyfile 当成原始基线。
- 这批只证明原生蜂窝 HTTPS transport；完整业务登录、事件/位置、WSS 业务、Apple 登录、物理 Watch 均未由此验收。短信继续不进行。

## 双机指定链路测试与认证检查（2026-09-08，私钥签名操作授权失败）

- 最新用户要求：iPhone 17 Pro 用 Wi-Fi，iPhone 16 用 USB；开始测试；短信服务暂不进行；说明 Watch 验证器接入方式并检查 Apple 登录是否符合要求。
- CoreDevice 已实时证明 17 Pro transport=localNetwork、16 transport=wired，两者 tunnel connected / Developer Mode enabled。16 起初锁屏，用户回复“已解锁”，复查 passcodeRequired=false。
- 完整 production scheme 实际签名构建失败：当前 Personal Team 不支持 iPhone `Sign In with Apple` 与 Watch `Fall Detection Notifications`。没有移除 capability 来绕过。日志 `/tmp/aedresponse-azure-production-signing-20260908.log`。
- 新增 opt-in `ios/AEDResponseTests/LiveAzureTransportTests.swift` 五项真机传输诊断（原始 ServerConnectionProbe/APIClient、REST 401/Apple 503、16 KiB边界、WSS握手/认证拒绝）。默认未设置 AED_LIVE_TEST_ORIGIN 时跳过，不改变 TestHost 的离线 fake auth 或线上认证。不触及短信或实际位置。
- XcodeGen 已生成工程。诊断包签名返回 `errSecInternalComponent`。更正此前“钥匙串锁住”判断：Security API 已实测 flags=7 / unlocked=true，现有身份的私钥引用可正常取得；Xcode Manage Certificates 显示现有 Apple Development 证书且无缺失状态。详细日志明确 `CSSMERR_CSP_OPERATION_AUTH_DENIED` / SecKeyCreateSignature 授权失败；具体 ACL/完整性原因尚未确定。不要继续让用户解锁已解锁的钥匙串，不读取或导出私钥、不放宽 key ACL、不删除或重建证书。
- 同一源码 `build-for-testing CODE_SIGNING_ALLOWED=NO` 已通过；5 项新增用例仅编译，尚未安装/运行，不是双机测试通过。DerivedData `/tmp/aedresponse-azure-physical-20260908`，unsigned log `/tmp/aedresponse-azure-physical-compile-20260908.log`，signed failure log `/tmp/aedresponse-azure-physical-build-20260908.log`。
- Apple 审核：客户端已有原生按钮、随机 nonce、SHA256(rawNonce)、Keychain；生产服务地址仍为空；后端 main 未注入 verifier，缺真实验签/一次性 nonce 消费，并需修正 provider 故障与无效 token 的错误分类。Watch 已有 App Attest 客户端和 ticket，但 verifier、公钥/counter 持久化尚无实现。详见 `docs/azure-two-iphone-auth-audit-2026-09-08.md`。
- Xcode production target Team UI 为 None；此前命令行已显式传 GR6YBCDW7R，因此 UI None 与 codesign 私钥拒绝不是同一问题。用户已明确要求直接查看 Xcode，账号/团队/证书/Signing & Capabilities 均已实际查看。
- 下一步先定位实际签名操作授权错误。恢复签名后设置 generated xctestrun 中 AEDResponseTests.EnvironmentVariables.AED_LIVE_TEST_ORIGIN 并按各自 UDID 运行五项用例；分别记录开发连接和业务 NWPath。完整登录/双机业务仍等待具备能力的开发团队、真实 Apple verifier，以及 Watch capability/验证链路。

## Azure 后端部署（2026-09-08）

- 用户已在本任务重新授权“把 Windows 服务器代码转移到 Azure 后进行前后端联通测试”，并要求现在配置 Azure 后端；下面 9 月 5–6 日的网络暂停只记录当时范围。
- 当前 VM 为 `aedresponse-server` / Japan East，公网 IP `[REDACTED-HOST]`。DNS 标签已通过 Azure 门户保存并实测解析：`redacted-host.invalid`。HTTPS base URL 为 `https://redacted-host.invalid/api/v2/`，Socket.IO origin 同域、path `/socket.io/`。
- Windows 9 月 7 日只读比对确认活跃副本落后于 Mac canonical 桌面工作树；部署沿用 Mac 最新副本，没有把旧 Windows 业务数据库转移到 Azure。已上传源码与本机逐文件 SHA-256 一致。
- 初次 `npm ci` 在 Node 24.18.0 下找不到 SQLite 预编译包且缺少 make；9 月 8 日安装官方 build-essential 后，Linux 原生编译、109/109 测试、check、build 全部通过。此前 session 67983 已不存在且远端没有遗留 npm 进程；失败已依据日志确认后恢复。
- 已设置 2 GiB swap；`aedresponse.service` 使用独立不可登录账号、Node 堆 256 MiB / 服务 512 MiB 上限、开机启动与失败重启。`127.0.0.1:8787` 为唯一后端监听；数据在 `/var/lib/aedresponse/state.sqlite`，环境在 `/etc/aedresponse/backend.env`（0600，随机 pepper 不输出）。配置设 NODE_ENV=production，未注入假登录 provider。
- Caddy 经 Ubuntu 官方包安装，公开 80/443，自动 HTTPS/WSS 反代。Let's Encrypt 证书已签发并验证，2026-12-07 到期，自动续期配置有效但尚未经过实际续期周期。Caddy 管理口只在 `127.0.0.1:2019`。
- `aedresponse-backup.timer` 每日 UTC 03:15 后执行、保留约 14 天；手动在线备份与 integrity_check 已通过。备份与数据库同盘，尚无异地备份。后端正常 restart 后 health 与 SQLite 完整性通过。
- 公网实测 HTTPS health 200、HTTP 308、未认证 REST 401、16 KiB / 16 KiB+1 正确边界、WSS 升级后无 bearer 被拒绝。原生 App 的 ServerConnectionProbe.swift 在 Mac URLSession 中对同一 HTTPS 入口探测成功（1446 ms），不是 iPhone 蜂窝结果。
- 真实 SMS/Apple/Watch 验证器仍未注入，PHONE/APPLE 登录返回 503；没有真实会话可执行完整业务。9 月 8 日 devicectl 显示 iPhone 17 Pro 和 iPhone 16 均 unavailable；双机蜂窝业务及物理 Watch 验收仍未完成。此前离线 TestHost 不得改为绕过真实认证联调。
- 本批新增配置全部位于 `backend/deploy/azure/`，部署说明见该目录 README；本机日志 `backend/logs/azure-20260908/`（gitignored），服务器安装/测试日志 `/home/REDACTED/aedresponse-{install,test}-20260908.log`。没有 commit/push；保留既有脏工作树和历史副本。
- 下一步：接入并验证真实身份 provider，使用该 HTTPS origin 配置实际客户端，在 iPhone 17 Pro（患者）与 iPhone 16（响应者）可连接时执行真实蜂窝联通。不得用本次 transport 通过替代原始完整前后端目标。

## 当前附近待命人数批次（2026-09-06，实机验证中）

- 用户确认中立待命可查看“附近待命、可接受救助请求的其他用户”；列表与地图同时实现，默认列表，范围累计人数；不显示个人点位或身份。
- 先沿用 1/1.5/2 公里三层累计计数；后端只读聚合、稳定用户去重、排除自身/患者/已参与者/无效状态，REST 仅返回 generatedAt 与 ranges。此功能不产生招募，不改变位置频率。
- 新增 iOS `NearbyVolunteerSummary`、`NearbyVolunteersView`，AppStore 和 REST 只读接线；列表默认，TestHost 明确示例，离线地图不发请求。无数据和过期不伪装 0 人。
- 用户最新明确“有线无线无所谓，直接开始”，已撤销本次测试的无数据线限制。iPhone 17 Pro connected、解锁、实际 transport 为 wired，已启动新版 TestHost 签名安装及离线 Tests/UITests；不是蓝牙或无线链路验证。真实服务器、登录、公网和物理 Watch 测试仍不恢复。日志 `/tmp/aedresponse-nearby-physical-20260906-1146.log`，结果 `/tmp/aedresponse-nearby-physical-20260906-1146.xcresult`。
- 验证：后端纯业务 `npm run test:business` 72/72、`npm run check` 通过；新模型同一份 XCTest 在隔离 macOS SwiftPM 包中 7/7 通过；TestHost generic `build-for-testing` 与 Production Release 构建通过。新增 UI 用例仅编译，没有实机/模拟器执行；本批不得沿用上一批 11/11 实机结果。
- 后端汇总保留“收到 offer 但未接受仍为中立”语义；仅真正参与中的身份排除。只读聚合，无新事件/任务/通知，字段白名单无个人 ID 或位置。
- 结果与边界：`docs/nearby-volunteers-validation-2026-09-06.md`；最终日志 `/tmp/aedresponse-nearby-business-20260906.log`、`/tmp/aedresponse-nearby-check-20260906.log`、`/tmp/aed-nearby-native-model-20260906.log`、`/tmp/aedresponse-nearby-build-final-20260906.log`、`/tmp/aedresponse-nearby-release-20260906.log`。不 commit/push，不恢复冻结网络/登录/Watch 测试。
- 11:47 实机 Tests 实际 196 项：185 通过、11 项源码检查跳过、0 失败。整组 UI 12 项中旧 11 项通过；新增场景第 20 行把 Picker 限定为 SegmentedControl 未找到控件，列表人数和截图已通过，地图尚未验证。已将测试改为按稳定 ID 跨元素类型定位，并增加地图人数图例断言；没有改业务代码。
- 定点复跑 `/tmp/aedresponse-nearby-physical-20260906-1153.log` / `.xcresult` 已编译，但 11:53 Xcode 报设备锁屏，等待用户解锁。已发异步解锁问题。不得把这个定点复跑记为通过；若当前轮继续，要先检查这条正在等待的测试进程，避免重复启动。

## 当前 UI 批次（2026-09-06，已完成离线实机验证）

- 用户已批准 Tests UI 简化；“误报”和“结束救助”必须分开，各一次确认，分别对应意外触发取消和患者已得到救助。后端测试之后的其他 UI 调整留待下一批。
- 当前代码已更新设置、患者、响应者与导航界面；Xcode `AED_SHOW_TEST_TOOLS` 控制 TestHost Debug 测试 Tab，`AED_SHOW_DIALER` 默认 NO；移除开发说明/原始状态/位置卡。Settings 显示账号、服务器状态、手动 Ping、Watch 配对/通信、签署记录和自身坐标；系统权限通过 iOS 设置链接管理。
- TestHost 继续 `allowsLiveNetworking=false`；导航为标识“测试路线”的离线 Canvas，真实模式才构造 MapKit 路线。修复本地请求旧日期过期、每个手动场景使用独立事件 ID/当前时间、模拟响应人数与位置权限分级、模拟退出路径。
- 用户已连接 iPhone 17 Pro，当前 UI 批次已恢复针对该设备的离线 Tests/UITests 安装与执行；服务器接收、真实 Ping、真实登录、蜂窝/Windows/Azure、物理 Watch 测试仍暂停。
- 最终物理 iPhone `Tests` 188 项中 177 通过、11 仓库源码检查按设计跳过、0 失败：`/tmp/aedresponse-ui-unit-final-20260906.xcresult`。最终 `UITests` 11/11 通过、0 跳过：`/tmp/aedresponse-ui-physical-20260906-v4.xcresult`。已实际查看主场景、Settings、患者确认和 AED 路线切换截图；不是仅编译通过。
- 首轮 UI runner 自动化初始化超时，经单独重启测试会话恢复。随后修复父卡片 identifier 覆盖内部按钮（容器使用 `.contain`），并按实机嵌套控件结构调整原生确认弹窗查询。失败历史及完整边界见 `docs/ui-validation-2026-09-06.md`。
- TestHost generic build-for-testing 与生产 Release generic iOS 构建均通过；Release 产物显示开关为 NO。未运行 Simulator、真实服务器请求、Windows/Watch 服务或 commit/push。本批只在 iPhone 安装/运行 TestHost；其余 UI 等用户恢复后端测试后再讨论。

## 最新执行范围（2026-09-05）

- 用户明确授权代码开发后，本批已实现：AED 资源不足降级、退出后未开始任务补位、唯一响应者三次确认及 iPhone REST 接线。补位按 `R→A→P` 全程本地预计耗时排序，包含楼层/门禁/核验；未接真实高德步行 ETA，不把本地估算称为真实路网最优。在途任务仍锁定，不静默改派。
- 唯一响应者按 1/3、2/3、3/3 明确确认，打开入口不计数，取消清零；客户端只在第三次提交 `soleResponderConfirmed: true`。后端按事务内有效人数复核，缺少声明返回专用 409，客户端重新显示三次确认而非自动通过。患者结束仍只确认一次。该字段是客户端声明，不能独立证明实际屏幕点击。
- iPhone 已实现原声明幂等重试、ACK.exitedAt 关闭位置窗口、未 ACK 证据保留/越界隔离、退出本地标记过滤旧 REST/Socket、事件切换隔离与临时保存失败重试。没有实现照片/当面交接 UI；已取得 AED 者退出时后端保留占用及待交接事实，不能把已拿走的 AED 重新当库存分配。
- 最终纯业务回归 68/68，原 3 个失败均已通过；`npm run check` 通过。原生 Foundation 确认状态机脚本 9/9 场景通过。iPhone TestHost + unit/UI 测试代码的 generic `build-for-testing` 编译通过（`/tmp/aedresponse-exit-generic-complete-20260905.log`），不等于运行 XCTest 或真机验收。新增 6 个协调器/请求 XCTest、4 个 AppStore stub 回归已编译，尚未运行。详见 `docs/business-processing-validation.md`。
- 最新 `AEDResponse` 生产 scheme Release generic iOS 构建通过（`/tmp/aedresponse-exit-production-release-20260905.log`），使用 `CODE_SIGNING_ALLOWED=NO`，未安装或启动设备 App。OpenAPI YAML 与 `git diff --check` 通过；未提交或推送。
- 用户已暂停全部服务器接收、手机发送与网络联调测试；不得自动恢复 HTTP/Socket 接收测试、Windows 服务、手机或 Watch 测试。
- 真实短信/Apple 登录验证的新增开发暂停，等 GitHub Student 相关服务器资源就绪后再推进；既有身份与权限规则不变。
- 当前运行验证仅限“模拟数据已经到达业务层”的测试、原生纯逻辑脚本及编译：直接调用 `AEDResponseService`，使用合成身份/坐标、可控时钟、内存或临时 SQLite 和捕获发布回调，不监听端口。
- 新增独立入口 `cd backend && npm run test:business`；它预加载进程内网络禁用保护，不运行原 `npm test` 中的 HTTP/Socket 用例。需求差异应保留为失败用例，不得把测试预期改成迁就当前业务实现。
- 历史基线：17:18 为 57 项、54 通过/3 失败；已由上述 68/68 回归取代。不要把这些限定场景通过当作全量产品/真实设备/高并发验收通过。

## 当前目标

按照 2026-09-05 全部确认的 `docs/requirements.md` 继续开发 AEDResponse v2。生产 App 必须登录，只允许手机号验证码或 Sign in with Apple；登录后依次通过四项同意、Always + 精确定位和通知门禁，才允许初始化 iPhone/Watch 业务。当前批次已完成后端身份/招募/V2-A11—A12 状态机与位置批次主干，iPhone/Watch 亦已接入身份、触发/降级、隐私投影、REST-only 回执和 V2-A17 事件位置源码；当前物理 iPhone TestHost unit/UI suite 已通过，但尚未完成整套 V2-A01—A28、生产登录/定位现场验收、物理 Watch 和蜂窝 E2E。

## 本批已完成

### 需求与架构

- `docs/requirements.md` 已标记全部产品规则获批并成为 canonical 基线；`docs/runtime-flow.md` 用六张 Mermaid 图描述生产部署、登录门禁、Fall 触发、P/R 与 Watch 仲裁、动态招募、AED/退出、结束与留存。
- 生产身份只允许 `PHONE` 与 `APPLE`；没有密码、游客、匿名、邮箱、微信或其他登录。两种凭据暂不自动合并，避免错误合并稳定身份。
- 首次运行顺序固定为：登录 → 患者协议、志愿响应者协议、隐私政策、敏感个人信息同意 → Always/精确定位与通知 → 业务。

### 后端参考实现

- 新增手机号 challenge/verifier 与 Apple identity-token verifier 端口；手机号规范化、provider-scoped HMAC subject、稳定 `userId/accountId`、短期 access token、30 天 refresh token 单次轮换与复用撤销均已实现。
- 生产没有 SMS provider、Apple verifier、Watch App Attest verifier、app ID 或高熵 `AED_AUTH_SUBJECT_PEPPER` 时 fail closed；仓库没有硬编码验证码或身份 token 解码捷径。
- `/session/bootstrap` 只接受已认证账号的 iPhone；四项同意缺一不可。历史匿名 session 仅可迁移保留，不能继续认证。
- iPhone 可签发五分钟、一次性的 companion-link ticket；Watch 通过 App Attest 验证端口兑换并绑定同一 `userId/accountId/device/pair`，支持 Watch refresh rotation，iPhone logout 会撤销同 pair Watch 会话与未使用 ticket。
- REST JSON 和 Socket.IO 单事件限制为 16,384 bytes；Socket.IO 只下行通知。正常位置频率不限流，仅实现已批准的 `>5 次/秒且持续 10 秒 → 30 秒降级`异常熔断。
- 动态招募以事件持久化状态执行 `1000 → 1500 → 2000m`，目标 3 人；候选不足立即扩圈，候选潜力足够但 30 秒接受不足才扩下一圈，边界恰好 30.000 秒仍有效，只通知未获得过 offer 的新增身份。
- 候选以稳定 `userId` 去重；患者同账号其他 iPhone 不能响应、不能上传该事件 P，只有触发 pair 的 iPhone 是 P 写入源。
- 接受前投影只含 `FALL_ASSISTANCE`、距离/ETA 分桶、当前半径、`SEARCH_RING` 与 `expiresAt`。患者精确 P、地址卡、Fall/call 细节和完整 coordination 不进入候选 REST/Socket 投影。
- `EmergencyEventView` 已改为 patient/responder/pending/neutral 联合类型；pending/neutral 在 TypeScript 类型层禁止 trigger、精确 P、地址卡、coordination 与 assignment，不再使用强制类型断言掩盖角色差异。
- 本地进程有可停止、无重入的一秒 scheduler tick；持久阶段时间可在重启后继续。生产仍必须换成持久队列/调度器。
- V2-A17/A26 后端位置批次已实现：患者与已接受响应者使用事件级 `position-batches/{batchId}` REST 写入严格 UTC 整秒 `slotAt` 的真实 `FIX` 或 `NO_NEW_FIX`；每批最多 5 条，6 条返回 422；`recordId`/`slotAt` 批内唯一、跨批 slot 冲突返回 409、batch/record ID 幂等、旧 fix 不覆盖当前 projection，批次作为独立 append-only SQLite state collection 保存，不写普通 timeline。旧 `observedAt` 批次无法安全猜槽时原样移入持久化 `quarantinedLegacyEventPositionBatchesById` 隔离区，活跃 API 不读取且不删除证据。同一用户从旧事件响应者转为新事件患者时，新事件 `createdAt` 与旧参与区间 `PATIENT_PRIORITY` exclusive `endedAt` 严格相同。
- 待命/搜索圈仍只保留最新 P/R projection；scheduler、presence read/write 会在超过 10 分钟后物理删除过期位置。当前实现不虚构后台 1 Hz，客户端仍必须在 REST ACK 前保留离线批次。
- V2-A11/A12 后端主干已实现：统一 `POST /events/{eventId}/end` 映射误触、问题已解决和专业急救接管；`POST /events/{eventId}/exit` 立即撤权并按稳定 `userId` 永久禁止重入；退出前位置证据可按参与时间窗补传，退出后样本拒绝。
- 状态确认周期持久化执行 T+30 询问、`CONTINUE` 后重启 30 分钟周期和 T+35 `CLOSED_UNCONFIRMED_NO_RESPONSE`，被动信号不会结束事件。事件投影显式下发 `canPublishEventPosition`，仅主患者 iPhone 和当前已接受响应者可写事件位置。

### iPhone

- 登录页仅提供手机号验证码与 Sign in with Apple；Apple 使用随机 nonce，客户端不请求或上传姓名/邮箱。账号及设备会话存 Keychain。
- 冷启动必须先刷新/验证保存的账号会话；验证完成前不加载用户同意、不激活 WCSession、不定位、不连接 REST/Socket.IO。四项同意按稳定 `userId` 分区保存，logout 不抹掉已签版本。
- Release 服务地址只读受信任 `AEDResponseServiceBaseURL`；空值或非 HTTPS fail closed。普通用户不能修改 issuer，Debug/TestHost 才允许受控覆盖。
- iPhone 通过 WCSession 只发送四字段 companion-link envelope；不在该链路发送位置、触发、账号 bearer 或任务。
- 响应者接受前只显示中文化的事件类型、距离/ETA 区间、当前搜索半径和剩余有效期；`ResponseRequest` 使用原始 key allowlist，出现精确 P、地址卡、trigger、coordination 或其他额外字段即拒绝解码。
- iPhone 能解码 patient、accepted responder、pending candidate 和最小终态的角色化 REST 投影。精确 P、可选地址卡和 coordination 只有服务端确认接受并完成 REST 对账后才进入响应者 UI。
- 支持定向 `response:offer-expired`，只按匹配的 `eventId + deliveryId` 清理；本地 `expiresAt` 采用与服务端一致的“恰好边界有效、超过才过期”，过期后禁用决定并 REST 对账。
- 生产 `SocketIOEventStream` 已移除所有客户端 emit。DELIVERED/VIEWED 回执只走 REST，失败进入有界退避的待重试队列；接受/拒绝前等待 VIEWED 回执确认，决定成功后主动 REST 对账，不依赖 Socket 收敛。
- 患者和已接受响应者已接入一秒位置槽、真实 Core Location fix/`NO_NEW_FIX`、最多 5 条的 5 秒批次、移动 10 米提前发送，以及受保护原子离线队列。批次首次提交时记录内容即永久封口；REST ACK 只允许删除本地重试副本，不是封口时点。已实现 Core Location 批量回调跨秒分组、开放草稿持久化、重启 5 秒恢复和 `NO_FIX`/`APP_NOT_RUNNING` 分级。
- iPhone 严格消费服务端 `canPublishEventPosition`：同账号次设备可以查看患者状态但不启动 P 采集或上传；Socket 提示不能自行授予写权限。
- iPhone 已实现状态确认的严格 Socket 提示解码、REST 对账、患者 `CONTINUE` 操作与 `CLOSED_UNCONFIRMED_NO_RESPONSE` 终态。2026-09-06 UI 修订后患者使用“误报”和“结束救助”两个入口，各确认一次；通过现有 false-alarm/resolve REST 路径提交，不再要求共用按钮或原因选择。

### Apple Watch

- Watch 没有登录表单。未完成 companion-link、Fall Detection 权限与 Watch 定位权限前，不启动 Fall、CallKit 或业务定位监控。
- `CMFallDetectionManager` 是唯一生产跌倒信号。App 自有询问选择 `NEEDS_HELP` 时立即上报；`DECLINED` 清理且不成立；未回答时只有 Fall 后 120 秒内第一次新 outgoing observation 才以 `NO_RESPONSE` 成立。
- Apple `fallResolution` 与 App 回答分开保存；不推断电话号码、接通、通话时长或紧急联系人短信。
- 触发使用稳定 event ID、Fall+35 分钟受保护 outbox、ACK 后删除 payload、24 小时最小去重。Keychain/受保护文件故障 fail closed，不把错误当空队列覆盖。
- iPhone 不同时满足 `ACTIVATED && reachable` 且 Watch 自身有 WAN 时，Watch 无需服务端 permit 即可立即发送 fallback P，此后 5 秒或累计移动 10m 提前发送。iPhone 恢复可达立即停止新发送，但未 ACK 队列保留。
- 后端连续 10 秒无有效 iPhone P 才采用 Watch candidate；任一有效且更新的 iPhone P 立即恢复 `IPHONE_PRIMARY`。非事件无 iPhone 且 Watch 无 WAN 时只提醒一次 `UNAVAILABLE_NO_CONNECTIVITY`；Fall/事件中不运行该待命失效提示。

## 主要修改文件

- 需求/架构：[docs/requirements.md](docs/requirements.md)、[docs/runtime-flow.md](docs/runtime-flow.md)、[docs/architecture.md](docs/architecture.md)、`README.md`。
- 后端：`backend/src/auth.ts`、`config.ts`、`contracts.ts`、`models.ts`、`server.ts`、`service.ts`、`store.ts` 及 `backend/test/`。
- 契约：`contracts/openapi.yaml`、`contracts/events.md`、定位/safety schema 与 fixture。
- iPhone：`AuthModels.swift`、`AuthSessionStore.swift`、`AuthView.swift`、`AppStore.swift`、`Models.swift`、`APIClient.swift`、`SocketIOEventStream.swift`、`DeviceServices.swift`、`ResponderDashboardView.swift`。
- Watch：`WatchRuntimeModel.swift`、`FallEmergencyCoordinator.swift`、`WatchFallbackCoordinator.swift`、`WatchAPIReporter.swift`、`WatchPersistence.swift`、`WatchSystemMonitors.swift`、`WatchAppAttest.swift`。
- 工程/测试：`ios/project.yml`、生成的 `AEDResponse.xcodeproj`、iPhone/Watch test targets 与 `ios/VALIDATION.md`。

## 当前验证

- 后端：本轮独立执行 `npm test`（85/85）、`npm run check`、`npm run build`，均通过；覆盖统一结束、退出撤权/禁止重入、退出前离线证据、T+30/T+35、患者优先时间边界、严格秒槽位置批次、旧证据隔离、TTL 和 SQLite recovery。
- 契约：OpenAPI 3.1 由系统 Ruby/Psych 解析通过，30 paths、62 schemas、31 个唯一 operationId、182 个内部 `$ref`；contracts JSON 全部通过 `jq empty`，`git diff --check` 通过。
- XcodeGen：`xcodegen generate` 通过，`ios/project.yml` 仍是 canonical 工程源。
- iOS：最终源码已在物理 iPhone 17 Pro 上通过 `AEDResponseTests` 全套 172 项中的 161 项，0 failed，11 项仓库源码检查按设计 skipped；`AEDResponseUITests` 4/4 通过。`AEDResponseTestHost` 的 generic `build-for-testing` 也通过，但只作为编译证据，不替代上述真机结果。最终修改后的 `AEDResponse` Release generic iOS production scheme 已复跑通过。
- watchOS：最终源码的 `AEDResponseWatch` Release generic watchOS 构建通过；同日更早的 Watch `build-for-testing` 亦通过，但均不构成物理 Watch 证据。
- 仅有 TestHost “所有界面方向”警告；没有编译失败。
- 本批没有运行 Simulator。2026-09-05 复核确认当前 Xcode 账号、证书与 Personal Team `GR6YBCDW7R` 有效；证书名称（CN）括号中的 `H463W287GN` 不是 Team ID，曾将其误作 `DEVELOPMENT_TEAM` 才触发 `No Account for Team`。证书 subject 的 `OU=GR6YBCDW7R` 与签名 App 的 `TeamIdentifier=[TEAM]` 才是当前 Team 证据。iPhone 17 Pro 已连接、配对、启用 Developer Mode，并是 TestHost 的可用真机 destination。TestHost 使用 `/tmp` DerivedData 后成功签名、安装和启动；首次启动时无条件设置 `allowsBackgroundLocationUpdates` 导致的 TestHost Core Location 崩溃也已修复。首轮真机结果 `/tmp/aedresponse-iphone-physical-20260905-1605.xcresult` 曾为 135 passed / 26 failed / 11 skipped；逐项修复真实竞态与测试可移植性后，最终 `/tmp/aedresponse-iphone-physical-final-20260905-1643.xcresult` 为 161 passed / 0 failed / 11 skipped，`/tmp/aedresponse-iphone-ui-physical-20260905-1638.xcresult` 为 4 passed / 0 failed / 0 skipped。
- Windows 只读核对：`ssh winpc` 的旧 LAN 地址已不可达；随后通过当前在线的 Tailscale/MagicDNS 管理路由连接，ED25519 指纹与既有 Windows host key 一致。远端 `backend/package.json` 仍是旧 v2.1 测试清单且没有 `backend/src/auth.ts`，证明本批认证/招募源码尚未同步；端口 8787 无连接/监听。没有启动、同步或修改 Windows 文件、服务、计划任务、防火墙、Tailscale、隧道、Azure/云资源或公网入口；没有 commit/push。

## 尚未完成与外部门槛

1. 生产登录尚缺真实 SMS adapter、Apple token verifier、服务 ID/audience、Watch App Attest verifier/app ID、密钥托管和公网 HTTPS 域名；因此当前生产登录按设计不可用，而不是可直接上线。Windows 上的旧后端副本也尚未包含本批认证源码。
2. V2-A09 尚缺高德路径规划 2.0 步行 ETA、`detour <= 300s` 和在途 15 秒改道确认。AED 短缺降级、未开始任务退出补位已完成；本地 Haversine 全程 ETA 只是参考估算。
3. V2-A11/A12 的后端状态机、iPhone 状态确认和响应者退出 UI/REST 已完成；患者两个结束入口及唯一响应者三次确认的当前实机状态以本文件顶部 UI 批次为准。真实后端结束/退出联调仍暂停；AED 当面/照片交接流程未完成。
4. V2-A17/A26 的后端批次已完成；iPhone 主链路源码已接入严格一秒槽、`slotAt`/真实 fix 时间分离、跨秒回调、重启恢复、跨批唯一性、字段互斥、退出前/终态时间窗与旧证据隔离，当前 TestHost 逻辑已通过物理 iPhone unit/UI 回归。尚缺显式 `stream-finalized`/`sync-complete` 信号及全参与窗口的跨批次最终完整性审计；当前只能保证已收记录唯一且 append-only，不把乱序重试期间的临时缺口宣告为最终缺口。真实 Core Location 在锁屏/挂起/终止下的行为和独立 5 MiB 照片链路亦未完成。
5. 尚无 APNs、事件匿名团队位置/联系能力的完整实现，也未验证 App 挂起/终止后的招募通知。
6. V2-A27 的 30 天/3 年分层、10 分钟待命 TTL 物理删除、deletion tombstone、hash chain/manifest、申请后 24 小时只读查看仍未实现。
7. 中国大陆生产 PostgreSQL/PostGIS、Redis compatible cache、持久队列、对象存储、WAF/可观测性与 GitHub Actions 部署门禁尚未创建；全球 Azure 合成环境和 V2-A28 的 60 分钟 P20 压测也未执行。
8. 当前 Xcode 账号、iPhone Team/profile、iPhone 17 Pro 安装链路及 TestHost unit/UI 已验证可用，不再存在 26 个真机失败。物理 iPhone 的真实手机号/Apple 登录、系统权限、真实 Core Location P/R，两机蜂窝 HTTPS/WSS，物理 Watch App Attest/Fall/Call/WAN fallback，以及真实 Emergency SOS 可观测性仍须分层验证。Watch 仍另受签名 capability/entitlement 与安全测试条件限制。
9. 协议具体法律文本与责任边界仍按用户要求留在独立研究任务；代码中的协议门禁不等于法律结论。

## 建议的下一开发顺序

1. 本批离线 UI 已完成，供用户在手机上的 AEDResponse Tests 通过底部“测试”查看；其余 UI 留待用户恢复后端测试后调整。患者“误报”和“结束救助”分开、各一次确认，不恢复旧共用按钮/原因选择方案。位置记录在批次首次提交时即永久封口，REST ACK 只删除本地重试副本，后续不得回退成“ACK 后封口”。真实服务器、登录和网络测试仍须用户重新授权。
2. 在生产凭据与受控环境就绪后，分开执行真实登录/权限/Core Location、双机蜂窝 HTTPS/WSS 和物理 Watch 安全验收；TestHost 通过不替代这些层级。
3. 接入抽象的高德 route adapter 与 V2-A09 调度规则；在没有生产 key 时继续 fail closed/降级前往患者。
4. 实现 APNs、图片交接、证据 hash chain、留存/删除任务和生产数据层。
5. 公网 HTTPS/WSS 测试入口经用户审核并完成部署后，在物理 iPhone 17 Pro（患者）与 iPhone 16（响应者）执行登录和蜂窝 E2E；最后单独进行物理 Watch 与真实 Emergency SOS 安全验收。

## 不得破坏的约束

- 当前分支 `codex/ios-mvp`，基线提交 `8362af2`；工作树包含用户与本轮大量未提交修改。不得 reset、clean、覆盖无关文件、自动 commit/push 或创建 PR。
- `ios/project.yml` 是 canonical XcodeGen 源；用户保留的 `ios/AEDResponse 5.xcodeproj/` 和带空格/数字后缀的历史副本不得删除或改作生产源。本批明确未修改 `SocketIOEventStream 2.swift`。
- 只允许手机号验证码或 Sign in with Apple；不得恢复匿名/游客/密码/邮箱入口，不得未经审核自动合并 PHONE/APPLE 账号。
- Watch 不拨号、不编排；iPhone 不做 Fall/Call 触发。蓝牙/WCSession 只用于近端可达性与一次性绑定，不传业务位置。
- REST 是业务写入与恢复真相；Socket.IO/APNs 只通知。候选接受前不得获得患者精确位置、地址、身份、trigger 或完整 coordination。
- 生产业务必须经公网可信 HTTPS/WSS；Tailscale 只可用于管理员 SSH，不得承载 App 数据。未经用户对具体资源/供应商的进一步确认，不启动 Windows 服务，不创建公网入口、DNS、证书、隧道或云资源。
- 不把 generic build、build-for-testing、Simulator、entitlement 文件、账号/profile 存在或合成事件当作物理 iPhone/Watch、真实蜂窝或真实 Emergency SOS 证据。

- 追加用户反馈：17 Pro当时位于行动页，不能以后台或其他页解释。已请求恢复17 Pro调试连接以核对可见UI；16不要求连接。外层/卡片onAppear仅是静态线索，未据此改业务或声称已找到根因。临时Apple名单及私有IPC配置已关闭；保留当前测试事件和历史，需患者明确结束后再验收下一次。

- 17 Pro重新连接后新增显式opt-in testOptInLiveScreenEvidence：只激活联网ControlledTests并截屏/读取控件树，不调用UITestMode，不点击接受/结束。使用仓库外xctestrun把目标设为联网包，build-for-testing与实际test-without-building通过。截图10:48为行动页中立待命、无请求卡；采集在30秒请求到期后，不能据此复现请求窗口内的问题。截图/控件树位于基线live-screen/。临时测试配置已删除、服务健康正常；现有ACTIVE事件待16患者端明确结束，之后才可重试。


## 2026-09-17 高德 AED 数据采集

见 [采集交接](docs/handoff-amap-aed-2026-09-17.md)：199 次扩大采集，1 个明确候选；字段已映射，完整服务器 schema 尚缺真实字段，未导入数据库。


## 2026-09-19 用户端 UI 与登录前协议

- 目标：按用户提供的 AED1–AED4 调整 SwiftUI 页面，移除普通用户界面的开发信息；协议改为登录前默认未选中的复选框，未全部同意不得登录。
- 已完成：首页/邀请/导航/设置四页、公共样式、安全说明、协议全文与同意记录入口；保留真实权限状态、上报确认、AED 到达/取用分步和退出/注销约束。
- 主要文件：ios/AEDResponse/Views/{RootView,ResponderDashboardView,NearbyVolunteersView,ResponderNavigationView,SettingsView,AuthView,OnboardingView}.swift。
- 测试配套：AppEnvironment.swift 与 AuthSessionStore.swift 仅隔离 TestHost 身份/Keychain 撤销读取并提供离线 challenge；UI 测试与 ApprovedUIScenarioTests/ArchitectureBoundaryTests 更新。
- 验证：5 项 UI 用例通过；最终布局的设置/附近场景复测通过，四页/AED 分步用例补跑通过。此前 48 项相关单测和无签名 iPhone/Watch Release 编译通过。最终布局完成 Simulator Debug 编译。
- 参考、截图、完整验证记录：[用户端设计与验证](docs/design/consumer-ui-2026-09-19/README.md)。
- 真实 AED 名称/楼层没有随 Assignment 下发，导航显示通用 AED 取用点，不写死参考地址。离线 TestHost 图示不作为实景地图/真机登录/后台同步证据。
- 下一步如需要：在用户指定真机验证 Apple 登录后的同意同步与真实地图。当前未进行物理设备安装、提交或推送。
- 不得破坏：已有未提交的后端/客户端改动；REST 权威状态；四项独立同意；模拟标识；账号操作与活动救助限制。


## 2026-09-19 用户端真机验证：推送登记分阶段

- 正式 App 最新 UI 已签名安装到 17 Pro，账号已登录并可在重启后恢复；实际附近地图控件/瓦片已观察到。
- 用户反馈“远程通知注册未完成”对应旧 iOS/APNs 分支；原错误未保留原因。本次日志已取得 APNs token，但服务器登记返回 HTTP 404，不能混称账号注册失败。
- 修正为设置页非阻断后台提醒状态，保留重试，并在成功（含同 token 恢复）后清除。7 项定向回归通过，最终签名版本已安装。
- 线上登记 404 尚未修复、线上版本待核实；未部署后端、未创建事件、未验证推送实际送达。
- 详见 [真机验证记录](docs/evidence/ui-device-verification-2026-09-19/README.md)。
## 2026-09-20 09:32 Watch 安装后 503：远端验证器未配置

Watch 实际安装成功并收到 iPhone 受保护封包；兑换请求到达公网后端但返回 503。无效探测票据也在票据查询前得到 `WATCH authentication is not configured on this backend`，客观确认 Azure 服务未启用 Watch App Attest 验证器，不是 Watch 安装、WCSession 或跌倒 entitlement 问题。本地已修 Azure 初始化链：显式配置 App ID、CFBundleVersion 白名单与 development/production 环境，production 缺任一项即拒绝启动；相关定向测试 26/26、类型检查和 env-template 门禁通过。远端尚未修改或重启，需获得部署授权后配置当前开发包的 `[TEAM].dev.codex.aedresponse.watchkitapp` / `2` / `development`，再重发新的一次性封包。详见 [证据](docs/evidence/watch-registration-2026-09-20/README.md)。不触发真实跌倒或 SOS。

## 2026-09-20 用户当前位置显示修正

- 用户反馈本 App 自身位置与实际不符，同地点苹果地图蓝点准确。尚未采集偏移坐标，不能认定为 GPS 或坐标系根因。
- NearbyVolunteersView.swift、ResponderNavigationView.swift：真实地图改用 MapKit UserAnnotation；定位按钮和首次显示采用 userLocation 相机。移除用应用缓存坐标绘制的“当前位置”假蓝点。真实路线起点使用 MKMapItem.forCurrentLocation，取 AED 后不再以固定 AED 坐标充当自身位置；离线图保留原路径。
- 本次仅修改上述两处视图及本交接，不修改定位上报、历史位置证据或坐标转换。附近范围圈仍取业务定位中心；步行路线尚未增加随移动自动重算，不能把本次视为完整导航改造。
- 验证：git diff --check 通过；正式 AEDResponse generic iOS 无签名 build 与已连接 iPhone 17 Pro 定向签名 build 均成功；devicectl 安装 dev.codex.aedresponse 成功。
- 日志：/tmp/aed-location-fix-build.log、/tmp/aed-location-fix-signed.log；产物 /tmp/aed-location-fix-build/Build/Products/Debug-iphoneos/AEDResponse.app。
- 待验收：手机现场对照实际位置与苹果地图。编译/安装不能证明偏移已消失；未创建急救事件、未提交或推送。

## 2026-09-20 项目进度保存

- 用户已现场确认 MapKit 原生蓝点修正解决自身位置偏移。
- 用户授权提交并 push 当前项目进度。保存当前后端、契约、客户端、测试、部署脚本与证据文档；不包含 backend/unused-memory-store.json.identity-ledger.jsonl、backend/unused-memory-store.json.restore-watermark.json、backend/unused.json.restore-watermark.json 三个运行时临时文件。
- 本轮后端 npm run check、npm run build、npm test、npm run smoke 全部通过；iOS 签名构建和 17 Pro 安装见上一条记录。源码 diff whitespace 检查通过；历史 evidence 日志/patch 原样保留其空白，不改写旧证据。
- 用户另要求关闭“导航数据显示的面板”，当前未能唯一定位该面板，已请求确认是地图下方距离/时间、附近人数范围还是其他面板；没有猜测删除 UI，待确认后继续。

## 2026-09-20 展示版审查修复同步

- 将展示版审查发现的三项关键修复同步回正式源码：空间网格使用与精确距离一致的球面包围边界，跨网格边缘不再漏掉范围内候选；没有历史直接证据时，缺失位置只记为 `NEVER_UPLOADED`；位置窗口对账移除重复邻居扫描，事件终态通知在历史对账前尝试发送。
- 新增空间阈值、全球纬度/方位、日期变更线、极区、整日缺失窗口与通知顺序回归测试。
- 验证：`npm run check` 通过；完整后端 `npm test` 688/688 通过；`git diff --check` 通过。未修改或纳入三个本地运行时临时文件，未部署远端服务。
- 展示版在 `/Users/REDACTED/Documents/AEDResponse-Systems-Showcase`，只保留短 README；其独立后端 121/121、Swift 85/85 通过。展示版与正式项目为两个独立目录。

## 2026-09-22 导航信息面板与附近范围圈

- 用户要求移除导航地图下方的距离、步行时间等信息面板，并反馈附近范围圈圆心与真实用户位置不一致。
- `ResponderNavigationView.swift` 已移除距离、ETA、路线加载和路线失败文字，只保留原生当前位置、目的地及路线本身；算路失败仍安全地不显示路线。
- `NearbyVolunteersView.swift` 的真实地图改为 `MKMapView`：蓝点和 1/1.5/2 公里范围圈都直接使用同一个 `MKUserLocation` 回调坐标。业务缓存位置只作为原生位置尚未返回时的初始相机视野，不再用于绘制范围圈。定位更新超过 1 米时重绘圆心，定位按钮回到原生当前位置；累计人数和既有半径契约不变。
- 验证：`git diff --check` 通过；正式 `AEDResponse` generic iOS Debug 无签名构建通过；iPhone 17 Pro 定向签名构建及 `codesign --verify --deep --strict` 通过；`devicectl` 覆盖安装并启动 `dev.codex.aedresponse` 成功。现场范围圈视觉对齐仍需用户在已打开 App 中确认。
- 本批未提交、未 push、未部署后端；三个本地运行时临时文件保持未跟踪。

## 2026-09-22 Watch ↔ iPhone 真实通信复测

- iPhone 17 Pro 与 Apple Watch Series 11 均为物理设备；正式 iPhone App 已登录，Watch App 实际打开。iPhone 设置页一度显示“已配对 / 已安装 / 已连接”，冷启动后变为“暂未连接”，再次确认该字段只反映瞬时 `WCSession.isReachable`，不能作为业务闭环结论。
- Apple Watch 控制台在 00:36:31 捕获到 `AEDResponseWatch` 的真实 HTTPS/HTTP2 请求：请求约 8,234 字节，服务端响应约 297 字节，`response_status=503`，耗时约 3 秒。Watch 同时显示“配置或上报未完成 / v2 服务拒绝请求”类提示。
- 同时对公网 `/api/v2/watch/session/redeem` 使用不创建会话的无效证明探针，服务端返回 `503 Authentication unavailable`，详情为 `WATCH authentication is not configured on this backend`；`/healthz` 为 200。结论：iPhone → Watch 受保护封包与 Watch → 公网传输已实际到达，但 Watch App Attest 验证器/独立业务会话仍未启用，当前不能通过真实业务链路。
- Mac 到 Watch 的开发隧道仍报 `CoreDeviceError 4000 / RemotePairingError 1001`，DDI 不可用；本轮未触发 Fall Detection、Emergency SOS 或救助事件，未修改业务代码、未部署后端、未提交或 push。

## 2026-09-22 附近范围圈显示开关

- 设置页新增“显示附近范围圈”开关，默认开启，使用 `aedresponse.ui.show-nearby-range-circles` 持久化。关闭后真实地图和离线 TestHost 都只隐藏 1/1.5/2 公里圆及圆标签；原生当前位置、地图、列表累计人数保持可用，重新开启立即按当前原生位置重绘。
- `NearbyVolunteersView` 与 `SettingsView` 共享同一偏好键；`UserLocationRangeMap.Coordinator` 在开关变化时原地移除或恢复 overlays/annotations，不重新请求业务数据，也不改变后端半径或隐私投影。
- 验证：generic iOS Debug 与 iPhone 17 Pro 定向签名构建通过，完整签名验证、覆盖安装及正式 App 启动通过；设置页 UI 用例源码新增开关存在断言并完成编译。物理 iPhone UITest Runner 连续两次在执行测试方法前遇到 DTX/IDE 连接拒绝（code 74）；Simulator 用例进入 TestHost 启动后受本机 Xcode `DebuggerVersionStore` 异常挂起，已终止。因此自动 UI 点击未通过，需以已安装正式 App 的现场开关操作为最终确认。
- 本批仍未提交、未 push、未部署后端。

## 2026-09-22 Watch 部署与真实 401：用户要求暂停

- 已获部署权限，备份后将定向 Watch 修复发布到 Azure `/opt/aedresponse/releases/watch-attest-20260922-r3`。线上以 9 月 12 日旧版本为基线，仅增加认证相关文件/接线；未发布本地全部后端改动或迁移 schema。
- 503 已消除。真实 Watch 的 production 证明与原 development 配置不匹配已调整；后续仍 401，精确原因是 `build-extensions(flags=64,trailingBytes=0)`，即缺少版本与签名类别扩展。Apple 证书/nonce/App ID/公钥/环境已通过，但 Watch 会话仍未创建，不能声称业务通过。
- canonical 同步了固定拒绝阶段诊断、环境与签名类别分离、ED 位及 CMS 直接签名兼容修正，并用 Apple 官方签名样例回归。check/完整测试 692/692；远端候选 check/build、463/463 原回归、18/18 定向测试、公网 HTTPS/WSS 检查通过。
- 旧代码/配置/一致性 SQLite 备份在 `/var/backups/aedresponse/watch-attest-20260922/`。首次候选 dist 权限导致短暂 502，已恢复并修正，最终 active/running、NRestarts=0、health 200、数据库 integrity_check=ok；现存事件/历史保留。
- 用户说“还是401，晚点搞，我要睡觉了”，本阶段停止。控制台采集已停；待选择的“仅当前账号/Watch 受控兼容”未获批准、未实现、未启用；不得自动继续或绕过缺失字段校验。
- 详细部署、回退路径、改动文件与下次起点见 [Watch 部署记录](docs/evidence/watch-deployment-2026-09-22/README.md)。未触发 Fall/SOS/救助事件，未提交或 push；原有未提交 UI 修改保持。

## 2026-09-22 Demo 优化发布与正式源码对照修复

- 用户要求正式版对照修复 Demo 中确认的问题，并将独立 Demo 优化 push。公开展示仓库 main 已推送 `1fded90`，GitHub Actions `35674290034` 的 backend/Swift 两个作业均成功；展示版保留独立目录与精简 README。
- 正式后端同步了事务候选补足、可变草稿/快照隔离、过期索引去重压缩、分参与时段证据计数、事务内原子对账、缺失身份索引的招募补全、暂存事件归属复核、普通设备仅返回自身对账明细。新增 service-reconciliation 测试接入 package.json；源码改动集中于 entity-transaction、position-expiry-index、position-window、service、tx-recruitment-context。
- 正式 Swift 同步 AED 回执别名的幂等重试修复、Watch 新定位采集游标与历史重放分离、拒绝重复/乱序定位、服务端撤回备用定位许可时停止采样，并修正 @Sendable 时钟默认闭包。保留原 AEDResponse/AEDResponseWatchLogic 模块及 Models 文件；未把展示版模块合并带入正式 Xcode 工程。
- 验证：正式后端 check/build 通过，完整测试 706/706；从正式源码复制到 `/tmp/aed-formal-swift-sync.Xc9voy` 的双模块纯逻辑测试 89/89；正式 AEDResponse generic iOS Debug（含 Watch）无签名 build 通过；git diff --check 通过。日志 `/tmp/aed-formal-demo-sync-backend-test-20260922.log`、`/tmp/aed-formal-demo-sync-build.log`。
- 本批正式版改动仅在本地，未提交、未 push、未安装真机、未部署服务器。现有 Watch 认证/UI 脏改及运行时临时文件保留；此前真实 Watch 401 的暂停与不绕过缺失证明校验约束继续有效。

## 2026-09-22 Watch 认证架构静态定位（禁止继续测试）

- 用户要求“不要进行测试，先把问题找到”。本阶段仅阅读本地现状、上轮部署源码快照/证据及 Apple 官方协议；没有设备/API 探针、构建、测试套件、部署或业务代码修改。
- 401 直接原因已能由源码与上轮日志对应：`apple-app-attest.ts` 无条件调用 `verifyAppAttestBuildExtensions`，而真实证明 `trailingBytes=0`；读取末尾不存在的 CBOR 失败，统一返回 `verified:false`，service 再转换为 401。核心架构缺口是证明格式/能力与版本准入策略未分层，没有建模“缺少可选能力”与“无效身份”的区别。强版本准入可作为明确产品政策，但必须与支持的设备/证明格式一致。
- Apple WWDC26 `Secure your apps with App Attest`（https://developer.apple.com/videos/play/wwdc2026/201/）将尾部版本/签名类别介绍为 iOS 27 新增扩展；不能由此推定所有 Watch 证明具有同一字段。该 Watch 缺失扩展的 OS/SDK 层具体原因仍未证实。真实回执验证在扩展验证之后，前置验链/nonce通过不等于完整证明已通过。
- 手机显示状态缺少业务闭环：SettingsView 只由 isPaired/isWatchAppInstalled/isReachable 计算“已连接”；CompanionConnectivityState 不含服务端绑定/认证结果，WCSession sendMessage 的 replyHandler 为 nil，也没有手机消费的绑定状态查询路径。因此手机无法据此反映 Watch 的后端 401。
- 首次绑定与恢复耦合：iPhone 可达变化/连接恢复可重发票据；新票据进入 Watch performRedeem 时重新 generateKey/attestKey。WatchRuntimeModel 收到封包即清除运行时 sessionVerified 并暂停监控，再执行兑换。已有 refresh 路径，但未由后端绑定状态统一决定是否需要重绑。重复同一已成功票据已有 fingerprint 去重，不能笼统声称所有回调都新建 key；新票据重认证和监控中断风险是静态路径结论。
- 密钥/证明生命周期不完整：客户端保存 App Attest key ID，但生产绑定流程未调用 loadAppAttestKeyID；后端 verifier 返回 evidence，而 redeemCompanionLinkTicket 只使用 verified/deviceInstanceId，未保存公钥/回执证据，也没有 assertion 路径。它不是本次 401 的直接原因，但不能描述成已完成可复用的设备证明生命周期。
- 错误协议丢失原因：后端仅布尔结果，客户端仅保留 HTTP status，格式不支持、策略拒绝、票据失效等不能在授权设备状态中区分。现有真实验签测试的完整入口主要覆盖拒绝路径，Apple 样例仅独立验证扩展/回执 helper；companion 成功用例使用 fake verifier。本轮只读测试源码，没有运行。
- 后续先设计：证明能力/准入分层、后端权威绑定状态投影、稳定 key 与 refresh/重绑定生命周期、可恢复/不可恢复的安全错误分类。保持当前缺失元数据拒绝规则，未经明确授权不增加受控兼容白名单。

## 2026-09-22 用户更新连接语义与 Watch 界面设计

- 用户纠正：“已连接”表示 Watch 能向 iPhone 传递信息（包括跌倒信息），不等于已获后端独立 Watch 会话。后续不可再将云端认证作为该显示词的必备定义。
- 已明确选择 **Watch → iPhone → 服务器为主、Watch 直传备用**。该新决定取代旧“WCSession 不传业务、Watch 必须直报”的路由约束；尚未实现，不可拿当前近端可达性当作已存在跌倒中转能力。
- 恢复设计：保留原绑定和未确认记录，重连优先恢复会话，首次绑定/重连恢复/账号切换分离。未批准跳过 App Attest 缺失版本字段校验。
- Watch 常态 UI 只保留绑定 iPhone。四状态效果图 `docs/design/watch-binding-2026-09-22/concept-v1.png` 已获用户确认；随后要求优先调整已绑定页的圆润勾号、居中与小号手机。修订图为同目录 `bound-v2.png`，两张均为概念图而非运行截图。
- 已修改 `ios/AEDResponseWatch/App/AEDResponseWatchApp.swift` 的已绑定常态页：勾号圆头/圆角，路径与圆环同心，手机以直径 20% 字号独立 overlay 在右下角；标题与状态居中，按实际剩余区域布局。权限未完成时保留原权限动作，真实跌倒时保留必要的求助交互。
- `ios/AEDResponseWatch/App/WatchRuntimeModel.swift` 仅增加近端可达性的 Published 投影；未改绑定认证、事件生成、中转或恢复。当前 `isCompanionLinked` 仍受旧认证门禁控制，“连接正常”也还只是系统可达，不得宣称跌倒中转已能使用。
- 本轮 `git diff --check` 通过；无设备/API/套件测试、无构建、无运行截图、无安装或部署。其余三个绑定状态与旧错误弹窗尚未精简；下一阶段按已明确主链路实现中转/ACK、恢复与对应 UI 状态。用户未恢复测试许可，不得自动联调；不得弱化 App Attest 或触发真实急救事件。设计参数、静态对照及边界见设计目录 README。

## 2026-09-22 15:18 用户恢复启动/连接测试，Watch 暂不在旁

- 用户要求“启动一下，我看一下效果。顺便测试一下看能不能连接”，恢复本次构建、安装、启动及安全连接检查授权；随后确认 Watch 暂时不在旁边，因此本轮只完成能进行的 iPhone 端步骤，不等待/监控手表自动回来。
- 正式 `AEDResponse` Debug（包含 Watch）在全新 `/tmp/aed-watch-ui-launch-20260922.j9yvdp/DerivedData` 完成签名构建；`build.log` 为 BUILD SUCCEEDED。没有修改 Swift 业务代码或工程设置。
- 对独立 Watch、嵌入 Watch、外层 iPhone bundle 及各自 dylib 分别执行严格签名校验，全部通过；Watch profile 包含目标 Series 11 的 UDID。iPhone 17 Pro 有线连接、DDI 可用；覆盖安装并前台启动 `dev.codex.aedresponse` 成功，保留数据。结果记录为同一临时目录下 `iphone-install.json`、`iphone-launch.json`、`iphone-app.json`。
- Watch 开发隧道 unavailable、DDI 不可用；本轮未尝试反复重建隧道、重配对或清除数据，未安装/启动物理 Watch。iPhone 中已嵌入新版 Watch 包不等于手表已经更新，实际已绑定页尚未视觉验收。
- 只读确认 Azure current 仍为 `watch-attest-20260922-r3`，service active/running、NRestarts=0；公网 health 200。本轮未取得新的 Watch 认证/消息结果，不能声称 401 已消失或仍由本次复测重现；近端消息与手机中转的完整业务链路均未通过本次验证。
- 无后端部署、无认证放宽、无 Fall/SOS/救助事件、无提交/push。下次手表在附近并打开 App 后确认 Watch 更新与消息通信；手机中转、恢复及其余三态 UI 仍为待实现，不能以成功图代替真实状态。
## 2026-09-26 Watch/iPhone 互联修复

- 用户要求修复真实互联；主链路为 Watch→iPhone→服务器，直传备用。新增严格相关 ID 的 WCSession RPC、手机接收/原样中转、服务器电话主体/Watch绑定/事务内撤权检查；主/备复用同一事件 ID 与来源指纹，仅最终服务器 ACK 清理 Watch 原有受保护队列。
- 新文件 `backend/src/watch-relay.ts`、`ios/AEDResponseWatch/Networking/WatchRelayReporter.swift`；同时修改 Models/Ports/APIClient/AppStore、两端 WCSession、Watch runtime、绑定 UI/手机连接投影、服务端路由/store/model/事件事务 hook。契约见 `contracts/watch-relay.md` 和 OpenAPI。独立 App Attest 缺失扩展拒绝保持不变，不把手机授权等同 Watch 独立认证。
- 本地正式签名构建通过。后端 715/715 + 新增 HTTP 1/1；Watch/Foundation SwiftPM 23/23（源码拷贝在 `/tmp/aed-watch-relay-20260926.QPyEQO/swift-tests`）。最终回归和候选部署仍进行中，不得提前宣称真机互联通过。
- 用户明确“不要用镜像”：禁止后续模拟器、屏幕镜像和开发镜像挂载。此要求之前的唯一 Watch 设备读取遇到 DDI 12040 / 0xe8000076，随后不再尝试。改用 Homebrew 官方源安装的 ideviceinstaller/libimobiledevice，通过标准 USB 应用安装服务；未改应用依赖。目前 USB/网络安装通道尚未枚举出 iPhone，已请求用户用数据线连接并解锁。
- 仅把本次互联补丁回移到线上旧基线候选，不发布整个脏工作树。工作目录 `/tmp/aed-watch-relay-20260926.QPyEQO`，远端候选 `/opt/aedresponse/releases/watch-relay-20260926-r1`，备份 `/var/backups/aedresponse/watch-relay-20260926-r1`；prepare 已发起，尚未切换。准备/回滚脚本在该工作目录，候选原生旧存储 API 与新版 incremental-state 适配区别必须保留。
- 未触发真实 Fall/SOS/救助事件。下一步：核对候选回归和服务账号预启动，按授权切换并检查；签名校验后通过 USB 覆盖安装（保留数据），用户在真机打开两端，读取仅含方法/请求 UUID 的回执日志与服务器绑定记录。无真实回执不能宣称互联完成。保留所有已有脏改，不提交/push。

### 本阶段最新状态（20:05 后）

- 最终本地回归 716/716、契约 smoke 5/5、Swift/Foundation 23/23、签名构建/三个 bundle 与 dylib 校验通过。远端旧基线候选 463/463 + HTTP 1/1、实际 aedresponse 服务账号预启动通过。
- 服务器已切换 `watch-relay-20260926-r1`，active/running、NRestarts=0、health 200、匿名 relay 401。备份/回滚就绪；未更改 App Attest 或其他线上未部署功能。当前新 helper 使用旧 store.read/transact 接口；canonical 使用 incremental-state，不能混发整个工作树。
- iPhone 已经 USB 覆盖安装完成（InstallComplete 100%）。严格遵守用户“不用镜像”：不再使用任何模拟器/屏幕镜像/DDI，普通 USB installer 可读/安装此设备。
- 尚未确认新版 Watch 同步与真实双向回执。已向用户请求打开两端前台并反馈 Watch 状态；一次新状态只读核对中 relay binding=0，events=4。这是真机验收未完成，不是互联已成功。
- 详细证据与限制见 `docs/evidence/watch-relay-2026-09-26/README.md`；不要触发救助、卸载/清除 Watch 或以假绑定页面替代验证。Watch scheme 出现 Xcode 自身格式化修改，保留未撤销。

### 20:09–20:15 真机回包触发闪退（正在修复，不得宣称通过）

- iPhone USB syslog 已看到 WatchConnectivity 收到实际字典消息并成功发送响应，随后 Watch 失联；用户确认“Watch 连接不上，打开就闪退”。20:09 的 iPhone 日志还显示过认证刷新 401→后续登录/设备建立成功响应，但 relay binding 仍为 0。
- 使用 `idevicecrashreport --keep --extract --filter AEDResponseWatch` 通过 iPhone 的 ProxiedDevice 目录复制到 `/tmp/aed-watch-relay-20260926.QPyEQO/crashes`，没有删除设备报告、没有用 DDI。多个新 Watch OS 27.0 报告一致：Utility NSOperationQueue 中，WatchConnectivity→本 App 闭包→libswift_Concurrency/libdispatch 触发 EXC_BREAKPOINT/SIGTRAP。
- 源码问题：MainActor 方法中交给 Objective-C WatchConnectivity 的非 Sendable closure 隐式继承主 actor，SDK 从后台调用时在内部 Task hop 之前就触发运行时检查。已改为 Foundation-only `CompanionRPCCompletion` 提供显式 @Sendable 的 reply/error callbacks，再在内部跳 MainActor，保留超时和只 resume 一次。新增后台 Task.detached 回调/重复回包/晚到错误回归；同时显式标注 Watch 权限回调与 iPhone 旧发送错误回调。
- 新的诊断输出改为 DEBUG NSLog（方法/状态/请求 UUID，不记录正文或身份凭据），支持无开发镜像的 USB syslog。修复版正在构建/测试，尚未安装、尚未验证不闪退。新构建日志 `build-crash-fix.log`，回调测试 `swift-tests-callback.log`；已有服务器无需再部署。

### 20:17 闪退补丁安装完成，等待真机反馈

- 回调修复版构建通过，Swift 25/25（含 MainActor 构造、后台 Task.detached 调用 reply/error、重复回包不重复 resume）；三个 bundle/dylib 严格签名验证通过。纯逻辑通过不等于实际启动已验收。
- 普通 USB installer 覆盖 iPhone 成功；iPhone appconduitd 明确记录 20:17:44 Watch install done、20:17:46 installed + Installation acknowledged。这是实际手表安装证据，不是嵌入包推断，无需 DDI。
- 安装版 Watch arm64 debug dylib UUID 为 `REDACTED-ID-a752ce30e12b205d`，保留在 `/tmp/aed-watch-relay-20260926.QPyEQO/watch-crash-fixed.debug.dylib` 供后续匹配。旧崩溃 UUID 为 `REDACTED-ID-bce479de9e9e9d7e`，不能用旧报告判定新补丁失败。
- 已请求用户重新打开两端并保持 15 秒，反馈是否仍闪退及页面。当前临时 USB syslog 文件 `iphone-crash-fixed.log`，若结束本轮需停止对应采集进程，不留后台监控。

### 最新结论：实机互联已成立，瞬时断连提示已修正

- 用户确认“不闪退，显示已绑定／连接正常”；服务器只读验证 1 个真实 Watch relay binding（20:18:39），events 仍为 4。近端实际应用消息回执和真实绑定成立；不代表真实 Fall/救助事件闭环已测试。独立 App Attest 在 20:18:32 仍拒绝缺失版本扩展，备用不能标为已可用。
- 用户追加瞬时“配置或上报未完成 / iPhone 不可达且 Watch 无 WAN”弹窗。根因是旧 updateStandbyAvailability 将路径切换写入通用 lastError。已移除此误分类，使用实际消息回执或“WAN+独立授权”计算可用状态；临时离线只内联显示等待连接，保留绑定/队列。也移除了每次 ping 成功就清空所有 lastError 的逻辑，保留真实故障提示。
- 最后提示修复签名 build 通过、三个 bundle/dylib 校验通过、源码边界检查通过，普通 USB 安装 iPhone 完成；20:23:20 Watch appconduitd 已报告 install done。尚无用户对最后这一项提示变化的现场复核。
- 证据集中在 `docs/evidence/watch-relay-2026-09-26/README.md`，根目录和其他工作树脏改均保留、未提交/push；不再使用 DDI/镜像/模拟器或自动触发紧急事件。完成收尾后停止临时 USB syslog，若要继续验收则由用户在真机打开两端。
- 收尾补充：20:24:52 appconduitd 确认最终提示修复版 Watch 已 installed（新执行包摘要）；临时 USB syslog 已停止。下一步仅需用户现场复核瞬时断连不再误弹窗，独立 Watch 认证未通过的边界保持。

## 2026-09-26 非救助真机检查（用户限定单 iPhone + Watch）

- 用户要求全 App 真机业务测试，随后明确只有 iPhone 17 Pro，并选择“先只测登录、定位、Watch 连接等非救助业务”。不得创建模拟/真实救助事件，不得复用历史双机角色授权。继续禁止镜像、Simulator 和 DDI。
- 实际 USB 检查为 iOS 27.2、正式 bundle build 2；不重新安装。线上 current 仍为 `watch-relay-20260926-r1`，服务 active/running、NRestarts=0、health 200。只读数据库仍为 4 个已结束的历史模拟事件，无当前进行中事件。
- 定向确认测试手机有有效设备会话、四项同意、定位/通知 capabilities；20:51:36、20:53:41、20:55:41 有真实新 R 写入。用户第 3 轮确认待命与附近地图/当前位置显示正确，没有所问错误；此结论不等于本轮重新 Apple 登录或后台长时定位通过。
- 用户双前台确认已连接，USB 有真实 Watch 请求及成功回复。用户锁屏测试报告“已绑定 iPhone / 暂未连接”，列为异常待定位；日志又显示 iPhone 20:53:13 入后台后有 3 次成功回复，不能笼统定性“后台完全不支持”，也不能据此关闭用户所见异常。
- 已确认线上部署功能缺口：当前 source/dist 缺少手机已有的 `POST me/push-token`/通知回读路由，手机设备记录没有 pushRegistration；旧服务同样没有 `POST events/found-patient`。本轮仅记录，未补部署、未实际调用救助入口。系统隐去日志 URL 的两条 HTTP 404 不能未经证明就归因到上述接口。
- 第 4 轮已请用户对照地图/列表人数并关闭/恢复范围圈；后续需要用户现场结果。新登录、权限变更、冷启动、持续锁屏定位与网络切换、救助流程均不能标为本轮已通过。
- 详细阶段记录见 `docs/evidence/real-device-business-2026-09-26/README.md`。本轮只新增/更新测试文档，没有业务源码修改、提交/push 或部署；原工作树脏改保留。
- 后续：用户已确认地图/列表人数及范围圈开关全部正常并恢复开启；第 5 轮用户改为只关注 Watch/iPhone 连接，其他界面测试停止、不能标为通过。第一段 USB 日志已结束（15 个系统请求/回复成功，不等同 15 个业务 ACK），摘要保存在证据文档。
- 聚焦连接后的代码结论：手机显示使用 `isReachable` 加近期回执，系统不可达会立即清空确认；普通 Watch 后台可令这一值为 false。当前只接即时 RPC，已有持久 outbox 但没有 WC 后台 transferUserInfo 接收链路。手机没有在入后台时主动 deactivate，Keychain 是 AfterFirstUnlock；尚不能把后台异常定性为其中某个单一根因。已问用户未连接是在手机设置页，还是手机锁屏后 Watch 小字，等待确认后再定向取证；不得用恒定“已连接”掩盖业务失败。
- 重要澄清：用户确认“暂未连接”是在 **手机设置页**，不是 Watch 的锁屏失败反馈，撤回先前据此列出的 Watch 锁屏异常。21:07:46 启动第二段 USB 日志并要求手机锁屏后只看 Watch；基线旧 Watch 绑定于21:00:28过期，故此次可验证后台续绑定，而不止旧缓存 ping。状态文案与业务链路仍须分开验收。
- 定向复测收尾：用户确认 **手机锁屏后，Watch 显示“连接正常”**。21:08:10手机入后台，此后新握手及系统回复出现；服务端21:08:14更新现有 Watch relay，租期从已过期的21:00:28续至21:21:32，手机21:08:35后台新位置也已入库。第二段6个系统请求/回复，结合 Watch 用户确认和服务器更新，本轮锁屏通信/续绑定样本通过；不得外推双端挂起、强制退出或真实跌倒闭环已通过。
- 当前问题收窄为手机“暂未连接”容易把即时可达性与持久绑定/后台业务能力混淆；本轮未改业务代码或UI，不能说已修显示。两个临时 USB 采集均已停止，服务无重启、仍4个历史终态事件；未部署/触发急救/提交/push。其他全 App 用例按用户收窄范围停止，已测/未测矩阵见证据文档。

## 2026-09-26 用户纠正持续连接要求（取代上面的 UI-only 定性）

- 用户明确：只要 Watch 与 iPhone 的系统设备连接条件成立，两端 App 的业务连接就不能因为未打开、退后台、锁屏或息屏而中断。此前把要求理解成前台即时 RPC、把剩余问题仅归为状态文案是理解偏差；不能以更改文案或保留历史绿灯交付。
- 先前21:08的“iPhone锁屏 + Watch前台”通信/续绑定证据保留，但不构成这一更强标准的验收；持续后台连接需求仍未满足。其他非救助检查按用户收窄范围停止。
- 本轮静态确认：两端没有 transferUserInfo/didReceiveUserInfo 后台传输链路；只有 sendMessage 和依赖执行机会的 Watch 心跳/outbox 重试。后端 relay.expiresAt 绑定手机短期凭证，Watch currentRelay 过期即无效，恢复失败会把 isCompanionLinked 置 false 并停止监控。需要传输/会话生命周期修复，而非单独 UI 修正。
- Apple 文档核对：transferUserInfo 已提交的传输可在 App 挂起后继续，isReachable 只代表即时消息可达；这不提供第三方 App 永久常驻、任意时刻即时投递保证。不得把已配对直接等同当前开机/可达，也不得把系统调度限制用来掩盖缺少后台传输实现。
- 持久绑定、监控许可、上传短期授权须分离；后台接收/自动续期/持久队列/最终业务 ACK 和退出账号/撤销隔离需一起设计验证。不准放宽直接 Watch App Attest，不准接受过期 bearer。新要求已写入 `contracts/watch-relay.md` 顶部，原 v1 行为明确标为未满足要求。
- 本轮仅本地检查与官方资料核对、更新上述契约/证据/HANDOFF；未改业务源码、未部署/安装、未新增真机操作或救助事件。原有脏工作树保持，无提交/push。

## 2026-09-26 持续后台连接与同类问题修复（build 4 已安装，真机验收部分通过）

- 用户已明确授权排查同类问题并一并修复，随后确认两台设备在旁、允许继续非救助真机验证。本阶段修改源码，不仅改显示；不使用 Simulator、镜像/DDI，不触发救助，不放宽服务器认证，不发布整个脏工作树。已用普通 USB 安装两端 build 4，未部署服务器、未提交/push。
- 新共享 `ios/AEDResponse/Services/CompanionBackgroundMailbox.swift`：受保护原子磁盘 mailbox，严格 request/reply 封包，固定原始 requestId 的去重/重试、迟到回复恢复、手机持久 inbox/reply outbox、明确授权/账号 owner 控制和单调 revision；App Attest fallbackTicket 不入该队列，Watch 原事件 outbox 仍以最终服务器 ACK 为准。
- 两端 WC adapters 接 `transferUserInfo`/`didReceiveUserInfo` 与 `updateApplicationContext` 控制。Watch 的观察消息在即时发送前先提交系统后台队列；处理 watchOS WatchConnectivity background tasks，并跟踪跨执行器回调完成。iPhone 保留接收器来传达明确撤权，不在退出业务时直接丢掉 delegate。
- 新 `CompanionBackgroundScheduler.swift` 注册 OS BGProcessing 重试；iPhone 进程启动即接好 AppStore/接收器，不依赖 RootView 出现。AppStore 网络/5xx 恢复失败保留凭据并退避，只有明确认证拒绝清理；中转请求自动恢复/续租同一绑定，仍需新鲜手机 bearer 及相同账号/phone/pair/ref。已增加接收时权限复核。
- Watch relay 持久绑定与手机短期 upload lease 分离，不因租期到期或临时 unavailable 清绑定/停监控；明确授权失效被持久化，跨账号控制清理旧传输事务，旧事件事实不删除；第一解锁/存储读取失败可以恢复。UI 分即时“连接正常”和已配置“后台连接”，不把历史绑定当任意时刻实时可达。
- 修改 Models/Ports/AppStore/APIClient/两端 App delegate、两端 runtime/adapters/WatchPersistence/SettingsView/project.yml；新增以上两个 source 文件与 `CompanionBackgroundMailboxTests.swift`，扩展 WatchCompanionLinkTests。XcodeGen 已再生成工程，原 Watch scheme 1.7 修改保留。
- 最终验证：SwiftPM 46/46，覆盖后台握手/事件原样 ACK、重启、租期到期、临时/明确拒绝、账号隔离、存储故障/损坏、队列上限、fallbackTicket 禁入、时间回拨与同账号重新授权。后端定向 companion-link/watch-relay HTTP 19/19。新增 iPhone 冷启动临时失败/明确拒绝测试已 build-for-testing 编译通过，未在真机运行 XCTest。iPhone+Watch build 4 签名构建、三个 bundle 严格验签通过；未把构建/本机逻辑测试算作真机后台验收。
- 物理证据：build 3 在22:26:40手机后台收到 `ping`、22:26:41 `status=ok appState=2` 并提交后台回复；服务器 Watch lastSeen 更新到22:26:41，旧21:21:32过期的上传租期自动恢复到22:41:38。手机当时有22:26:37前台→22:26:38后台记录，不能据此称为系统冷启动或双方全程挂起；Watch当时是否始终停在表盘与后台回复应用层消费仍待确认。
- 收尾代码复核发现 Watch activation 回调可能先结束系统后台任务、后执行异步恢复；build 4 将 activation 同样纳入回调计数并在恢复完成后结束任务，另加无敏感正文的手机后台回复传输完成日志。build 4 已于22:32通过 USB装入 iPhone，22:32:53 appconduitd确认真实 Watch `installed + acknowledged`；手机安装查询明确 CFBundleVersion=4。build 3的真机结果不自动算作build 4全量重测。
- 工作/日志目录 `/tmp/aed-background-relay-20260926.vSYT1S`，当前 DerivedData 是 build 4。最新 `swift-build4.log`、`backend-relay-tests.log`、`build-signed4.log`、`iphone-tests-build4.log`、`install-build4.log`、`iphone-build3.log`、`iphone-build4.log`。详细范围、文件和下一步见 `docs/evidence/watch-background-2026-09-26/README.md`。
- 下一步只做非救助：Watch保持表盘，用户打开更新后的iPhone App一次后锁屏且不划掉，再记录后台消息/回复/租期跨期恢复。不要求反复打开Watch来伪装后台成功；双端长时间挂起、断线自动恢复、后台冷启动和独立Watch直传仍未验收。服务器读数始终4个历史事件、0个ACTIVE，本轮没有新救助事件。
- 安装阶段旧USB日志均已停止；为等待用户锁屏操作，另开仅AEDResponse的限时10分钟采集 `iphone-build4-lock-test.log`（Perl alarm自动停止）。后续先检查该日志/进程，超时则重新启动采集；不要假定长期运行。尚未收到“Watch保持表盘、最新build 4手机已锁屏”的确认。

## 2026-09-26 登录持久化修复（build 5 已构建，未安装）

- 当前请求切换为修复“退出App一两个小时后要重新登录”。Watch双后台长时测试暂不继续。只读线上代码/元数据确认access token15分钟、refresh从明确登录起固定30天；没有放宽认证、部署服务器或创建救助事件。
- 用户于2026-09-27明确“从用户最后一次登录开始计算30天”：最近一次成功登录建立30天窗口，自动换短期访问令牌/关闭App/重启不重置30天；再次成功登录重新计时。现有服务端规则符合，保持固定期限，不做滚动续期、永久凭据或30次使用限制，不需要为此部署后端。
- 已改：共享 `AuthSessionRefreshCoordinator` 跨APIClient single-flight、先Keychain条件原子提交后返回；AppStore刷新结果不再按网络代次丢弃，UI只读已持久值。新本机loginID隔离明确登录与轮换，旧数据自动迁移不改用户/device/pair。可恢复Keychain读取区分暂不可读与不存在；暂时读写失败重试，不清登录。退出先禁止未完成刷新写回，保留已有持久撤销流程。
- 修改：AuthModels、AuthSessionStore、ControlledTestAuthSessionStore、AppEnvironment、APIClient、AppStore；新增协调器与12项测试；扩展AuthenticationArchitectureTests、backend/test/auth.test.ts、ios-smoke测试过滤；XcodeGen工程和生产双端build号5。其他原脏改未重置/提交/推送。
- 验证：SwiftPM12/12、后端auth/companion/relay47/47；iPhone+Watch generic unsigned与build5签名构建通过；iPhone测试包build-for-testing通过（未执行native XCTest）；三个bundle严格验签通过；git diff --check、bash -n通过。两小时/30天是注入时钟本地测试，不是真机闲置实测。
- 日志/产物：`/tmp/aed-login-persistence-20260926.Uh04p7`；当前签名App为 `DerivedData/Build/Products/Debug-iphoneos/AEDResponse.app`。`idevice_id -l`为空、无遗留syslog进程，所以未安装。下一步用户USB连接解锁后普通覆盖安装、保留登录及Watch绑定；不用DDI/镜像/Simulator，不先退出账号。
- 详细证据及剩余网络响应丢失/落盘前终止窗口：`docs/evidence/login-persistence-2026-09-26/README.md`。不能把当前已构建build5说成已在设备生效；上次设备安装仍是build4。只有安全凭据过期、明确撤销或用户退出才应再要求登录；当前实现不承诺应对任意崩溃/丢包都无需重新认证。

## 2026-09-27 build 5 实机安装（覆盖上面的未安装状态，恢复测试进行中）

- 用户明确“可以实机测试”。USB已识别原iPhone，pair validate成功；普通installer覆盖安装完成，设备查询build=5。00:10:13 appconduitd确认真实Watch installed+acknowledged；数据/Keychain未清除，不用DDI/镜像/Simulator。
- 当前只测登录保存/恢复/续期，不主动退出账号、不触发任何救助事件。已请用户打开iPhone App保持15秒，反馈主页面/恢复页/登录页或报错；Watch不用操作。
- 只读服务器基线：检查于2026-09-26 16:09:10Z，当前账号access15:09:13Z已过期约1小时；原登录族起点12:09:31Z，refresh截止仍2026-10-26 12:09:31Z，未撤销。后续比较登录族起点/截止不变及新的refresh/bootstrap，证明自动恢复而非新Apple登录。事件4条、0 ACTIVE。
- 日志目录 `/tmp/aed-login-device-20260927.LRtKWJ`，普通USB logger会话9969（20分钟自动停止，后续先核实存活），installer已退出成功。当前尚未收到打开后的用户反馈，不能把安装当作登录恢复通过。

### 00:13 build 5 首轮登录恢复通过

- 用户明确“已经进入主页面了”；手机新进程18666于00:13:20前台，刷新HTTP200、bootstrap201。服务器只读复核access已于16:13:22Z更新，而登录族起点和2026-10-26 12:09:31Z截止保持不变，无撤销。旧access此前已过期约1小时，这次无需重新Apple登录地恢复通过；事件仍4条、0 ACTIVE。
- 已请求第二轮：从多任务上划关闭App（不点退出账号），5秒后再开并保持15秒，确认仍进入主页面。下一步看新PID/新refresh且同登录族，用于证明新凭据确已持久保存。不要把目前首轮结果当作进程重启或真实闲置两小时的全部验收。
- 临时USB日志当前仍在运行（会话9969、20分钟上限）；不使用镜像/DDI，不调用救助或退出账号接口。

### 00:15 build 5 进程重启恢复通过，本轮实机验证收尾

- 用户按多任务上划关闭→5秒后再开的步骤操作并回复“是”（仍直接主页面）。日志PID由18666变18675，00:14:32新进程启动、刷新200、bootstrap201。
- 服务器16:15:13Z只读复核access issuedAt=16:14:32.919Z、expiresAt=16:29:32.919Z；原登录族起点及2026-10-26 12:09:31.685Z的30天截止不变、未撤销，事件4条/0 ACTIVE不变。证明已收到的新凭据实际保存，并可跨进程恢复，不仅是UI缓存。
- 已完成“旧access过期约1小时后恢复”与“build5关闭进程后再恢复”两项。未实际运行build5连续闲置2小时、跨下一次15分钟自动轮换或30天长测；不要扩大通过范围。剩余响应丢失/落盘前终止边界继续保留。
- 临时USB logger会话9969已主动停止；本轮没有遗留采集任务、无镜像/DDI/Simulator、无服务端部署/写库/退出账号/救助事件、无提交推送。最终记录仍在 `docs/evidence/login-persistence-2026-09-26/README.md`。

## 2026-09-27 当前：Watch起点的受控完整业务模拟（已获实现/部署/模拟授权）

- 用户最新要求“从watch模拟跌倒这一套核心的业务进行模拟”。已明确授权仅指定测试身份的模拟事件，并进一步批准添加仅测试版Watch入口、部署受控模拟接收链路。不要再按之前“仅非救助、不创建模拟事件”阻止当前工作，但真实Fall/SOS/呼叫、外部人员招募仍禁止；不用镜像/DDI/Simulator、不清登录、不发全部脏工作树。
- 当前只有iPhone17Pro+Watch，build5已安装。真实Watch必须是起点，走Watch→iPhone→服务器；不能用服务器管理端直接造事件冒充Watch闭环。患者是真机，响应者用受控HTTP/Socket客户端；完整后台推送、响应者UI/真实走路导航和双真机不能据此宣称通过。
- 已只读核对：线上release仍watch-relay-20260926-r1，服务active；4个历史模拟终态事件、0 ACTIVE；两条测试AED。现有模拟入口是private simulation-admin IPC，只能管理端起事件；Watch生产composition使用CoreMotionFallDetectionMonitor，没有用户可点的模拟入口。
- 实现方向：显式DEBUG+专用编译开关的Watch测试入口，注入SimulatedFall/Call ports，复用FallEmergencyCoordinator、独立受保护测试outbox及同一WC后台传输；模拟观察另走受认证/限时/绑定指定phone-watch的接收路径，再复用createWatchEvent与正常招募/任务状态机，存SIMULATED_TEST标记及嵌套synthetic Watch证据，不假造系统跌倒。服务端严格隔离本次患者、Watch及两名虚拟响应者（N=2才有FETCH_AED），默认关闭。真实Watch独立AppAttest不绕过，模拟直传禁用。
- 部署须从线上现有release制作定向候选，不直接发布本地所有脏改；启用测试开关/名单需限时，完成后关闭并保留审计。虚拟响应者通过既有正常认证、REST/Socket和AED回执流程配合。普通iPhone保持登录/位置权限，不操纵真实急救。
- 工作目录 `/tmp/aed-watch-simulation-20260927.dV6GU0`：已保存前置tracked diff及未跟踪WatchRelayReporter/watch-relay备份。该条最初记录仅为实现前基线；最新进度见下节。

### 01:05 实现、候选与build 6实装完成，尚未启用实机模拟

- 核心源码已补齐，主要文件：后端watch-simulation/simulation/config/service/server/store/watch-event-creation/recruitment-context，WatchControlledSimulationReporter/WatchRelayReporter/Runtime/UI/Persistence，iPhone RPC模型/协议/APIClient/AppStore，以及专门测试与watch-simulation-runner运维脚本。build 6只在显式DEBUG编译开关开启测试入口，默认关闭；普通登录与真实outbox保留。
- 本地后端721/721、Watch逻辑50/50；签名build 6及三bundle严格验签。普通USB实装手机6，Watch appconduitd在01:01:42确认实际安装ack，无镜像/DDI。
- 部署候选基于下载的线上源码移植，仅7个业务源文件+新模块/测试，不发布其它脏改。候选本地与VM check/build及463+4测试通过；旧版不存在incremental-state API，使用旧store接口，不引入本地性能/账户架构改造。
- 当前线上仍为watch-relay-20260926-r1；尚无服务器切换/新测试账号/新实机事件。下一步限定75分钟配置许可，创建两名独立受控响应者并维持HTTPS/WSS，再请用户Watch点模拟跌倒及需要帮助。患者结束需手机UI；不得用管理端直接创建事件替代Watch传输。
- 新事件存嵌套syntheticWatch观察，生成后不能直接回退旧版解析器；关闭许可并保留兼容解析代码，不删除事件。收尾撤测试许可/虚拟会话、恢复普通设备构建、停止USB日志。证据见docs/evidence/watch-simulation-2026-09-27/README.md。

### 01:09 已部署限时许可与两名受控客户端，等待用户打开真机

- current已切换至 `/opt/aedresponse/releases/watch-simulation-20260927-r1`，备份成功、服务active/0重启、公网health200、未认证模拟接口401。两名新虚拟账号已由私有IPC注册并bootstrap，真实WSS均system:ready；不读取患者token。
- runId `REDACTED-ID-e45342f6cfda056d`，expiresAt `2026-09-26T18:22:15.831Z`（北京时间02:22）。phone=REDACTED-ID-c8cc907cc5427d6e，watch=REDACTED-ID-f83602eba67bdca0；两虚拟设备ID只在root私有manifest中。
- 新增配置 `/etc/aedresponse/watch-simulation.env` 与systemd drop-in `90-watch-simulation.conf`；manifest `/var/lib/aedresponse/watch-simulation-20260927-r1/run.json`，credentials同私有目录，不打印。普通base env未修改。受控模拟窗口到期拒绝新请求，收尾需停用配置，不直接回退不兼容旧解析器。
- 交互runner exec session **11152** 运行于SSH PTY，命令可用write_stdin发送 `status\n`、`accept\n`、`navigate\n`、`aed\n`、`arrive\n`、`stop\n`。它仅操作两个虚拟身份，患者结束只能手机UI。当前等待患者新鲜位置；已通过async问用户打开两端、是否看到模拟按钮、暂不点击。0 ACTIVE/历史4条保持。待runner STATE两人WAITING_FOR_WATCH且位置就绪后，才请Watch点模拟跌倒→需要帮助。
- USB logger exec **81203** 输出 `/tmp/aed-watch-simulation-20260927.dV6GU0/device-simulation.log`，45分钟硬截止；手动收尾主动停。signed build6已实际安装两端。Release guard build exec **36342**已BUILD SUCCEEDED（故意传测试变量但Release无DEBUG，也无测试编译条件）；contracts smoke5/5、gitdiffcheck通过。Release未安装，不将该构建等同于已恢复普通真机UI。

### 11:04最新：build8一键模拟已实装；r3两虚拟响应者自动接单，待用户触发

- 用户11点左右进一步要求**测试按钮一次点击直接Watch→手机发送，不再问需要帮助**。已实现，仅DEBUG+AED_WATCH_SIMULATION。新`WatchSimulationInput`给同一协调器提供完整合成NEEDS_HELP场景（不是声称用户真的答过）；正式系统Fall确认流程不改。UI仅按钮/发送中/短状态，异步请求期间禁用按钮。
- build7曾修诊断（HTTP/队列/绑定/存储错误短提示、手机即时RPC方法状态日志）。先前“测试未就绪”的唯一根因没有证据，不声称已定位；随后build7成功。build8实现一键，51 Watch逻辑+2 runner自动接单回归通过，三bundle验签，普通USB11:03:00 Watch实际安装ack，手机version8。签名产物仍在 `/tmp/aed-watch-simulation-20260927.dV6GU0/SignedBuild6`，目录名不等于当前版本，里面已是8。
- r2 `REDACTED-ID-490d19c2c2ba2e5a` 已实机创建：Watch Fall时间02:53:25.416Z，server02:53:29.124Z，SIMULATED_TEST与nestedWatch匹配，手机IPHONE_PRIMARY接管，两个受控offer/WSS、0外部通知。由于我原runner等人工accept，30秒offer都EXPIRED，因此无接单/AED。用户手机明确结束→RESOLVED，5 events/0ACTIVE已核验；不得删除/改写或回填过期decidedAt。r1旧账号两族已正常refresh/logout204，r2 runner已stop并退出账号族。
- 新r3 runId **REDACTED-ID-36e2a481edf82790**，expiresAt **2026-09-27T04:14:20.461Z**（北京12:14）；current服务仍watch-simulation-20260927-r1。仅换限时manifest/env，未发其它代码。r3清单 `/var/lib/aedresponse/watch-simulation-20260927-r3/run.json`，credentials同root0700目录，不能打印。
- 新runner已改成首次heartbeat自动VIEWED+ACCEPT（2项回归），虚拟R位置持久固定（非真实行走），终态识别后退出自身设备/账号。root后台进程 **545587**，不再依赖exec PTY生命周期；FIFO **/run/aedresponse-watch-sim/control-r3**。发送控制：SSH `printf "navigate\n" | sudo tee /run/aedresponse-watch-sim/control-r3 >/dev/null`；还支持`aed`、`arrive`、`status`、`stop`。别重复accept，已自动处理。最多75分钟，患者结束仍需手机UI，不能读取患者bearer代操作。
- runner日志root私有 `.../runner.log` 和 `credentials.json.events.log`（后者是无令牌/坐标的JSONL）；可只读tail。只读审计脚本服务器 `/tmp/aed-audit-watch-run-20260927.mjs <manifest>` 输出本run状态/任务/邀请/外部计数，无GPS/令牌；当前admission只读诊断 `/tmp/aed-check-simulation-admission.mjs <manifest>` 不算真实请求验证。
- **最新用户交互**：已确认r3两个WSS ready和R位置约2秒；已async请用户重新打开两端，Watch只点一次模拟跌倒，手机出现新事件后暂不结束。接下来及时读runner/audit并执行navigate→aed→arrive，让用户检查患者UI，再手机结束，最终关闭测试env/drop-in和全部虚拟会话、恢复普通构建。后台Apple推送/响应者真机UI/真实步行仍不计通过。
- 当前USB logger exec **7984** 写 `device-simulation-build8.log`，45分钟硬截止；需要在手机新进程启动后确认有输出，安装前启动的旧过滤器可能只留下旧PID日志。旧logger73885/74876/75409/76106均已明确停止。完成后主动停当前logger。最新构建日志ios-signed8.log；Swift测试swift-oneclick-r3.log；不要重复旧模拟回合。

### 11:11 r3一键上报真机通过；runner回执顺序修复完成，正等用户结束r3

- 用户已确认build8**一键触发手机出现事件**。USB当前logger7984实际正常（手机PID19705）：11:06:33 simulationContext ok、HTTP201、background+immediate simulationObservation均ok；DB r3只1条（共6/ACTIVE1），nested Watch/source和SIM标记匹配，手机P接管。不是仅UI或本地测试证据。
- 但r3虚拟响应者自动VIEWED漏DELIVERED，被严格后端409拒绝；两offer随后EXPIRED，0 assignments。这是我写的测试runner问题，已向用户说明；没有改业务状态或时间绕过。不要称r3全流程完成。
- **修复已本地完成并验证**：runner `acceptOffer`按wire deliveryStatus执行SENT→DELIVERED→VIEWED→ACCEPT。新真实HTTP测试执行runner实际函数，经本机7/7、VM隔离内存HTTP+线上源码5/5（/tmp/aed-watch-runner-r4-check/results.log）。包括navigate/aed/arrive完整流程，不只是mock。新helper SHA256 **6ded8086a33b18b2484191986bac77aa4f18fa187facd8aaab5c654221330711**，服务器待安装源在 `/tmp/watch-simulation-runner.mjs`；**运行中的r3 PID545587仍是旧代码**，不要直接让它处理新run。
- backend/test/watch-simulation.test.ts新增完整runnerHTTP用例；backend/test/watch-simulation-runner.test.mjs补3步断言并已加入npm test；7项定向通过、tsc通过。修复前full723/723；最新多1项后尚未跑full724。测试候选未改任何生产endpoint。
- **当前待用户输入**：async已请用户手机结束r3（问题已解决）并回待命，之后新r4再Watch单击。没有r4配置/账号/事件。r3应在检测终态后自动设两个虚拟设备available=false、退出设备与账号，日志在private runner.log，先核验TERMINAL/STOPPED、DB6/ACTIVE0。
- 新run工具已准备：`sudo /opt/node/bin/node /tmp/rearm-run.mjs /var/lib/aedresponse/watch-simulation-20260927-r3/run.json /var/lib/aedresponse/watch-simulation-20260927-r4`，只允许旧run过期或事件已明确结束，生成75min新名单/env并备份旧env，不改数据库。之后安装上面的修复helper到 `/opt/aedresponse/current/backend/scripts/watch-simulation-runner.mjs`，比对sha，restart服务，再 `sudo sh /tmp/aed-start-watch-runner.sh r4`（已上传，shell已验证）；r4 FIFO `/run/aedresponse-watch-sim/control-r4`，root日志目录同tag。
- r4自动接单后及时发送 `navigate`→`aed`→`arrive` 到对应FIFO（SSH printf管道sudo tee，属于IPC不是改源码）；每阶段用日志和审计确认再推进。手机患者结束仍需用户UI，不能读取患者token。修复版现已用完整真实接口执行同样命令通过，但真正r4尚未创建。

### 11:17 r3已正常结束退出；修正runner已用于r4，等待Watch触发

- 用户本轮回复“结束成功”。03:14:07Z r3=RESOLVED；03:14:08两虚拟身份设备/账号均SIGNED_OUT、STOPPED，available=false，DB6/ACTIVE0，0外部邀请通知。不是只靠用户口述。
- 新r4 runId **REDACTED-ID-3b66d37c4c411c98**，expiresAt **2026-09-27T04:29:57.638Z**（北京12:29）。manifest `/var/lib/aedresponse/watch-simulation-20260927-r4/run.json`，对应root private credentials/runner日志。已安装hash为6ded8086...0711的修正helper，service active/0重启、health200。
- 第一次runner紧接Type=simple服务启动，在admin.sock尚未创建时ENOENT退出，0账号/0事件；未重复盲启。start helper已加test -S启动检查、FIFO复用及flock防双实例、append日志。确认IPC/health就绪后成功启动，flock父PID547046；虚拟两身份已bootstrap、WSS ready。初次等待手机新鲜位置，不假装定位ready；请用户打开手机前台10秒再Watch单击，让实际GPS/患者位置更新后正常招募。
- 当前r4控制FIFO **/run/aedresponse-watch-sim/control-r4**，同样发navigate/aed/arrive/stop。实时只读JSONL tail exec **89557**（SSH timeout1200秒，日志无坐标/令牌）可用write_stdin空串等新输出，不要等30秒邀请过期；当前runner已自动正确DELIVERED/VIEWED/ACCEPT，无需手动accept。
- 最新完整后端 **724/724**（含新增runner真实HTTP），日志backend-full-r4.log。Watch51和签名build8不变。USBlogger76194/exec7984仍在，路径device-simulation-build8.log，手机19705；45分钟硬截止。
- 最新async问题：请手机前台，再Watch点一次，问新事件是否出现并要求暂不结束。下一步在日志/只读audit确认两接单和角色后即时推进navigate→aed→arrive；最后让用户看手机摘要并结束。未创建r4实机事件前，不称完整流程完成。

### 11:23 r4真机一键/招募/接单/前往患者已完成；等用户结束及虚拟AED授权

- 用户明确确认r4新事件出现。Watch03:18:11.747Z，server03:18:12.030Z，DB总数7、ACTIVE1，SIMULATED_TEST和实际表匹配，手机P接管。03:18:28.536 R1及03:18:32.201 R2均自动正常ACCEPT（无409），两WSS assignment-created，0外部邀请/通知。
- 两任务都是GO_TO_PATIENT，已按正常API `navigate` 03:19:20–21→EN_ROUTE；调查AED后仅按这条合法分支发`arrive`，03:22:03–08两人ARRIVED_AT_PATIENT→COMPLETED，日志VIRTUAL_TASKS_COMPLETE_WAIT_PATIENT_END。**没有FETCH_AED/AED_ACQUIRED**；不要发aed命令并因无异常就谎称通过。
- 具体阻塞已确定：两个现有测试AED（aed-demo-01/02）available=true/24h开放，但离P91.5/91.1km。线上main按AMap key选择AmapAedRouteProvider；只读复用planner诊断，坐标转换10000成功，walking **OVER_DIRECTION_RANGE/20803**，返回UNAVAILABLE/PROVIDER_UNAVAILABLE。没有打印key/URL/GPS，没有改全局AED或切换全局路由。故服务器安全降级两人前往患者，不是人数分配公式错。
- **最新async有2个问题**：①请用户确认手机两人完成状态并结束为问题已解决；②是否允许补充“仅本次模拟可见”的附近虚拟AED，不改真实设备/不对其他人可见，或先到这里。需要等待该新增资源/隔离实现授权，不能默认为改全局AED点位。当前run应仍ACTIVE直到用户结束，先核验日志TERMINAL/SIGNED_OUT/STOPPED、DB7/ACTIVE0。
- helper及当前服务不变；r4 FIFO控制路径见上；tail进程exec89557仅只读，USBlogger76194。如用户选停止，须关闭test env/drop-in并重启、停临时logger，是否恢复普通绑定版需结合用户接下来要保留测试入口的意愿，不把后台真实SOS/实际行走/双真机/APNs列为通过。若用户准许虚拟AED，这是新的实现阶段，先基于实际已部署版本设计事件级隔离；不能直接发整个脏工作树。

### 11:29 用户质疑后台触发；仅诊断，已复现测试入口未续接的缺口

- 用户当前问题是“为什么必须手机前台，Watch检测后手机后台岂不是不能触发，是否又是昨日问题”。优先回应/检查后台，不继续扩展虚拟AED或创建新事件。本轮未改业务源码、未部署、未触发实机事件；仅只读代码/日志/现存r4状态及一个临时本机确定性诊断测试。
- Apple官方确认Watch sendMessage可唤醒可达的iPhone到后台；transferUserInfo支持系统后台队列，但不是零延迟/进程常驻保证，用户强退另有限制。不能把普通锁屏/后台当必须手动打开App的理由。
- 当前正常生产路径已有：AppDelegate didFinishLaunch初始化ApplicationRuntime.store；AppStore.init先配置/activate WC receiver；Watch观察先排系统队列再尝试即时消息；手机持久inbox/BGProcessing/短期background assertion；Keychain AfterFirstUnlockThisDeviceOnly。源码没发现单纯依据applicationState==active才准上报的门禁，但这不能替代完整后台事件实测。独立Watch AppAttest直传仍未验收。
- 最新真实日志分清：11:19:59 ping在appState=2成功；11:06及11:18的simulationObservation虽方法日志叫background，但**appState=0（前台）**。因此仅证实后台通信、前台完整事件创建，不是锁屏/后台跌倒链路已验收。
- **具体代码缺口**：WatchControlledSimulationReporter.prepareFall先await relay.simulationContext，再存session/fallDetectedAt；Runtime.simulateFall直到prepare成功才调用coordinator.receive。通道只有后台排队时会throw .queued，被按钮Task catch后结束；后续onBackgroundData只retry已有事件，没有保存该次点击的待处理意图，也不会自动重新调用prepareFall。新增测试入口因此有“触发前等往返授权”的依赖，与正常已落盘观察的重试不是同一件事。
- 已在临时SwiftPM的WatchCompanionLinkTests内加**诊断用**testDiagnosticQueuedSimulationPreparationDoesNotResumeOriginalClick：先建立仅后台握手→准备点击排队→没有fall/session/outbox事实→送达授权回复→正常coordinator.retryPending仍为空→只有显式再prepare才进入。11:28:48本机1/1通过，日志 `/tmp/aed-watch-simulation-20260927.dV6GU0/background-click-diagnostic.log`；它断言并证明当前缺陷，不是修复验收。该测试只在/tmp副本，未写入canonical测试文件。
- 下一步需要解决“点击意图先持久化/授权回复后自动续接”或预先配置测试授权，仍不绕过服务器授权；再以手机锁屏/后台/会话过期/短断线四种条件验证最终服务器ACK。当前用户只问原因，尚未在本轮实施修复或开展设备试验。03:26只读r4仍ACTIVE，两虚拟任务COMPLETED，是否结束需用户确认。

## 2026-09-27 后台触发与锁屏通知补齐（代码/候选已验证，等待 APNs 密钥与 USB）

- **最新目标与授权**：用户要求补齐上述缺块；同意正式文案的原生锁屏通知方案，去掉视觉稿测试字样，但实机受控事件仍保留 SIMULATED_TEST，不冒充真实救助。用户允许协助新建 APNs 密钥，不撤销旧密钥。仍禁止镜像、Simulator、DDI、真实 Fall/SOS/外部联络；只有当前一台 iPhone + Watch。
- **上一轮收尾**：用户明确结束 r4；03:45:47Z 只读核验 r4=RESOLVED、7 历史事件/0 ACTIVE、两虚拟响应者不可参与、0 外部邀请/通知。没有新建 r5 或任何新救助事件。r4 配置自行到期，不能继续用它做新一轮。
- **已改客户端**：WatchSimulationIntent 先于网络落盘；背景授权回复/重建 reporter 自动续接；保持原点击时间、身份、限时 run；coordinator 不重采样覆盖已经保存的 outbox。iPhone 新增 EmergencyAlertPolicy / EmergencyNotificationService：接收和服务器确认分开，后台系统通知、去重、账号清理、通知冷启动后 REST 回读；不在锁屏结束事件。CompanionRelayAPI 返回含 state 的服务器 ACK，终态不会重新显示活跃。REST 恢复、presence、事件位置发送不再等 Socket connected；权限、账号、设备会话和 REST 窗口仍受保护。
- **已改后端**：实际 node:http2 APNs 客户端；短文案/Time Sensitive/过期/APNs collapse；业务阶段去重，坐标 tick 不推送；token 登记返回 providerConfigured，防止“存下 token=远程提醒已就绪”。Socket 完成证据保持不可变，但允许独立推进 push 重试。后台 push worker 与业务 ACK 分离，慢 APNs 不能阻塞 Watch HTTP 确认。源码的 push-provider / push-presentation / notification-schedule / notification-outbox / service / store / models 等均涉及本次改动，勿整体回退已有 dirty edits。
- **视觉**：用户已确认“按这版实现”。图与最终编辑 prompt 在 `docs/design/lockscreen-2026-09-27/`；是设计图不是实机截图。没有制作 Live Activity/全屏锁屏替代界面，不承诺强制突破静音和勿扰。Apple 默认通知路由到 iPhone 或 Watch（不是同时两端响），验收需分开判断。
- **验证**：SwiftPM 56/56；后端最终完整 **728/728**（含慢 APNs/HTTP ACK 回归），最新定向 24/24，`backend-nonblocking-full.log`。iPhone+Watch Debug build 9 签名构建通过，Xcode 成功更新 Time Sensitive profile；最新 `signed-build-final2.log`，三 bundle 最终严格验签通过。iOS TestHost/XCTest `build-for-testing` 成功，`tests-compile-final.log`，未运行设备 XCTest。Release 构建通过（最新 `release-final.log`，显式模拟编译条件也无 DEBUG 入口），contract smoke 5/5；未装到真机，未验收锁屏到达。
- **工作目录**：`/tmp/aed-background-lockscreen-20260927.bSiSbg/`。所有上述日志在此。最新签名 app：`Signed/Build/Products/Debug-iphoneos/AEDResponse.app`，独立 Watch 同 `Debug-watchos/AEDResponseWatch.app`。
- **服务器只准备候选，尚未部署**：`candidate/` 从原 live 对应 `watch-simulation-20260927-r1` snapshot 回移，保留旧存储/账号删除/登录固定 30 天行为，不发整个 canonical 脏工作树。候选原 463/463 +新增定向 24/24 全通过，`candidate-final.log` / `candidate-nonblocking.log`。回移源差异仅通知接线/兼容和 controlled run startsAt 校验；原线上还有独立脚本 runner 最新 SHA `6ded8086a33b18b2484191986bac77aa4f18fa187facd8aaab5c654221330711`，发布时必须保留它，不能让旧 candidate 覆盖。线上仍 `/opt/aedresponse/releases/watch-simulation-20260927-r1`。
- **当前阻碍**：用户说已有 p8 但不知道路径；已搜索 Mac 常用/隐藏目录与服务器 `/etc/aedresponse`、用户目录，未找到私钥，线上无 AED_APNS 配置。CUA 创建 Apple 后台页/取页/取 inventory 连续各 30 秒超时，自动重置也无恢复；没有创建/下载任何密钥。已异步请用户自己打开 Apple Keys，创建 `AEDResponse Push`，仅 APNs、Sandbox、Topic Specific、`dev.codex.aedresponse`，下载后回复“已下载”，不贴密钥正文。用户已授权新建，不再重复问笼统权限。
- **USB**：最近 `idevice_id -l` 为空，已异步请用户接回解锁的 iPhone 和邻近 Watch；不能说 build 9 已安装。浏览器控制是否恢复要有新信息后再试，不无意义重复超时。
- **下一步**：等 p8 下载/USB → 只读验证文件类型/Key ID/Team，不输出内容；安全放项目外和服务器 `/etc/aedresponse`、仅服务用户可读；Sandbox 配置（开发签名）→准备当前 SQLite 备份与兼容回退包→限定部署候选→确认 push 注册/受控 APNs →普通 USB 安装 build9 并确认 Watch installed/ack →仅手机锁屏、真实 Watch 一键触发新隔离 r5。最终要对齐 appState=2、服务器 SIMULATED_TEST、Watch ACK、通知实际呈现、解锁页面；再做 access 过期/短断线/重复传输。不得把 build 或本机 HTTP 测试当实机验收。
- **回退约束**：新 push 字段/状态被持久化后，旧严格 NotificationRecord 解析器不兼容；不能只切回旧 symlink，也不能倒回数据库抹掉新证据。准备保留新解析器的旧行为回退，或关闭 APNs 配置但保留本版解析器。独立 Watch App Attest/WAN 仍未验收；r4 没有 FETCH_AED，不把完整 AED 回执/实际行走/双真机算通过。
- 详细证据与系统边界：`docs/evidence/watch-lockscreen-2026-09-27/README.md`。没有提交、push、PR、真实救助或未经确认的正式上架发布。

## 2026-09-28 登录与启动视觉调整（此前视觉阶段，已获准实现，结果见下节）

- **最新范围**：用户暂不连接手机，剩余业务/APNs/部署/实机测试暂停。当前只处理登录语言、深色 Apple 按钮、协议移到按钮下方、删除底部说明、去掉顶部红色图标、整体居中、缩小勾选框并把协议文字改蓝色，以及启动心电装饰动画与紧急跳过。
- **视觉门禁**：首版用户选择“需要调整视觉”；最新居中/蓝色/小勾选框稿待确认，不是用户已批准实现。按用户此前“先出图、同意后重构”，本轮没有改 SwiftUI、项目配置、登录/救援逻辑。
- **已确认源码原因**：AuthView 的原生 Apple 按钮固定 .black；项目只声明 en 而登录页硬编码中文；顶部红色图标、协议上置和底部说明仍在源码。修复时保留四项独立默认不勾选、nonce/challenge/协议版本校验，不改法律正文或版本。
- **心电彩蛋结论**：Apple HealthKit 只能读取已录制 ECG，实际测量需用户操作 Digital Crown 约 30 秒；按用户“不行就放弃”不实现自动真实心电图，不申请额外健康权限，不把心率或历史波形伪装成实时 ECG。
- **启动检测待实现**：普通前台冷启动才可播放；紧急通知、Watch 待处理跌倒、患者事件/响应任务/邀请优先；播放中紧急信号立即撤掉并锁存跳过，恢复状态不确定时保守跳过，不等网络或延迟 WC/REST。当前还没有动画或该跳过策略的实现，不能宣称检测通过。
- **产物与验证**：`docs/design/login-launch-2026-09-28/` 保存最新概念稿、分镜、完整编辑提示词与待实施规格；使用内置 imagegen。已源码核对、官方文档核验、设计图人工检查；没有构建或设备测试。设计图不是实机截图，分镜不是可播放动画。
- **下一步**：用户确认最新视觉后，最小范围实现本地界面、本地化和紧急优先启动策略，补策略测试并编译；真机验收等用户接回手机。禁止镜像/Simulator/DDI/真实 SOS，保护整个 dirty worktree，不提交、不推送、不部署。

## 2026-09-28 登录 UI 与紧急优先启动：本地实现完成

- **授权与范围**：用户对居中/小勾选框/蓝色协议最后一稿明确回复“按这版实现”，同时批准启动动画的紧急跳过；真实 ECG 彩蛋放弃。其余业务、APNs、部署、实机测试仍等手机接回，没有恢复执行。
- **登录**：AuthView 去掉红图标与底部说明，内容在安全区域内整体居中并支持短屏/大字体滚动；原生 Apple 按钮浅色黑/深色白；协议下置、蓝色、18 pt 框/44 pt 点击区。共享 checkbox 的其他消费者保留原大小/色彩。en/zh-Hans Login.strings、project.yml 和生成工程/三个 iOS Info.plist 补齐语言声明；常见 AuthError、Root 恢复/错误提示本地化。未翻译整个业务 App 或改法律正文/版本。
- **启动**：新增 LaunchPresentationPolicy、LaunchECGView，0.8 秒线条 +0.2 秒淡出，只属 UI；ApplicationRuntime.store 和后台业务启动不等待动画。Root 接入场景、恢复状态、事件/邀请/任务、Reduce Motion/VoiceOver 检查；通知入口、Watch 即时/后台收包在 REST 前锁存 skip，播放中立即撤掉，后台返回不重播。CompanionRPCServing / DeviceServices / CompanionBackgroundMailbox 补上排队或不可读/不可写时的保守跳过；这些信号不授权救助操作。
- **保守策略**：已登录冷启动如果身份或服务端事件尚未恢复，就直接跳过而不是等网络后补播；这不是动画失效。默认未知队列状态也跳过。系统静态 Launch Screen 不属于该动画，不能承诺消除。
- **测试与构建**：本机 Foundation/Watch 回归 **72/72**（本轮启动 9、语言 3、邮箱新增 4）；Debug/Release iPhone+Watch generic SDK 均 BUILD SUCCEEDED，CODE_SIGNING_ALLOWED=NO；AEDResponseUnitTests TEST BUILD SUCCEEDED，新增 3 条 AppStore 入口集成测试只编译未执行。plutil、bash -n、本轮 diff --check 通过；认证结果/协议版本、nonce/issuer、四项同意 predicate 与本轮前快照一致。构建包验证了两份 Login.strings 和 zh-Hans 开发语言，不把这些证据当作原生按钮/锁屏真机验收。
- **修改文件**：Views/AuthView.swift、Views/RootView.swift、Views/LaunchECGView.swift；Application/LaunchPresentationPolicy.swift、AuthModels.swift、Ports.swift；App/AppStore.swift；Services/RemoteNotificationService.swift、DeviceServices.swift、CompanionBackgroundMailbox.swift；Resources/{en,zh-Hans}.lproj/Login.strings；project.yml/生成工程/三个 iOS Info.plist；LaunchPresentationPolicyTests、LoginLocalizationTests、AuthenticationArchitectureTests、CompanionBackgroundMailboxTests、scripts/ios-smoke.sh。App/AEDResponseApp.swift 本轮未改，既有后台接线保留。
- **产物**：`/tmp/aed-login-launch-20260928.kSc2NF/`（baseline 为修改前文件快照，Build 为未签名构建，swift-tests 为本机 Foundation 验证包；debug-build.log/release-build.log/tests-compile.log/swift-tests.log）。图、规格与验证命令已更新至 `docs/design/login-launch-2026-09-28/README.md`。
- **下一步与约束**：用户连接手机后才签名/普通 USB 安装并核对语言、深浅色、居中/大字体和紧急跳过，再另行继续前述 APNs/后台业务验证。本轮没有安装、服务器变更、真实救助、提交或推送；不能覆盖此前 build9 尚未安装与 APNs 缺密钥的边界。保持用户 dirty worktree，不启动镜像、Simulator 或 DDI。

## 2026-09-29 无线测试准备：build 10 已签名，手机连接中断，尚未安装

- 用户说“开始”，恢复测试准备；先非救助，不触发新事件。普通设备通道一度 USB=1/network=0；已读取 iPhone18,1、iOS27.2、安装 AEDResponse 2.0(build8)。CoreDevice 手机 connected、Watch available(paired)，不能把该状态称为 Wi-Fi 业务通过。
- 9月28最新 build9 未签名，9月27已签名 build9 不含最新 UI，因此本轮将 project.yml iPhone/Watch 版本改为10并重新生成工程，仅版本号改动。全新目录 Debug 签名构建成功，显式 AED_WATCH_SIMULATION_CONDITION=AED_WATCH_SIMULATION 保留受控入口；未开启模拟 run。iPhone/内嵌Watch/独立Watch严格验签通过，均build10；profile包含目标手机，手机Time Sensitive、Watch Fall Detection权限有效。
- 构建后设备查询返回 Device not found，复核 USB=0/network=0。**没有执行安装，手机最后读到仍是build8，不能说build10已经装好。** 已异步请用户接回USB并解锁，保持至安装完成后再拔线；只能Wi-Fi则提供手机IPv4地址，不进行网段扫描或猜测设备IP。用户先前事件状态问题已由服务器 ACTIVE=0 解决。
- 独立只读检查线上：current仍 watch-simulation-20260927-r1；aedresponse/caddy active、NRestarts0、内外health200；SQLite只读聚合7历史事件/0 ACTIVE/0未知状态；运行进程AED_APNS_*为0，配置未出现对应变量名称。未部署、重启、写库、推送、注册测试身份或创建事件。
- 产物 `/tmp/aed-device-test-20260929.dWAcaY/Signed/Build/Products/Debug-iphoneos/AEDResponse.app`，Watch同Products下Debug-watchos。日志build-signed10.log，baseline保留版本修改前配置。详见 `docs/evidence/wireless-test-2026-09-29/README.md`。
- 下一步从“重新确认普通通道→覆盖安装build10→读回手机版本/Watch installed证据”继续，保留登录数据；之后非救助检查再拔线测无线/后台。APNs/后端候选和新隔离run仍是完整救助测试前置条件。没有镜像、Simulator、DDI、真实Fall/SOS、提交或推送；没有遗留持续日志采集任务。

## 2026-09-30 build10 已安装到 iPhone 和 Watch，等待非救助启动反馈

- 本节覆盖此前“build10尚未安装”。用户说“继续”，USB重新可用，手机安装前为2.0(8)，network通道0；没有声称是Wi-Fi安装。
- 原9月29 `/tmp`签名包已不在原路径。以现有源码/build10重新构建；第一次桌面项目 `.build/DeviceAcceptance-10.VGl3Ph` 的 Watch bundle 带 FinderInfo/fileprovider 属性，CodeSign 失败。仅更换到非桌面缓存目录后正常构建成功，未改业务代码/证书/profile，也未清理全项目xattr。三bundle严格验签通过，手机profile匹配本机目标、Time Sensitive，Watch Fall Detection有效。
- `ideviceinstaller install` 普通覆盖更新 exit0/100%；随后单独查询手机实际 **dev.codex.aedresponse 2.0(10)**。Watch11:01:03占位符不是成功；11:01:14 Finished install，11:01:15 installed+acknowledged。回执可执行hash **406df8b22ea90b9203a4dbd6043b161e8b58c5d5f110a74b58250e9b8bd546c7** 与独立Watch build10二进制SHA256一致。
- 产物现在保存在 `[BUILD_CACHE]/build10-20260930.iIvOdD/`，其下 `Signed/Build/Products/Debug-iphoneos/AEDResponse.app` 是已安装包；日志build-signed10.log/install-build10.log/watch-install.log。旧/tmp路径不可继续当现存产物使用。
- 当天服务只读核验仍是 watch-simulation-20260927-r1、active/running、NRestarts0，7历史事件/0 ACTIVE（主任务独立复核exit0）；APNs配置仍不存在，未发布通知候选、未新开模拟run。旧/tmp候选后续需重新核实是否还存在，不能默认为可直接部署。
- 已异步请用户**保留数据线，先在iPhone与Watch打开AEDResponse约15秒，不点模拟跌倒**，回复手机是否直达主页面、手表是否正常。当前仅安装通过；启动/登录恢复/新界面/实际消息/双后台/无线/锁屏均未据此打勾。之后才安排拔线和锁屏。
- appconduitd安装日志采集已主动停止。正在进行的独立限时通信采集仅筛选AEDResponse的 reply method，文件connection-replies.log，最多180秒、超时自动终止；启动时PID7756、exec session53157，后续先检查是否已退出，不能复用过期采集时间窗。
- 本轮只更新交接/证据文件，没有源代码新改动、提交、推送、服务器写入或真实Fall/SOS；不使用镜像、Simulator或DDI。证据更新于 `docs/evidence/wireless-test-2026-09-29/README.md`。

### 2026-09-30 build10 启动已确认，开始明确锁屏回合

- 用户回复手机直接主页面、Watch正常打开；补充“手表是模拟跌倒”，已说明是测试版入口，不是触发结果，不要点击。无需再问是否安装/能否打开；还不能由此确认新登录页外观（用户已登录，未主动退出）。
- 首轮connection-replies.log：11:03:59–11:04:01出现ping unavailable；11:04:01.884背景投递路径appState0 ok、11:04:04/20即时ping ok；11:04:38.105背景ping **status=ok appState=2**。证明一次手机后台收发成功，不代表持续连接/锁屏回合/无线网络接口已完整验收；初始unavailable没有唯一根因日志，不直接判定前台依赖。
- 首轮采集已结束，exec53157已回收。第2轮只采reply method，文件同缓存目录lockscreen-replies.log，PID8143/exec72346现已停止、退出0。统计11条reply、7条background ping ok appState2、0非ok，首末后台样本11:06:21.097890至11:09:00.834531。注意这证明手机处理并生成回复，日志未给Watch消费确认；immediate/background可能是同一请求，不能算11个独立往返。用户仅反馈模拟页看不到连接状态，不能凭手机appState反推精确硬件锁屏时长或Watch场景。

### 2026-09-30 用户选择保留模拟入口，继续非救助日志测试

- 用户明确选择“保留模拟入口，用日志继续测”。不换普通绑定构建，不加新UI，也不要求其寻找被DEBUG模拟分支隐藏的连接小字。仍不能点击模拟跌倒：本轮无新隔离run，旧r4已过期。
- 第3轮已异步请求：USB暂留/Wi-Fi开启，iPhone保持锁屏，Watch回表盘45秒再只打开Watch20秒，手机不解锁、不划掉App，不触发事件，完成后回复已完成及弹窗。等待用户动作反馈，不把当前采集自动当验收通过。
- 第3轮采集目录仍为build10-20260930.iIvOdD：`resume-replies-1790737919506.log`，11:11:59开始，PID8808/session60496，上限300秒；`resume-transfers-1790737945805.log`，11:12:25开始，PID8934/session35853，上限240秒。普通idevicesyslog只采AEDResponse固定状态字段；完成后停止目标进程并回收session，超时需要新的采集窗口。
- 已查本地AppStore `.ping`：requireBinding缓存有效时直接返回，仅缺失/临近到期才调用bindWatchRelay。子任务只读复核的11:09:07快照中，既有两端关系存在且未撤销，phone lastSeen11:09:01.657、Watch lastSeen11:04:01.571、租期11:19:01.021；此快照不能逐条证明当前ping、更不能证明Wi-Fi接口。未输出ID、令牌或坐标，未写服务器。

### 2026-09-30 第3轮已得到后台恢复及系统回复传输完成证据

- 用户回复“已完成”。实时reply日志在11:16:56捕获ping ok/appState2；两个采集已到时正常退出并回收session60496/35853，截止分别11:16:59、11:16:25。transfer日志提前结束，不能将空白解释为失败。
- 普通idevicesyslog archive从11:16:30回读成功，未用DDI。用本机log show限定11:16:30–11:19:30、subsystem AEDResponse/category CompanionRelay/固定安全字段：4条background receive ping、4条background reply ping ok、4条background response transfer succeeded=true，全部appState2；另3条immediate ping ok。脱敏原文字段在 `docs/evidence/wireless-test-2026-09-29/background-resume-20260930.log`。手机日志证明后台，Watch回表盘/重开由用户操作确认；无requestID，不作严格逐请求配对，不称Watch消费/跌倒服务器ACK/拔线已通过。
- 现成“最近消息确认”UI不能单独验收拔线窗口：DeviceServices复用saved reply仍recordVerification(Date())，旧回复重投也可刷新；没有请求历史。子任务只读定位，未改行为，不用该时间替代通信日志。
- 下一步可测拔线后回表盘/重开Watch、手机仍锁屏，随即接回USB回读短期历史；必须记录拔线/重接窗口，不把USB管理日志或ping本地缓存叫作Wi-Fi服务器通信。继续非救助、不改模拟UI/源代码/服务器。
- 回读产生的私有缓存 `relay-logcheck-20260930.Rci8iD` 内全设备tar及展开的phone.logarchive已按精确路径删除，不留恢复副本；项目只保留18行脱敏App记录。未修改手机数据。11:25:32及随后复核普通USB/network均0；尚未下发第4轮步骤，也没有有效拔线起止窗口。先请用户确认是否主动拔线，不能把设备管理掉线认定业务断线。当前没有持续采集进程。

## 2026-10-01 非救助拔线测试已得到手机后台通信证据

- 用户说“继续”。13:29普通USB发现原目标手机，network0；独立installer查询仍AEDResponse2.0(10)，无需重装。保留模拟页面，不改业务源码，不触发事件，不用镜像/Simulator/DDI。
- 13:30:30子任务只读核验：SQLite7历史/0ACTIVE；服务active/running、NRestarts0、release仍watch-simulation-20260927-r1；指定APNs配置变量全不存在。SSH与子检查exit0，无服务器写入。
- 第4轮用户已回复“已接回”：手机Wi-Fi/蓝牙开启且锁屏，不要求先打开手机App、不划掉进程；拔USB，Watch回表盘45秒、只打开Watch20秒，不点模拟跌倒，然后接回USB。用户未报告弹窗。
- 临时私有缓存 `[BUILD_CACHE]/wireless-20261001.k2MGLg/`。只读诊断helper `capture-unplug.cjs` 经node --check并已启动；exec session54468，13:30:57开始，最多等600秒。每2秒普通USB inventory只输出目标存在变化，timeline是usb-window.jsonl；发现拔线再接回后自动普通idevicesyslog archive（45秒上限）回读firstAbsent前5秒起的短期历史到phone-recent.tar，然后退出。只查询和回读、不启动App/推送/救助。
- 本轮timeline：firstAbsent13:31:44.222、lastAbsent13:33:03.018、returned13:33:05.030，archive13:33:20.432完成。session54468已exit0并回收，无持续采集。保守筛选13:31:50–13:32:58内、AEDResponse/CompanionRelay四类固定字段：共11行；2条后台receive、3条后台unavailable、2条后台ok、2条transfer succeeded=true、即时unavailable/ok各1。13:32:33.361及13:32:45.394后台ok，随后的系统transfer均成功，全appState2，明确早于接回USB。
- 本轮结论：无USB时手机后台接收/处理Watch消息和系统回复传输通过；手机硬件锁屏/Watch退后台重开依用户步骤确认。初始unavailable至首个后台ok为2.586秒，自动恢复；固定gate前缀查询无结果，不能唯一归因认证/网络。无requestID，不能严格独立往返去重或确认Watch应用层消费；不是Wi-Fi独占选路/服务器ACK/真实跌倒/锁屏通知验收。
- 脱敏记录已保存 `docs/evidence/wireless-test-2026-09-29/unplug-background-20261001.log`，README顶部已补10月1结果。本轮不必再次重做基础连通性；下一项是隔离锁屏模拟跌倒与通知，需先恢复有效测试前置条件，不能直接使用过期r4或在APNs未配置时声称完整锁屏提醒通过。
- 子任务独立读取相同窗口，确认11条记录分类与USB时间线一致；两边命令均exit0。所见2.586秒只是首个不可用至成功的日志间隔，不是完整业务恢复耗时。校核后已精确删除本轮缓存的phone-recent.tar和phone.logarchive，不留恢复副本；仅保留脱敏App日志、USB时间线和诊断helper，未删手机数据。采集已结束、没有持续进程；diff --check通过。没有App源码改动、安装、服务器变更、事件或推送。

### 2026-10-01 13:41 继续锁屏业务前置检查，待APNs密钥

- 用户继续，现推进锁屏模拟跌倒与通知，不重复基础ping。当前USB有目标设备、network0；本轮没有新安装、触发事件、部署或改App源码。按最新指令不再主动委派子任务。
- 主线程重新只读核验线上：7历史/0ACTIVE，current仍watch-simulation-20260927-r1，active/running、NRestarts0；进程五个指定AED_APNS变量均不存在。r4的正确到期字段在 **manifest.run.expiresAt**，值2026-09-27T04:29:57.638Z，确认过期。首次误读顶层expiresAt得到缺失值，不使用NaN比较的false作为有效性结论；未读credentialsPath指向的文件，也未输出ID/密钥/位置。
- 下载/桌面目标文件名搜索无.p8结果；浏览器cua.getState本轮再次30秒超时并重置，无成功页面读取或点击。open_in_codex请求打开Apple Keys页面仅返回queued，不宣称页面已实际打开或登录。没有创建/下载/撤销密钥，不重复超时重试。
- 用户此前已授权协助新建APNs密钥。现已async请其手动在Apple Keys创建“AEDResponse Push 2026-10”：只勾APNs，Sandbox、Topic Specific、dev.codex.aedresponse，下载到Downloads，回复已下载或提供无秘密的选项截图；不要求私钥正文/密码/验证码，不撤销旧密钥。当前build10签名包的aps-environment实际读回development，支持该Sandbox选择。官方现行说明已查：https://developer.apple.com/help/account/keys/create-a-private-key/ 。
- 原 `/tmp/aed-background-lockscreen-20260927.bSiSbg/candidate` **现已不存在**，9月27的候选测试只是历史证据，不能说当前仍有可直接部署包。源码实现仍在canonical脏工作树；拿到密钥后须从当时/当前线上基线重整通知限定候选，重新测试并准备兼容新push字段的回退方案，不能整树发布或只切旧symlink。
- 下一步先等待密钥下载；验证只输出格式/标识检查结果，不打印私钥。EC/P256格式验证本身不能证明APNs权限，必须结合Apple配置及实际受控APNs回执。新模拟run需要有效隔离配置和确认，不能用过期r4；当前没有持续采集进程。
- 13:43用户提供Key ID **26ZG85W23U**，尚未提供.p8路径。Downloads包含隐藏文件的.p8/该ID文件名搜索无匹配（exit1无错误输出）；不能凭Key ID说已拿到私钥或APNs权限已验证。用户当前浏览器URL为Apple authkeys/add，尝试按该现有URL读取仍30秒超时并重置，未操作下载按钮。下一步请用户下载对应 `AuthKey_26ZG85W23U.p8` 至Downloads，或告知实际安全路径；不要求私钥正文，不新建第二把或撤销现有密钥。

### 2026-10-01 13:55 密钥已提供，通知限定候选重建通过本地验证

- 用户提供 `/Users/REDACTED/Downloads/AuthKey_26ZG85W23U.p8`。只在内存createPrivateKey校验：EC/prime256v1、签名自检通过；原权限644已收紧为600，原文件保留，未输出正文/签名令牌，也未放进repo。签名App实际TeamIdentifier=[TEAM]、aps-environment=development；KeyID只是用户/文件名提供，APNs权限仍待实际请求验证。
- 工作根 `[BUILD_CACHE]/apns-candidate-20261001.N2KoQ3/`；`live/`是重新从线上watch-simulation-20260927-r1读取的backend源码/测试/package快照；`candidate/backend`是独立修改副本，node_modules临时链接canonical Mac依赖。`candidate/contracts`来自线上，补了Watch relay既有路由与本次push契约。没有canonical App/后端源码改动、没有线上写入/部署/密钥上传。
- 候选基于旧线上存储接口做通知限定回移：新增apns-http2/push-provider/push-registration/push-presentation/notification-schedule；改models/contracts/store/identity-access/notification-outbox/service/server/main及watch-simulation开始时间校验。没有拷贝canonical认证/位置/存储整体重构，不改固定登录30天行为。线上runner最新hash6ded8086...0711已确认并复制到candidate/backend/scripts；测试helper在backend/deploy/azure。
- 回移过程参考本线程9月27工具调用（rollout行6181/6197/6217/6416）重新生成apply_patch，所有插入锚点已在当前基线核对，不盲执行旧脚本。未引入旧线上不支持的退出救助/reroute通知名或SIGNED_OUT字段。
- 本地当前候选：build成功；push/watch-simulation定向 **24/24**，`push-focused.log`；原线上完整套件 **463/463**，`full-regression.log`；限定契约smoke **5/5**，`contract-smoke.log`。这些不是APNs或锁屏真机证据。再次build+源码白名单tar正在收尾，输出notification-candidate.tar.gz；包不含node_modules/密钥/env/数据库。
- 下一步在服务器独立候选目录复跑编译和测试，核对通知持久化兼容与备份/回退。若切换后已有新push字段，只能保留新解析器并禁用APNs接线回退，不能简单切旧symlink或倒回DB。切换前重新查ACTIVE=0；新隔离run、真实APNs投递及手机锁屏观察尚未执行，不沿用旧r4。

### 2026-10-01 14:03 通知候选已发布，正在解决服务账号读钥路径权限

- 服务器stage `/var/tmp/aed-apns-20261001.d9McHw`（700，azureuser）；候选源码tar SHA256 `21441d1979ccc38fd38065c9fd74a573629b514925882f6070b47e29b0d66c80`。VM build、定向24/24、full463/463、契约5/5全部通过（日志在stage根）。保留原runner hash6ded8086...0711；Linux node_modules复用旧release绝对symlink，不含Mac依赖。
- 已创建SQLite一致性备份 `/var/lib/aedresponse/backups/pre-apns-20261001-26ZG85W23U.sqlite`（600，integrity_check=ok）；候选SQLiteStateStore在stage的validate-state.sqlite副本成功读取7历史/0ACTIVE。原备份未作为候选读写文件，没有清理旧备份。
- 依此前部署授权，切换前再次ACTIVE=0、旧release一致。新current `/opt/aedresponse/releases/lockscreen-notifications-20261001-r1`，systemd重启后active/running/NRestarts0；本机/公网health200。只拷贝白名单代码/编译产物/contracts，未发布canonical整树；没有新事件、新run或APNs投递测试。
- 私钥通过SSH上传到stage，验证600/P256；安装到 `/etc/aedresponse/apns/AuthKey_26ZG85W23U.p8` 为root:aedresponse/640，子目录750。env仅追加五个APNs值，备份 `/etc/aedresponse/backend.env.before-apns-20261001060216614-578fb892`；运行进程五项均与KeyID/Team/Bundle/Sandbox/该路径匹配。**但独立sudo -u aedresponse test -r返回false，尚不可称APNs就绪**。正核对namei/父目录权限；不要为了快而放宽整个/etc私密配置目录。
- 回退helper已安装 `/opt/aedresponse/operations/disable-apns-config-20261001.mjs`（root所有）：仅备份env并移除AED_APNS键，再重启服务；保留当前兼容解析器和数据库，不切回旧release、不恢复旧DB。源helper均在Mac候选工作根，经node --check；它们不打印密钥/令牌。
- stage私钥临时副本及validate-state.sqlite仍待确认最终读钥成功后清理；Mac Downloads原文件600保留。现阶段无持续设备采集进程。下一步先修正最小读钥路径权限并验证服务身份真实读取，再让手机前台注册APNs token，最后才开新的隔离锁屏模拟；尚未让用户触发事件。

### 2026-10-01 14:07 读钥权限已修复，等待手机登记推送token

- namei证实`/etc/aedresponse`原本root:root/700，子目录/文件权限正确也无法让服务穿过父目录。未放宽旧目录；新增专用 **`/etc/aedresponse-apns` root:aedresponse/750**，正式钥 **`/etc/aedresponse-apns/AuthKey_26ZG85W23U.p8` root:aedresponse/640**。以aedresponse身份实际读取并createPrivateKey解析P256通过，而非只用root检查。
- env只改AED_APNS_KEY_PATH，额外备份 `/etc/aedresponse/backend.env.before-apns-path-1790834771746-f4615e74`；服务重启后进程路径匹配最终位置。公网health200（06:06:51Z）、ACTIVE0，精确原phone/watch记录关系匹配。APNs配置完成和读钥通过，不等于Apple已接受真实推送。
- 当前目标phone `pushRegistrationPresent=false`，尚无该手机token。已async请用户打开iPhone AEDResponse前台10秒后锁屏，回复“已锁屏”；不退出/重新登录、不点Watch模拟跌倒，只为token登记。**等待该回复后先查询同一phone pushRegistration存在/env=SANDBOX/bundle匹配（不输出token）**，再决定受控通知/新隔离run步骤。此时未开启新run、未发APNs测试、未创建新事件。
- 修复helper在Mac候选根`relocate-apns-key.mjs`（经检查，SSH执行成功），本地install helper默认目录也已更正。服务端2个冗余key副本和stage数据库验证副本已按精确路径删除；正式密钥、Mac原文件和部署前备份保留，SSH清理exit0。不要重跑旧install helper覆盖当前配置。旧release的Linux node_modules仍被新release绝对symlink引用，不可删除旧release，除非先处理依赖。

### 2026-10-01 14:17 手机开启通知但推送登记仍缺失；诊断build11正在构建

- 用户回复已锁屏（先按要求打开手机10秒）。只读核验同一精确phone/watch关系仍匹配，手机lastSeen06:12:03Z、通知capability=true、3条未撤销未过期设备会话；目标pushRegistration缺失，全库已登记手机0。当前7历史/0ACTIVE、通知release健康。没有发送任何APNs或创建事件。
- 已请用户看设置通知权限/橙色提示；用户只明确回复“已开启”，未提供橙色提示原文。不要将此推断为没有提示。本机用实际build10 embedded.mobileprovision按App同样Foundation解析，XML成功、aps-environment=development、applicationID匹配；不能把缺登记归咎权限或profile而无证据。
- 确认旧调试日志被AED_PUSH_DIAGNOSTICS启动环境开关限制；普通USB安装不能注入该环境。为定位真实回调阶段，最小修改2个客户端文件：RemoteNotificationService改为DEBUG内固定脱敏NSLog，增加delegate-launched/store-attached/request/token-received/environment-unavailable/apns-failed阶段；PushRegistrationCoordinator增加client/token/HTTP开始/结果阶段，只有HTTP状态码，不记token、URL、账号、位置或响应正文。没有改变业务流程，Release仍无这些日志。
- canonical ios/project.yml正式iPhone/Watch版本10→11，xcodegen已重新生成；不改TestHost/Controlled版本。Git原有脏修改保留，diff --check通过。当前构建命令普通generic/platform=iOS签名Debug，仍带Watch模拟编译开关，无DDI/镜像/Simulator。
- 工作根 `[BUILD_CACHE]/push-diagnostic11-20261001.jKb03R`，build.log、Signed/；构建exec **20955**仍在，手机USB原目标可见、实际安装最后读回10。**尚未安装11或取得新日志，不能说问题已修复。** 下一步确认BUILD SUCCEEDED/三bundle验签，再普通覆盖安装、版本回读、限时仅筛AED_PUSH_DIAGNOSTIC，并请用户重新打开App；不用退出登录或改权限。

### 2026-10-01 14:18 build11已装iPhone，等待重新打开收集推送登记日志

- build20955已exit0/BUILD SUCCEEDED，三bundle codesign --verify --deep --strict均通过，二进制strings确认脱敏诊断格式/phase已编入。普通ideviceinstaller覆盖更新session73464 exit0/InstallComplete100%，独立安装查询iPhone实际build11。没有清理登录数据，没有镜像/DDI/Simulator。
- Watch14:18:08 placeholder不计成功；后续14:18:26 Finished install/installed，回执可执行hash `715dee0afa4809105bbe2a34bf70125a908b9b18285fc8eeddcbe0fcfdcf656f` 与本轮独立Watch二进制SHA256吻合，确认build11实际更新。代码业务未变，这轮先定位iPhone注册。
- 限时日志收集session **44509**，2个普通idevicesyslog：PID95063只筛AEDResponse/AED_PUSH_DIAGNOSTIC→同工作根registration.log；PID95064只筛appconduitd/Watch bundle→watch-install.log，均最多600秒自动停止。完成诊断后只结束这些目标采集进程，勿停手机App。
- 已async请用户重新打开iPhone AEDResponse前台20秒，回复“已打开”，这次先不锁屏、不点Watch模拟；橙色提示/弹窗附原文。仍未发送APNs、未开新run、未新增事件。
- 另启动generic iOS `AEDResponseUnitTests build-for-testing`（exec **96991**；UnitBuild/、unit-compile.log），只是无签名测试编译，不运行Simulator/设备XCTest。后续需读取该命令结果，不把编译当测试执行。

### 2026-10-01 14:24 推送登记成功，单条非救助APNs已被Apple接受；待设备显示反馈

- 用户回复诊断版“已打开”。目标phone服务器登记 `registeredAt/updatedAt=2026-10-01T06:19:32.453Z`，token存在、SANDBOX、bundle匹配，目标lastSeen06:19:33Z；是精确原phone记录，不输出token。旧进程缺登记的原因仍未唯一证实，build11仅加日志/重新启动，不能说业务根因已修复。
- XCTest编译96991已exit0，unit-compile.log为TEST BUILD SUCCEEDED；没有执行设备或Simulator单元测试。两个实时采集95063/95064已按精确命令结束，session44509两child均exit0，无持续采集。
- 实时registration.log只显示connected，没有登记phase；回读私有 `[BUILD_CACHE]/push-logread-20261001.G9CXMj/phone-recent.tar`（读取成功）后按App/phase过滤也未得到日志。不要伪造回调阶段证据；登记结论使用服务器新鲜记录。原始全设备归档待本轮最终检查后精确删除，仅保留脱敏结论。
- 用户明确回复 **“可发测试通知”** 后，14:23:42–43只向精确phone的已登记Sandbox token发送**1条非救助APNs**。使用线上defaultApnsJwt/apnsHTTP2Post，payload只有aps提醒“**AEDResponse 通知测试**／这是一条推送通道测试，没有发起救助。”，没有eventId/messageId业务标识，不创建事件、不招募。普通active级别，不冒充Critical Alerts，不发送模拟跌倒。
- **APNs HTTP200**：2026-10-01T06:23:43.231Z，apnsAccepted=true。单次防重记录服务器 `/var/tmp/aed-apns-20261001.d9McHw/apns-preflight-notice-1.json`，wx创建防止误重放，内容只有时间/状态不含token。不得自动重发这条测试；200只证明Apple接受，不证明设备展示或业务outbox链路。
- 已async请用户确认在iPhone锁屏、Watch或两端都未见“通知测试”；不用点通知、不点模拟跌倒。Apple官方说明https://support.apple.com/en-us/108274 已读取：默认两端择一，锁屏且Watch解锁时通常在Watch。**当前等待设备显示反馈**，还未开新的隔离run；旧r4仍过期。
- 用户先回复“两端都没看到”，因此设备呈现当时未通过；已请求查看两端通知中心，以及系统通知勾选/专注/摘要，不改变设置、不重发。后用户对“系统通知设置”那一题回复 **“看到了”**，尚不清楚指测试通知出现还是看到设置页，也不知道出现在哪端；须澄清，不能据此直接勾选锁屏提醒通过。
- 发送后只读复核仍7历史/0ACTIVE。第一份push-logread-20261001.G9CXMj全设备tar及展开归档已精确删除、不留恢复副本；加info/debug并放宽到唯一AED_PUSH_DIAGNOSTIC前缀仍无记录，只能记“该采集没有日志”而不能推断未执行。另创建的push-delivery-20261001.XQnCte仅空工作目录，尚未开始第二次归档；当前无采集/后台进程。

## 2026-10-04 继续：只读预检通过，等待新一轮非救助通知测试准备

- 用户“现在继续”。普通USB原目标iPhone可见、network0；独立installer读回仍build11，无需重装。保留现有dirty worktree，本轮未改业务代码、未部署或重启。
- 13:45:49Z服务器只读核验（北京时间21:45:49）：current仍lockscreen-notifications-20261001-r1，active/running、NRestarts0；7历史/0ACTIVE。目标phone/watch账号及配对关系匹配，pushRegistration存在且token非空、SANDBOX、bundle匹配；APNs配置完整、Sandbox且密钥文件存在。目标phone lastSeen为10月3日05:30:00Z，登记更新时间05:30:04Z；这些不是今天的手机前台操作证据。旧r4仍已过期。
- 上次“看到了”始终未确认是通知还是设置页，也未知哪端显示，因此没有补写设备呈现通过。本轮不要求用户回忆，已async请其打开手机App10秒再锁屏，回复“可发测试通知”，然后只发送一条标注今天日期的非救助通知，明确观察iPhone/Watch哪端。**尚未收到本轮就绪回复、尚未发送新通知或开启新模拟run。** 不自动重放10月1日那条notice-1。
- 下一步就绪后以当前手机新鲜lastSeen/有效绑定核对目标；APNs token本身可能长期不变，不能仅因updatedAt较旧就判为失效或要求退出重登。新测试要有独立单次防重记录，仍不输出token、私钥或JWT。后续模拟跌倒需新的有效隔离窗口，不能跳过通知呈现边界或沿用过期r4。无持续日志采集进程，不用镜像/DDI/Simulator，不主动委派子任务。

### 2026-10-04 用户接受此前已测项，不再重复；转入锁屏模拟跌倒

- 用户明确“之前测试过的可以算通过”。据此将此前已执行的测试按用户确认记为通过，不继续追问10月1通知出现在哪端；取消刚发出的重复非救助通知步骤，本轮不发送新的测试通知。历史原始证据保留，不补造未记录的具体显示位置，也不将未做过的真实Fall/SOS、独立WatchWAN或完整AED回执标为已测。
- 当前范围改为此前已获准的同一iPhone+Watch、两名受控虚拟响应者的**新限时隔离锁屏模拟**：只测手机锁屏时Watch按钮→手机中转→服务器事件→提醒/结束，不要求手机前台作为触发条件。旧r4不可复用；重新只读确认仍7历史/0ACTIVE，先核对准备helper再启动新窗口，未创建新事件。
- 最新开发指令恢复主动并行，已让既有wireless_test_preflight子任务只读审查runner/已部署模拟授权边界，禁止其服务器写入、读取token/位置或操作设备；主线程独占实机与线上状态更改。

### 2026-10-04 22:05 r5已就绪，等待用户锁屏后Watch单击

- 新窗口r5由已检查的`/tmp/rearm-run.mjs`创建；runId `REDACTED-ID-e66c08395ef2bbbc`，截止`2026-10-04T15:13:48.935Z`（北京时间23:13:48）。私有manifest `/var/lib/aedresponse/watch-simulation-20260927-r5/run.json`，仅既有真实phone/watch及两名新虚拟响应者。准备时全库0ACTIVE，旧测试账号未撤销且有效的会话0。
- 仅重写独立`watch-simulation.env`，主`backend.env`逐字节确认保留；按已有受控测试/部署授权重启同一已部署release，没有发布canonical脏树。重启刚返回时读取进程env尚无run，首次校验失败；随后新进程稳定，独立复核runtimeRunMatches=true、APNs配置存在、admin socket存在、service active，公网health200。未添加错误假设的`AED_ENABLE_SIMULATED_EVENTS`开关，该能力由loadConfig根据私有admin socket派生。
- 经检查的`/tmp/aed-start-watch-runner.sh r5`启动PID763543（flock外层），runner hash仍6ded8086a33b18b2484191986bac77aa4f18fa187facd8aaab5c654221330711。14:03:34Z READY，两个SOCKET_READY后14:03:37Z出现两名`WAITING_FOR_WATCH`，证明两人完整初始heartbeat及虚拟位置已就绪；不用要求患者前台补定位。runner不创建事件、无患者token，收到本run请求才自动受控接单。
- 22:05:01启动单路普通手机日志：exec session79173，idevicesyslog PID69137，上限600秒；`[BUILD_CACHE]/lockscreen-run5-20261004.UG0JGK/relay.jsonl`。仅将白名单CompanionRelay状态字段写入600权限文件，保存capturedAt（接收时间，不冒充设备事件时间）；不保存其他App日志、令牌或坐标。完成后精确停止/回收该采集；空结果不可推断业务未发生，必要时短期归档回读。
- 已async请求用户：手机侧键锁屏、不划掉App/不解锁；Watch只点一次模拟跌倒，保持30秒，反馈Watch最终提示及哪端出现救助提醒，先不结束；USB可保留，测试业务不以手机前台为条件。**尚无用户点击反馈，不能将r5记为通过。**
- 下一步仅查本run事件/通知及固定后台日志，Watch最终ACK与通知显示须独立确认。用户结束后核对TERMINAL_CONFIRMED、两条CONTROLLED_IDENTITY_SIGNED_OUT、STOPPED、全库0ACTIVE和虚拟账号注销。窗口到期/stop不会自动结束ACTIVE；不得强杀runner、伪造结束/回执、删除事件或重做此前用户已接受的测试。

### 2026-10-04 22:12 用户已操作，自动核查尚无r5事件

- 用户明确已按要求操作，并要求减少逐步人工操作。已接受：服务器状态、投递、受控响应者和日志由主线程自动核查，只保留不可替代的Watch点击/物理锁屏/屏幕显示观察；不以服务器代建事件冒充真实Watch起点。不重复之前已接受的测试。
- 14:08:09Z与14:09:23Z两次精确r5查询均eventPresent=false，全库0ACTIVE、仍7历史事件。runner保持两名WAITING_FOR_WATCH，无新状态/错误记录。后一次phone lastSeen14:09:00Z、watch lastSeen14:06:46Z，表明有后台业务接触，不代表模拟跌倒成功。
- 实时采集得到10条白名单日志；PID69137已精确停止、session79173已回收（exit0）。为排除实时漏采，普通archive回读22:05–22:10:20，exit0；校验tar路径/类型安全后，仅筛AEDResponse/CompanionRelay得到相同10条：context后台receive、bind后台receive/reply ok、ping后台receive/reply ok，三条系统transfer true，均appState2；另两条immediate context/bind ok。**没有simulationContext/simulationObservation记录**。时间使用archive的设备timestamp；原live capturedAt不作设备时间。
- journal该窗口没有可解析HTTP访问记录，不能从空journal认定请求未到达；服务器精确事件不存在才是当前业务结果。后台连接恢复与按钮业务入口分开，不能否定用户真实点击，也不猜测定位授权/禁用按钮就是根因。
- 只读子任务确认：context/bind/ping是启动恢复；模拟入口有未绑定/发送中禁用、pendingHelpEventID等提前返回、定位授权、持久化点击意图和session恢复等门槛。旧pending意图可自动恢复，不默认要求用户再点。已async仅问Watch当前提示原文和按钮是否灰色/发送中，未要求解锁、重开或重触发；待回复再定位。
- 脱敏archive记录保存在同一私有缓存`relay-archive.jsonl`及项目`docs/evidence/watch-lockscreen-2026-09-27/locked-attempt-r5-20261004.log`。原全设备tar/展开归档已按精确路径删除且无恢复副本，仅保留白名单证据，手机原始数据未改；本轮未改业务代码、未重新安装/部署、未发送通知或结束事件。r5仍有效至23:13:48，响应者runner保留等待；若窗口过期须核查注销清理，不把过期当ACTIVE自动结束。

### 2026-10-04 22:34 r5已结束；登录恢复，性能故障未修复

- 用户先说按钮变灰，后明确文字为“发送中”。这证明该时刻simulationPreparing=true，不能再认定只是未绑定禁用。14:14:23Z查询仍无事件；14:17:25Z查询发现本run ACTIVE。持久观察原始fallDetectedAt/requestedAt为14:15:10.798Z，创建14:15:32.888Z，相差22.090秒；不能用22:05指导发送时间推算发送卡住时长。
- 精确核验`event.observation`：observationKind=SIMULATED_TEST、runId匹配、patientDeviceId为本次phone、syntheticWatch.deviceId为本次Watch、nested observation.eventId匹配、appHelpResponse=NEEDS_HELP。该值由一键测试场景提供，不是又要求用户回答帮助。未由服务端代造事件，未触发真实Fall/SOS。
- 两名虚拟响应者收到Socket response:requested，但runner14:15:44Z出现fetch timeout，后续账号刷新401；两邀请EXPIRED、0assignment。没有完成本轮接单/导航/AED业务，不能算通过。外部收件人计数0。
- 14:17:21起90秒普通日志采集session82486/PID71465已自行结束exit0，7条记录在14:18:43Z收到：simulationContext、simulationObservation、ping的background reply unavailable，appState=1（inactive，**不是2后台执行证明**）。文件同私有缓存`relay-sending.jsonl`。没有Watch最终ACK/设备提醒显示证据，完整锁屏链路仍未通过。
- 本run patient-activated APNs先多次RETRY/TRANSPORT，14:27:45Z回读为SUPPRESSED/NOT_AN_ACTIVE_ALERT，attempts8、lastAttempt14:21:07Z。全库曾出现一条DELIVERED但不属于本run，不能误标r5投递成功。此前独立通知按用户确认接受，不重复测试。
- 用户随后报告Apple登录失败“Apple authentication is temporarily unavailable”。已部署service:1743将verifier的503映射为该文案；apple-auth公钥获取/解析失败统一503，不能确定是DNS/TLS/5秒超时/正文校验哪一项。APNs私钥与Apple登录公钥验证不是一回事，不换钥、不放宽nonce/签名校验。
- 线上服务CPU约115–117%，本机health3360ms、公网5071ms；独立服务身份APNs TLS/h2握手480ms。独立Apple公钥GET200/3把RSA钥911ms，直接调用部署版AppleJWTVerifier.fetchKeys成功990ms，无登录请求/账号写入。支持主进程负载影响，但未取得此次503原始内部错误，不称唯一因果已证明。
- 14:24:18Z通过r5私有FIFO stop，runner记录ACTIVE_EVENT_REQUIRES_PATIENT_END和STOPPED；不强杀、不结束事件、不重启服务。停止虚拟客户端自动请求后14:25:34Z本机health降至352ms。用户只重试一次后确认**已进入主页面**；14:29:12Z同一手机有效device session1、原Watch relay关系存在。
- 事件由正常业务结束为RESOLVED/PROBLEM_RESOLVED，resolvedAt14:28:06.570Z；全库0ACTIVE。不要求用户再结束一次。原runner停在ACTIVE时未注销，末尾需单独收尾，已完成如下清理。
- 仅对原r5两名CONTROLLED_TEST账号经现有私有IPC重新签发以撤销旧失步会话；验证user/account/device与旧清单一致，复用原固定pair，不采用IPC返回的新随机pair。bootstrap保留旧availableForResponse，故另PUT presence=false，再分别device/account logout。最终DB：virtualAvailableCount0、unrevokedCohortSessions0、unrevokedCohortRefreshTokens0、ACTIVE0。不改变物理phone/watch的绑定/登录授权；正常接口可附带常规过期清理。未重启runner或触发新事件。
- 离线性能复现：只读线上SQLite一致性私有备份，传至Mac后比对SHA256 `31320996435e1a07d52543b97de04a4e2e3b033b8f9c183e35610ddd684778e0`，用已部署候选的SQLiteStateStore执行3次无变更事务。耗时148.26/132.98/128.15ms；6次全状态clone、3次flatten、3885次batch clone、15084实体序列化、0次SQLite commit；全状态read19.08ms、窄read0.08ms。证明确有同步全量处理开销，不代表该数值就是VM延迟或Apple503唯一根因。脱敏指标`store-cost.json`保留。
- 首次非压缩传输尚未完成便读取临时文件，导致本地副本报SQLITE_CORRUPT；这是采样步骤错误，不是生产库损坏证据。已终止该精确传输进程、改压缩重传，待exit0及字节hash匹配才复现，成功通过store加载。Mac的两份数据库临时副本与服务器`/var/tmp/aed-r5-perf-c3YcR8/snapshot.sqlite`均已精确删除、无恢复副本，原线上库/原备份保留。
- 只读复核发现旧候选tick+HTTP可重复全状态事务，outbox每due通知组又执行多次全状态读写；APNs在途时deadline未推进可能放大开销。独立Watch generation/flight换pair竞态亦是待复现候选，不能用于解释当前sending；未改任何业务源码。子任务本地Apple auth既有测试6/6通过，只证明假公钥测试，不算实机登录耐久验收。
- **下一步先修复/回归服务端性能和负载下认证恢复，再恢复实机测试。** 本轮只是停止测试负载后恢复登录，未发布修复、未重装App、未改登录30天期限、未提交/推送。保持旧release依赖和APNs/存储兼容回退约束，不整树部署canonical脏修改。不再让用户重复已接受的测试。
- 14:34:54Z最终独立回读再次确认ACTIVE0、虚拟待命0、虚拟未撤销session/refresh均0、物理phone有效session1、原Watch→phone relay匹配、service active。服务端保留r5目录内`terminal-cleanup-result.json`脱敏收尾回执；本轮新签发但已全部撤销的`terminal-cleanup.json`凭据中间件已删除，不影响原run清单或历史审计。

### 2026-10-04 已解锁仍提示“解锁查看”：本地修复完成，未部署/安装

- 用户将当前优先事项改为不同手机状态下的消息展示。定位到iPhone本地EmergencyAlertPlan有2处、backend push-presentation有9处硬编码“解锁”指引；App后台不代表手机锁屏，同一通知可显示在已解锁横幅/通知中心，因此不根据inactive/background猜锁屏。
- `ios/AEDResponse/Application/EmergencyAlertPolicy.swift`把activated/ended改为“轻点查看…”，增加最小纯策略`shouldScheduleNotification(isAppActive:)`；`Services/EmergencyNotificationService.swift`调用它，行为保持active不调度、inactive/background可提醒、ended只做原有清理。`RemoteNotificationService.willPresent`原本已return []并REST刷新，本次保留，未把页面打开当作接受/结束事件。
- 子任务只改`backend/src/push-presentation.ts`及`backend/test/push-notifications.test.ts`：9处文案状态中立化，确认进展为“轻点查看并确认救助是否仍在进行”；所有phase/title/timeSensitive、模拟副标题和隐私边界保留。新增23种展示情境的表驱动回归。
- `ios/AEDResponseTests/EmergencyAlertPolicyTests.swift`增补各phase文案、前台抑制/后台可提醒、切回后台不重复相同阶段；共6/6在Mac原生SwiftPM执行通过（不是Simulator，也不是真机UI）。纯源文件通过symlink复用，临时测试包位于`[BUILD_CACHE]/notification-states-20261004.c2EwIk`，日志`swift-policy-tests.log`。
- generic iOS `AEDResponseUnitTests build-for-testing CODE_SIGNING_ALLOWED=NO`成功，相关EmergencyNotificationService实际编入TestHost，日志同目录`generic-tests-build.log`；只是编译，不是设备测试执行。后端`node --import tsx --test test/push-notifications.test.ts`19/19、`npm run check`、`git diff --check`通过。全仓运行源码中不再有“解锁”用户文案。
- `docs/design/lockscreen-2026-09-27/README.md`已补新版文案规则及Apple官方状态/前台通知参考；旧图片仅视觉参考。没有新增“进入前台即清所有通知”行为：active不代表某一事件已读，已经投递的旧通知不会自动改写。
- **未发布后端补丁、未更新手机/Watch、未提高build版本、未创建模拟事件或发送推送、未触碰线上数据。** APNs文案须发布后端，本地通知须更新App后才生效；不能说当前build11手机已经修好。上轮服务端性能问题仍待单独修复，本次未顺带发布其它未验收dirty代码。后续继续避免要求用户重复既有验收。

### 2026-10-04 服务端性能修复进行中（用户“好的，继续”）

- 本阶段优先处理性能，不再开启实机run或要求重复操作。15:01:15Z只读线上仍`lockscreen-notifications-20261001-r1`、active、8历史/0ACTIVE；五个关键source SHA与原Mac候选逐字匹配。旧release的node_modules依赖、APNs/身份配置均未动。
- 新隔离工作根`[BUILD_CACHE]/performance-fix-20261004.wccrbg`：`baseline/backend/src`为线上匹配基线；`candidate/backend`为限定候选，Mac node_modules只链接本机canonical依赖，**上传Linux时不能打包该链接/原生依赖**；`candidate/contracts`沿用线上合同。不要整树发布canonical未验收功能。
- 主线程已改候选tick：先原有位置清理，再用零写实体事务作队列栅栏探测ACTIVE；没有active仅drain通知，不暖路线/不全量维护；有active保留原流程并早跳terminal。没有简单共享整个tick Promise，以免跨deadline的HTTP加入旧快照。canonical同步相同fastpath但保留其既有retention/security/reroute/revoke sweeps，不能用候选service整文件覆盖。
- 子任务`wireless_test_preflight`独占候选notification-outbox、service.deliverPush及notification-outbox-performance.test，完成直接实体写/忙push去重/Socket独立重投；初步新测10/10、push+Watch定向35/35、check通过。主线程未动其方法。它还负责修候选business-requirement-gaps.test的独立push后台任务未flush快照，以及responder-position-transaction.test区分首个业务事务与之后outbox实体事务，不许放宽业务不变量。
- 主线程已移植canonical既有SQL提交成功后才推进flattenedState缓存及success metrics的最小保护至候选store.persistEntityChanges；新增sqlite-entity-rollback.test（candidate及canonical），强制revision SQL失败后再legacy重试并重开验证update/delete均持久，2/2通过。原canonical已有此修复，不重写它。
- `login_unavailable_trace`完成候选tick-performance.test 8项+metrics4项12/12、check；canonical同步测试并适配现有indexed tick，合计14/14+check通过。空闲探针不计recruitment run；active候选仍legacy、canonical仍indexed，按操作不按事件计数。
- 候选初轮全量`candidate-full-tests.log`464项/461通过/3失败：sole-responder拒绝测试与异步push快照交叠；两项position事务统计仍假设outbox走legacy。该轮运行时通知补丁仍在修改，因此不是最终候选验收；待子任务修正测试边界及源码冻结后重跑全部，不将其标为已通过。
- 本轮候选已额外回移上轮中立通知文案，只改线上已有8处分支，不引入canonical新增业务类型。
- 已检查`candidate/backend/test/performance-regression-probe.mts`：完全合成SQLite、禁外网、假push、本地路由，8历史/1295批×5/1850通知，约6.5MiB，分别idle和active+40due通知，测walltime/1ms timer delay/clone/事务。pilot仅证明可运行；**正式前后数字尚未取得**。现让login_unavailable_trace仅跑baseline2轮，输出`perf-baseline.json`；其间其他人暂停测试以免CPU竞争，candidate待冻结后测。
- 尚未打包/上传/切换/重启服务，无新事件/通知/手机安装。下一步：收齐candidate补丁与回归→同步canonical对应非冲突逻辑→冻结源哈希→正式前后性能对照→限定候选全回归/构建→再做独立Linux验证及发布评估。不得放宽鉴权/删历史/改30天规则来取得性能数字。


## 2026-10-04 iPhone UI 优化（当前独立阶段）

- 用户要求改善现有 App UI，并在本会话明确批准“完全离线的 iOS 模拟器”检查；此授权仅覆盖 TestHost 界面，不恢复服务器、真实事件、镜像或物理设备 DDI/安装。
- 本轮在既有 dirty tree 上增量修改六个 Views：RootView（主题/标题/图标/按钮）、ResponderDashboardView（待命/邀请）、NearbyVolunteersView（容器/离线标签）、ResponderNavigationView（导航层次）、SettingsView（四分组/大字适配）、PatientDashboardView（共享样式）。登录/启动动画、AppStore、后端与状态机没有本轮改动。
- 配色：浅灰 #F4F6F7 背景、白卡、深绿 #087F5B 主按钮；深色有单独动态颜色。保留真实状态、原操作/禁用/确认流程、所有测试标识；AED 到达与获取仍为两步。
- 图像概念工具连续两次网络失败，没有 concept.png；已有参考体系与明确样式规格驱动本轮优化。原始brief、说明与真实截图在 docs/design/ui-polish-2026-10-04/。
- 已验证：iPhone+Watch generic Debug 无签名构建成功；离线 TestHost arm64/x86_64 Simulator 构建成功；3项 ApprovedUIScenarioTests、设置入口和附近地图/列表UI测试通过。home/settings浅色与settings深色accessibility-large实际截图已检查。未安装物理设备，未提交/推送/部署。
- 综合UI用例：旧源码基线在AED获取后等待按钮失败；当前首次回归在场景切换失败，导出UI层级确认仍为“测试模式·中立待命”，测试tab仍选中。UI测试helper原来只等全局横幅/行动tab存在，可误认旧场景。本轮改为等待行动tab真实选中，仅仍留在测试tab时重试一次；按钮等待上限3→10秒，新增获取后截图。没有放宽业务断言。重跑正在进行，尚不称全绿。
- 当前重跑：/tmp/aed-ui-polish-flow-20261004.log 与 .xcresult；初轮5/6结果：/tmp/aed-ui-polish-final-20261004.xcresult；旧基线：/tmp/aed-ui-polish-baseline-clean-20261004.xcresult。构建日志：/tmp/aed-ui-polish-device-20261004.log、/tmp/aed-ui-polish-simulator-build-20261004.log。
- 新建本轮隔离 Simulator：REDACTED-ID-0015e2d01105c61a（AEDResponse-UI-20261004 / iOS26.4）；此前普通iPhone17Pro模拟器在Runner启动卡住后已关闭。所有界面运行强制 AEDRESPONSE_TEST_HOST / -UITestMode，无真实业务网络。
- 修改前完整Views/UITests/HANDOFF快照：/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aed-ui-polish-20261004-jwipxhhs/baseline。不要用git checkout覆盖此前已有修改。
- 下一步：完成正在运行的综合UI用例、查看邀请/任务最终截图，按真实结果更新本节和设计文档；若失败先读失败层级，不把环境/自动输入问题误修到业务逻辑。


### 2026-10-04 UI 优化最终完成（覆盖上节“正在重跑”）

- 最终 iPhone+Watch Debug无签名构建通过：`/tmp/aed-ui-polish-device-final-20261004.log`。最后版综合UI流程1/1通过：`/tmp/aed-ui-polish-layout-20261004.xcresult`；此前3项场景单测+2项设置/地图UI回归均通过。原失败保留，不把初轮失败结果改成成功。
- 最终截图已逐张检查；修正了邀请页空导航栏、Apple地图按钮换行和破坏性操作颜色。深色/大字号仅抽查设置上部，未声称全屏全字号或真实网络业务验收。
- 最终文件与证据索引：`docs/design/ui-polish-2026-10-04/README.md`、`visual-review.md`、`verification.json`、screenshots/。本轮6个Views与UITest等待助手改动；登录/启动/协议页哈希保留。`HANDOFF.md`为追加交接。
- 本轮代码工作完成，下一步如需在手机看效果，仍需另行做签名/安装及真机视觉确认；未自动提交、推送、部署、重启服务或创建真实救助事件。

### 2026-10-04 23:40 性能候选冻结，本地通过；Linux暂存验证进行中

- 同一合成数据、同消息数量的正式双轮：baseline idle tick均值1061ms、ACTIVE+通知33933ms；第一版candidate分别1.67ms/2595ms；最终candidate为1.314ms/153.706ms。最终ACTIVE full-state clone398→2、flatten133→1，Socket44/fakePush3均相同，seedHash和完整storage summary逐组一致。不是线上压测、不是实机业务通过；仍保留ACTIVE单次全状态事务和全集合资格扫描，不宣称大规模容量达标。
- 最终结果`performance-fix-20261004.wccrbg/perf-candidate-final.json`；先前两份保留。五个src差异严格限service/notification-outbox/state-read/store/push-presentation，源哈希前后冻结一致。`state-read.ts`在原文件尾增完整namespace、detached frozen lazy facade，保留跨事件/同user完整资格；仅两处通知read替换。canonical已有等效readState，不移植旧架构helper。
- candidate最终npm test原有464/464＋performance posttest35/35、check/build通过；额外push/watch/部署配置27/27通过。canonical最终原有730/730＋performance21/21、check/build通过。canonical position测试新增等待后台push收尾再做持久化严格全状态比较，定向21/21。两边所有业务断言保留，candidate全链路clone断言从旧>0加强为==0。
- 两名子任务只读补丁审阅未发现发布阻断；APNs仍at-least-once，结果提交失败可重复交付；网络等待不阻塞Watch ACK但同步计算仍有成本。没有更改签名/nonce校验、账号30天期限、推送授权或数据库schema/持久化级别。
- 15:36:58Z线上只读8历史/0ACTIVE、1340位置批、1876通知；health约3.99秒，NRestarts0。最终Linux依赖realpath为`watch-relay-20260926-r1/backend/node_modules`，旧Sep27可能为中间链接，均须保留。
- 已组装不含Mac依赖/构建产物/数据库/env/私钥的源码包，SHA256 `0097ae759c00ed9519af4fad88f3e82275ab40e5ca6307af08437919d6a07ec7`。已上传远端私有暂存`/var/tmp/aed-performance-stage-20261004.00FiOz`；尚未切换服务/新建事件/发送推送/安装手机。限定目标release为`notification-performance-20261004-r1`，须Linux通过后备份，并在副本上验证候选写入重开+Oct1旧parser兼容，再复核0ACTIVE切换。兼容脚本不打印业务数据，保留一致性备份，临时副本结束即删除。
- 独立UI任务最近并发修改了Views/UITests和本HANDOFF尾段，性能任务未覆盖这些文件，也不会把整棵canonical脏树打包发布。

### 2026-10-05 00:02 性能补丁已部署，服务验证通过；实机业务尚未重启

- 15:58:23Z（北京时间10月4日23:58）限定切换为`/opt/aedresponse/releases/notification-performance-20261004-r1`。两个0ACTIVE门禁分别在正常停机前/停机后检查，通过才切链启动；无强杀、DB回滚、鉴权放宽。原`backend.env`及`watch-simulation.env`逐字哈希不变，未延长r5授权窗口。
- Linux隔离验证：原有464/464、performance35/35、push/Watch/部署配置/attestation36/36，合计535/535；check/build通过。原验证SSH连接在远端所有进程已退出、日志全绿后没有正常收尾，仅结束该本机SSH PID89986（exit255），未停服务器；新连接再次check/build exit0并读取全套报告。不能把旧SSH退出255描述为业务测试失败，也不能伪称旧连接exit0。日志已取回本机workroot。
- 发布白名单完整目录核对：src仅notification-outbox/push-presentation/service/state-read/store这5处不同，contracts和package-lock完全一致；package.json只增加performance/posttest脚本；没有发布canonical其它新功能/UI。代码与Linux构建产物已root只读安装，依赖使用既有Linux包。
- 首两次兼容探针因脚本尝试修改已完成notification次数，被append-only规则正确拒绝；失败均仅在副本，无业务源码修改/保护降级。探针改为私有副本上的可逆device.availableForResponse字段，先旧parser读→候选首次读严格对等→候选写入→关闭→旧parser重开严格对等→候选重开/恢复，最终exit0。所有SQLiteStore.close已await，临时副本/WAL/SHM完成清理，无恢复副本；一致性备份保留。
- 最终备份`/var/lib/aedresponse/backups/performance-20261004-uFPNdB/before-switch.sqlite`，SHA256 `61acb6b63935439823272e390a7db1e5ae19476099689a0150317b91282d18ed`，integrity_check ok。失败探针产生的额外一致性备份也保留，不清理既有业务历史。回退只允许保留现DB回切兼容Oct1 release，不能恢复旧DB或退至Sep27 parser。旧依赖release均保留。
- 15:59:21Z独立postflight：实际MainPID cwd为新release/backend、NODE_ENV production、service active/running、NRestarts0、8历史/0ACTIVE、备份中所有device绑定字段与live一致、APNs配置存在、DB quick_check ok。启动日志显示Sandbox APNs/Watch attestation启用；筛选的outbox/push错误日志无新匹配。health本机0.988ms（切换前3.989934s）；匿名API401、1.299ms。Mac公网三次200：1597/275/253ms，首次含约1295ms TLS，不能混称本机1ms就是公网端到端延迟。
- 验证摘要`docs/evidence/server-performance-2026-10-04/verification.json`；详尽合成性能/测试日志位于本轮workroot。canonical最终751/751+check/build、git diff --check通过，未提交/推送。
- **下一步尚未执行**：手机本地通知文案修复需单独签名安装；本阶段只上线服务器“轻点查看”文案，旧通知不会自动改写。未安装手机/Watch、未创建新模拟事件或主动发测试推送、未验证新版本锁屏Watch最终ACK/设备展示/接单。之前用户接受的测试不重做；下一轮需新受控窗口，不能沿用过期r5。独立UI改动不要顺带整树安装而不核对范围。

### 2026-10-05 00:20 r6锁屏模拟已就绪，等待Watch单击及实际反馈

- 用户明确“开始测试”。普通USB发现原iPhone，ideviceinstaller定向读回仍2.0/build11；没有安装新App、使用镜像/DDI/Simulator或打开手机App。build11缓存只有产物/生成源码，没有可信完整源快照，不能把当前大量dirty iOS代码重编译冒充“两处通知文案”更新。本轮先验证已部署性能版＋现有11的锁屏链路，本地中立文案仍未装。
- 新run r6=`REDACTED-ID-c67ceedc8c034a28`，有效至UTC17:28:27.645Z（北京时间10月5日01:28）。通过已检查的`/tmp/rearm-run.mjs`，仅更新独立watch-simulation.env，原backend.env哈希保持；0ACTIVE后重启同一notification-performance-20261004-r1，运行时run一致、APNs存在、admin socket ready。未发布其它业务源码。
- 私有manifest `/var/lib/aedresponse/watch-simulation-20260927-r6/run.json`，凭据仍仅VM root私有目录，患者凭据不读取/复制。原r5虚拟待命0、未撤销会话0，新r6精确沿用原物理phone/watch且绑定匹配；旧run过期。runner仍SHA `6ded8086a33b18b2484191986bac77aa4f18fa187facd8aaab5c654221330711`，flock启动PID771958，FIFO `/run/aedresponse-watch-sim/control-r6`。16:15:07Z READY＋两名SOCKET_READY。
- 最新只读16:19:31Z：8历史/0ACTIVE、本run尚无事件、外部delivery/notification0、health1.493ms。phone lastSeen14:43:01Z、watch14:28:23Z，phone latestPosition已无；runner等待新位置。**不要照runner旧提示要求先打开手机**：本轮就是验证Watch唤醒后台手机。源码允许Watch自带P创建WATCH_TRIGGER_SNAPSHOT，无P也可创建，随后iPhone后台REST对账/定位有实现路径；这不是已发生证据。模拟按钮本身不主动请求新Watch fix，模拟模式无Watch独立fallback，须观察实际位置能否恢复。
- 普通USB白名单日志收集session23439、collector PID93480、idevicesyslog PID93490，16:14:13Z开始，上限600秒自动停止；文件`[BUILD_CACHE]/lockscreen-run6-20261005.iqfu9D/relay.jsonl`，只保存CompanionRelay方法/状态/appState，不保存坐标或令牌。截至16:19仍0条，不能用空日志推断Watch未操作。capturedAt为接收时刻，不冒充设备事件时刻。
- 已async请用户：iPhone按侧键锁屏、不要划掉App，不用先打开手机App；只在Watch点一次模拟跌倒、亮屏约30秒，先不解锁手机/不结束事件，反馈Watch最终提示及哪端提醒。尚无用户操作完成回复，不能称测试已通过，也不要重复让其点。
- 精确只读核查脚本`/tmp/aed-read-run6-20261005.mjs`（需sudo）只输出本run状态、两个虚拟角色任务、患者push投递与范围计数，不输出敏感数据。本机同名源在run6缓存；后续读取该脚本及runner日志即可自动对账。
- 安全边界：runner为两人顺序请求、每轮完成后5秒，无额外并发，但失败无退避/熔断；超时/跨范围通知/服务延迟升高即暂停推进。优先在本run已明确终态后收尾。若无事件提前stop，仍要防迟到Watch请求与注销竞态；STOPPED/exit0不能替代available0＋未撤销会话/refresh0核验。窗口到期不会结束ACTIVE，勿代患者结束或强杀runner。AED虚拟点授权仍未获得，不能添加全局假AED或标记AED闭环通过。

### 2026-10-05 00:31 r6已结束：用户报告解锁相关等待，后台收发已取到证据，锁屏依赖尚未唯一定位

- 用户反馈Watch“授权待回复”，随后明确“手机没有解锁就是待回复，解锁后就是已记录测试”。不可把这当后台体验通过，也不能仅凭前后相关性断定系统必须解锁；当前源码没有这两句精确文案（近似“等待iPhone后台回复／测试授权待恢复／本轮测试已有记录”），后者不能单独代表Watch已消费服务器ACK。已请用户不重复点击，并只澄清“只是解锁屏幕，还是还打开了AEDResponse”，截至本节尚未回复。
- 服务器实际创建唯一r6事件：SIMULATED_TEST、phone/watch/run匹配，合成fallDetectedAt16:21:02.851Z、createdAt16:21:17.996Z，间隔15.145秒；不能将该差值当首次按键到反馈的完整时长。两名虚拟响应者分别16:21:40.748/56.750正常ACCEPT，均GO_TO_PATIENT/ASSIGNED，外部delivery/notification0。未继续重复此前已通过的导航，也没有AED任务或回执。
- 普通USB实时收集于16:24:13Z自动结束（session23439、PID93480/93490已退出），白名单0条不代表未处理。使用普通idevicesyslog archive回读，完成exit0；校验tar无路径穿越、仅常规文件/目录，log show限定AEDResponse/CompanionRelay，取得23条设备时间戳证据：16:21:09.202后台receive simulationContext appState2；09.211/12.685回复unavailable；14.758 ping ok；16.569 simulationContext ok、16.676系统transfer成功；17.250后台receive simulationObservation；18.628 immediate ok；19.371后台reply observation ok appState2；24.965系统transfer成功。说明iPhone确有后台处理/回复，不等于知道这些时刻屏幕是否锁定或Watch已消费ACK。
- 脱敏证据保存`docs/evidence/watch-lockscreen-2026-09-27/locked-attempt-r6-20261005.jsonl`及run6缓存`relay-archive.jsonl`；原325MiB全设备tar与展开archive均已精确删除，不保留恢复副本，手机原始日志未改。SpringBoard/backboardd所选明确锁态词筛选无结果，未推断实际解锁时刻。
- 当前源码静态候选：冷启动账号refresh/持久化、权限校验、device bootstrap、Watch绑定续期均在simulationContext前，未就绪可unavailable；即时回调与后台userInfo恢复/后台执行保护不完全相同。Keychain为AfterFirstUnlockThisDeviceOnly、mailbox为UntilFirstUserAuthentication，源码没有普通锁屏必须解锁的显式guard，因此不能把Keychain锁定作为已证实根因。模拟observation会await本地通知处理，但这不解释前置context等待。未修改iOS业务源码、未重装App、未重启服务或触发新run。
- 用户已明确结束。r6 resolvedAt16:25:10.795Z；runner16:25:16.821 TERMINAL_CONFIRMED、17.726/18.738两次CONTROLLED_IDENTITY_SIGNED_OUT、18.744 STOPPED。16:30:26Z独立核验9历史/0ACTIVE、virtualAvailable0、unrevokedSessions0、unrevokedRefreshTokens0、外部消息0；原两任务正常转CANCELLED。只读最终摘要在run6缓存`run6-server-final.json`，已断言校验通过。
- patient-activated及resolved的APNs记录DELIVERED各1次，coordination DELIVERED尝试2次；这是provider接受，不是锁屏实际显示证明。用户未明确提醒显示在哪端。本轮不标锁屏闭环通过；服务器负载下接单已完成且没有上一轮timeout/refresh401，但仍保留实际ACTIVE health约0.293–1.075秒，结束后0.848ms，不能把idle1ms当所有业务延迟。
- 下一步先完成“解锁是否同时打开App”的澄清，再针对授权恢复阶段与Watch反馈补足定位；不要要求用户重新登录/绑定、取消安全门禁，或沿用r6重复创建。当前测试已经安全收尾，无需用户再操作。
- 补充Watch只读审阅：当前Runtime的apply(.ignored)无条件显示“本轮测试已有记录”；同run重复点击，或ACK已存但intent未标submitted的中断恢复可达此分支。普通空闲周期retryPending并不会返回ignored，无pending的resume返回nil，因此不能声称周期必然覆盖成功文案，也不能用该候选解释直接归因本轮。现有测试没有simulationStatus覆盖顺序断言。未修改任何业务源码。

### 2026-10-07 深圳 AED 公开数据实取核查（只读研究，不是入库）

- 用户要求直接检查深圳点位，怀疑原网页整理未取到动态明细。官方数据平台 `29200/01503698` 的公开页面实际调用已复核：目录 1,487 条、12 字段、数据更新标注 2025-09-15；匿名公开预览实际取得 50 条。不是全量下载，更不是深圳全城设备数。
- 50 条都有 `BH/GH/AZDZ/AZQY/WDBD`；`WDBD` 虽标“纬度（百度）”却装有完整 `latitude,longitude` 字符串。全部成功拆分且落于宽泛深圳审查框，BH 样本内唯一；不证明现场位置准确。BD-09 仅据字段标注推断，尚未转换或独立校准；不能当 WGS84 送入现有 `coordsys:gps` 路线链路。
- 卫健委官方文章 `https://redacted-host.invalid/wzx/content/post_12692638.html` 二维码导向 `https://redacted-host.invalid/health-commission/index.html`。公开列表实际抽取 2 条（前端默认城市中心、非用户定位），响应 `totalElements=18019`；有设备 ID、序列号、详细地址与经纬度。H5 坐标系、`status/isOpen` 枚举未证实；`openTimeRespList=[]` 不能解释为全天可取。不同数据源数量不可相加成全城设备数。
- 脱敏解析样本 `/Users/REDACTED/Downloads/shenzhen_aed_verified_samples_2026-10-07.json`：保留两源独立计数、原始字段和来源哈希，52 条记录通过数值/范围/各源 ID 唯一检查；剔除联系电话，全部 `usableForDispatch=false`。未做跨源去重、地理编码、坐标转换、现场核验、完整下载或数据库导入。原始证据和本地解析脚本在私有缓存 `/Users/REDACTED/Library/Caches/AEDResponseDataChecks/shenzhen-20261007.1kLFdd/`。
- 下一步仅在用户要求接入后：确认地图坐标系及状态含义、取用限制和来源使用条件，再设计字段映射/缺失值规则；不可伪造开放时间、零延迟、定位精度或维护状态来满足严格 AED schema。平台完整文件下载有登录/实名门禁，本轮未绕过、未签署协议；大学附件验证码处也停止。未改业务源码、未部署、未开启真机/救助测试。

### 2026-10-08 深圳 AED 地图公开列表下载收尾（覆盖上一节“仅 2 条样本”）

- 用户明确要求下载数据来源。已在 `/Users/REDACTED/Downloads/深圳AED数据来源_2026-10-08/` 保存两源材料；地图 `官方地图/本次采集.TZ8a4btC/records-unique-private.json` 已取得 181 页 / 18,019 条唯一记录。单并发、页间至少 400ms，未触发登录/429，保留原始页、请求时间、哈希、前后计数和源页面声明。未坐标转换、未跨源合并、未导入服务器。
- 地图采集及两次独立回读通过：无缺页/重复 ID/分页总数变化；原始与合并字段数值一致，ID 全为原始字符串；坐标非数值/范围越界/零经纬度均 0，地址无空，cityName 均深圳市。18,019 条 `openTimeRespList` 全空，不能设为全天开放；坐标系仍未核定。格式通过不是现场可用性证明。
- 地图独立 count 前后均 18,629，较列表多 610，原因未公开；不能声称下载了这 610 条或完整覆盖全市。完整只指该公开分页列表查询，非事务快照。
- 开放数据平台仅取得目录/12字段/50预览/文件列表/页面；完整 1,487 条文件未取得。已核明网页“数据容量”17,844 是 1,487×12。用户先后报告内置浏览器与 Edge 已登录/实名；cua 持续超时，Playwright attach 无扩展，Edge 本机标签只读可用但 JavaScript 控制关闭；没有启用安全设置、复制登录凭证、绕过门禁或继续抓取其他私有接口。用户最后让继续收尾，本轮不再追问登录。
- 交付说明 `下载说明.txt`，根目录 `独立校验结果.json`，各源 `manifest.json` 与地图 `independent-validation.json`。主 JSON SHA256 `1ba617248b1495e463c80778c8ac5cdce243f249ab1abdff4968370871083319`。目录 700，原始/合并数据 600。仅新增下载归档和本节交接，原有源码及未提交改动保留；无提交/推送/部署/设备测试。
- 后续若用户要求接入，先确认 CRS 与状态枚举、开放/取用限制，再做服务器字段适配；下载原始数据不能自动满足严格 AED schema。开放平台完整文件可由用户以后正常下载补入，但无需重复已经完成的 181 页地图采集。

### 2026-10-08 用户完成官方五格式下载并读取核验（覆盖前节 1,487 条未取得）

- 用户已在 Downloads 下载 CSV/JSON/XML/RDF/XLSX，均为 `AED安装信息[_]2920001503698`。实际逐格式读取均 1,487 条、12 字段；RDF 另有 1 个数据集描述元素，不能计为设备。XLSX 第一张是“资源描述信息”，实际明细在“数据集1”A1:L1488，不可只读首表。
- 用表格技能的只读导入核对：CSV/XLSX/RDF 与 JSON 记录全 12 字段一致（忽略列序/记录序）。JSON 外层错误包成 `{[...]}`，原文件不是标准 JSON，只在内存去掉单对外层花括号读取；不覆写用户文件。XML 与其他格式有 80 个单元格、254 个 ASCII 空格被删，除此之外无差异，设备记录未增减。
- 原表 BH/GH/XH 均完整唯一 1,487；SBXLH 全占位符；安装地址缺 1。坐标布局混用：975 条百度经纬度装在 WDBD 一列、472 条百度经纬度分列、2 条 WDBD 为带标签的百度/腾讯说明文字；这 2 条已按标签经纬顺序核对可解析。合计 1,449 条含坐标、38 条所有坐标字段缺失；一个腾讯高德纬度字段有前导冒号，同条百度坐标有效。字段标签只能提供 CRS 线索，未做转换/校准或实际可用性核验。
- 对照地图：BH→serialNo 精确匹配 889 条且一对一；598 条未匹配。地图有 14,518 个非空唯一 serialNo、3,501 条缺号。按该单一键规则候选记录为 18,617，但不是确认的物理设备总数，未实际跨源合并/删除或按地址猜去重。
- 已将用户原文件逐字节复制归档到 `/Users/REDACTED/Downloads/深圳AED数据来源_2026-10-08/开放数据平台/完整下载_2026-10-08/`（目录700/副本600），原文件未变。最新 `完整下载校验.json` 记录五文件哈希及校验结果；根 `下载说明.txt` 已覆盖旧未完成描述，旧 manifest/独立校验 JSON 作为历史快照保留。没有重抓地图、改业务代码、导入、部署或实机测试。
- 中断前追加公开地图点接口只读核验：与已有分页列表同为 18,019 个 ID，差集 0；仍无公开证据解释独立 count 的 610 条差额，不猜隐藏参数或把 18,629 当已下载数。浏览器控制不再是本阶段阻塞。

### 2026-10-08 基于已下载数据的 AED 字段评估（建议，未实施）

- 用户仅要求判断数据库字段是否需增减；本轮未迁移数据库、未改业务 schema/客户端、未导入或部署。读取本地源码、两源 JSON/校验报告；当前存储是 `state_items(collection,item_key,payload)` 的逻辑实体，不能把“增加模型字段”误说成已有独立 AED SQL 表加列。未核对线上部署版本。
- 建议最小兼容方案：新增独立来源/待核验记录，保存来源集合＋源记录 ID（组合唯一）、可选业务 aedId 关联、原设备编号/柜号、地址与安装区域、原始坐标及 CRS、原始 status/isOpen/时段、批次与采集/来源更新时间、原始快照引用/哈希、解析问题与核验阶段；未知可留 null/UNKNOWN。原始大文件/联系人不进入热路径的 Aed 或客户端响应，AZQY 不强行当行政区，查询 distance 不当设备静态字段。
- 不建议删除现有 11 项 Aed 字段。开放时间/楼层/进入和核验耗时未知应由导入层承载，而不是删字段或伪填 0/全天开放；进入调度前须满足现有业务要求。已有 `source/permission/maintenanceOwner/verifiedAt/validUntil`、九态资产生命周期、托管/交接和修订字段直接复用，不重建平行状态体系。新增来源状态不覆盖资产占用/维护状态。
- 关键代码边界：`aedSchema`严格对象；Swift Aed 同样全部非 optional。`isAedOpen`起止时间相同返回全天开放；三项Seconds直接进入ETA。路线链路把 aedPosition 视为WGS84/GPS，源百度/未知CRS不能直接塞入。资产 REGISTER 等要求精度≤50m且真实核验时间有效，不能以抓取时间/编造精度满足。无asset的state.aeds仍沿用available，应禁止用fixture路径把公开点位直接设为可调度。
- 最小离线验证（启用 no-network helper、内存读取不打开数据库）：18,019条地图原对象及1,487条开放表原对象直接通过aedSchema均为0；纯合成探针00:00→00:00被schema接受且isAedOpen=true，证实不能拿它表示未知。没有跑/声称数据库迁移、线上或真机验证。
- 当前仅字段设计建议。后续实现需用户明确授权，优先导入/来源结构与解析适配；若要修改正式业务开放时间/available语义或SQL结构，先单独确认并同步契约、持久化兼容、iOS模型与回归测试。

### 2026-10-08 用户指定精简字段并完成三条隔离模拟写入

- 用户最新决定覆盖此前“保留开放时间/耗时”的建议：去掉全部开放时间、去掉三项预计取用耗时，floor 改为所在位置，accessNote 使用 XLSX 同条联系电话。当前明确交付为“挑几条模拟写入并展示数据库字段”；已在 commentary 说明只建独立本地示例，不改线上/既有业务模型。
- 示例核心 payload 恰为 6 项：id、name、aedPosition、location、accessNote、available。openFrom/openUntil/floor/floorTransferSeconds/accessDelaySeconds/verificationSeconds 完全不存在，不以空值或 0 伪保留。name 从站名派生；location 完整保留安装地址；accessNote 为“取用请联系：”加原始电话，不臆补区号。
- 数据直接只读导入原 XLSX 的“数据集1”A2:L2、A4:L5：塘坑站 FQ-8B022424、丹竹头站 FQ-8B022413、大芬站 FQ-8B022245。没有拨打电话。aedPosition 显式标来源 BD-09，未转换/独立确认；source provenance 记录此边界，无伪造 accuracy。available=false 仅表示示例未开放调度，不代表现场故障。
- 本地成果 `/Users/REDACTED/Downloads/AED新字段模拟写入_2026-10-08/`：`aed-field-preview.sqlite`、`数据库回读.json`、`拟写入记录.json`、`来源对应.json`、`写入校验.json`、`说明.txt`。数据库沿用 state_items(collection,item_key,payload)，示例集合 aed_preview，metadata preview_only=true；附只读查看视图 aed_preview_rows。不是迁移后的生产库，不能被原 App schema 直接加载。
- 实际 SQLite 事务写入 3 条后关闭、只读重开验证：integrity_check=ok、回读与输入完全一致、六字段精确匹配、旧字段无残留、电话与同源行一致、3条均未开放调度、原XLSX哈希未变。未修改现有 schema/后端路线/iOS，不声称真实 App 已适配。后续若实施全栈变更，按此新用户决定同步协议、持久化兼容、路线逻辑及客户端回归，不再恢复已明确要求删除的字段。

### 2026-10-08 示例 v2：区域附于地址、柜号及多联系人

- 用户追加柜号导入、多号码/含姓名的处理要求，并明确安装区域直接写在安装地址后。示例按 `location=安装地址（安装区域）`，cabinetCode 独立字符串；区域不另外堆入核心字段，但原始地址/区域均保留于来源对应记录。
- 新增 contacts 对象：raw 原文、entries[{name:string|null,numbers:string[]}]、needsReview。明确两人各有号码分别存；同一明确姓名多号码可组成数组；姓名后出现未标名第二号码，不继承姓名，保留 name=null 并 needsReview=true。号码为字符串、不补区号/不猜角色、分机不拆成独立号、不跨联系人或设备按号码合并。accessNote 仅展示原始联系文字，不能整段作为拨号串。
- 使用此前从 XLSX 直接读取且已逐字段校验的缓存 JSON，原工作簿 SHA256 再次一致。新增 FQ-87019443 与 FQ-8C024126 两个实际来源案例，共5条；原三条地铁点位同步新增区域和柜号。个人联系人数据仅保存在权限受限的本地示例，不在结果中批量展示手机号。
- v2目录 `/Users/REDACTED/Downloads/AED新字段模拟写入_2026-10-08/v2-区域柜号联系人/`，含SQLite、数据库回读、来源对应、写入校验和说明。第一版数据库未覆盖；v2完整性ok，写入回读5条一致，12项联系人解析边界测试通过，1条联系对应待核对；原6个删除字段仍缺省，全部available=false，坐标未转换。未改App、正式数据库或线上服务，也没有拨号/批量导入。


### 2026-10-08 UI 合并准备完成，待明确目标分支

- 用户要求“UI合并到主线”。实时本地及远端分支核对：没有 main/master；当前开发分支为 codex/architecture-repair-20260909（e8908b8），远端默认仍 codex/ios-mvp（8362af2 初始版本）。已异步请用户选择目标，尚未收到回答；不擅自移动旧默认分支或把全部107个已跟踪dirty文件提交。
- 原10/4临时baseline目录已为空。当前7个UI源码中6个仍匹配10/4验证哈希，ResponderNavigation另含10/8地图业务改动。已按HEAD逐hunk整理UI-only候选：六个Views+UITests，排除启动/登录恢复/Watch状态/范围圈开关与MapKit重写/高德优先/距离改道等其它未提交工作。当前真实源码与暂存区保持不变。
- 候选保留主题/卡片/标题/按钮/四组设置/大字布局/离线人数legend，以及场景切换真实tab等待、获取后截图和10秒按钮等待。独立源码审查确认业务调用、权限条件、地图计算与标识保持HEAD语义。
- 验证：在git archive e8908b8的干净副本上仅叠加这7文件，git apply --check、Swift语法解析与generic iPhone+Watch Debug无签名构建通过。此轮未跑Simulator或设备业务。
- 可恢复准备资料：/Users/REDACTED/Library/Caches/AEDResponseUIIntegration/20261008-0t5n1gvo，含 ui-only.patch、candidate-manifest.json、integration-status.json、before/head/candidate源码、build.log；已从易清理/tmp复制。当前没有新commit、合并、push或部署。
- 下一步：用户选定目标后，先重查HEAD/index/源码快照；若选择当前开发分支，以UI-only patch写暂存区、复核后提交，真实工作树其余改动全部保留。若选择旧默认分支，需重新评估其基线，不能直接把本候选当作已合并。


### 2026-10-08 UI 已进入本地开发主线（覆盖上一节等待状态）

- 用户明确“本地的代码优先”，据此采用当前本地开发分支 `codex/architecture-repair-20260909`，未切换旧默认分支。提交 `e44cbe3ba812bf8cac2aa8567274b9f064a4ea5d`：`style: polish native iOS action and settings screens`，7个UI/测试文件＋独立整合说明，共8文件。
- 已提交源码blob与干净基线构建通过的候选逐一SHA256一致。提交后再次确认7个本地源文件与本轮开始快照逐字节一致，其他功能仍保留未提交；暂存区为空，未自动推送、部署或安装设备。
- 本次提交只落UI，不把原Watch/启动/地图等混合未提交改动一起纳入；本地完整工作树继续保留这些功能。整合说明位于 `docs/design/ui-polish-2026-10-04/integration-2026-10-08.md`，快照/补丁/构建日志位于 `/Users/REDACTED/Library/Caches/AEDResponseUIIntegration/20261008-0t5n1gvo`。


### 2026-10-13 新 UI 已覆盖安装到 iPhone：2.0/build12

- 用户要求“部署到手机上”，并确认USB连接解锁；目标实读iPhone18,1/iOS27.2，安装前实际2.0/build11。以当前完整本地工作树构建，保留已提交UI与原本地功能，不仅取UI-only HEAD；206个iOS/contracts源文件完整快照且构建前后哈希一致。
- 本轮只把ios/project.yml的iPhone/Watch build11→12，XcodeGen重新生成project.pbxproj；其它生成文件与本轮前逐字节一致，没有业务源码编辑或提交/推送。显式保留既有AED_WATCH_SIMULATION条件，手机测试工具开关仍NO，不恢复真实Watch监控路径。
- 正式AEDResponse Debug签名构建成功，手机/内嵌Watch/独立Watch严格验签通过，profile有效且目标phone在列表；APNs development/Time Sensitive与Watch Fall权限保留。
- 普通ideviceinstaller对原bundle覆盖安装：InstallComplete100%、Complete、exit0。随后独立版本回读dev.codex.aedresponse 2.0 (12)、ProductType iPhone18,1。没有卸载或数据清理；不据此伪称登录运行状态已验收。
- 全部产物/配置before/源快照与日志：[BUILD_CACHE]/ui-build12-20261013._a5jevfc。证据索引docs/evidence/ui-phone-install-2026-10-13/。
- 本轮没有镜像/DDI/Simulator/服务端部署/救助事件；手机安装已完成，App启动与新UI真机显示由用户打开后确认。内嵌Watch已构建但本轮未独立核实手表设备安装，不将其混称已更新。新地图业务的服务器兼容与完整前后端验收仍单列。


### 2026-10-13 行动页地图主导第一版设计（待用户反馈）

- 用户要求隐藏“可以接收附近求助”状态卡，页面围绕地图搭建，扩大地图范围，并先出一版行动页重构。当前按先视觉稿处理，没有SwiftUI改动/构建/重新安装；手机仍为前节实际安装的build12。
- 内置imagegen首次生成成功，另进行一次针对按钮的编辑。最终展示稿 `docs/design/action-map-first-2026-10-13/concept-v1-refined.png`（851×1847）；初稿concept-v1.png、原始及编辑prompt同目录。根线程已view_image复核原参考和两张概念图。
- 方向：地图铺满整页，移除正常连接状态卡，右侧定位/列表控件，底部一个紧凑面板承载累计范围人数与上报按钮，保留安全说明及行动/设置两项导航。只展示本人点/范围圈；3/5/8明确示例，没有虚构个人/患者/AED位置。
- 后续实施保留列表功能、范围圈偏好、真实数据及上报二次确认；初始视野完整容纳最大范围圈，正常状态隐藏但异常用紧凑提示。只在用户认可方向后落实。
- 图是布局概念，不是真机或真实路网；按钮生成仍有轻微纹理且约44pt，实际实施应为纯#087F5B、至少52pt。细化规格见同目录README.md。没有改变既有业务或提交/部署。

### 2026-10-13 行动页邀请与接单后任务补图（待用户反馈）

- 用户追问“列表入口是什么、接受救助页面呢”。源码确认列表只显示不同统计范围内累计人数，没有个人名单或救助事件列表；接单不从该入口进入。首稿底部已显示人数，本轮建议移除重复列表按钮，尚未取得设计认可或实施。
- 补充两个完整单屏：`docs/design/action-map-first-2026-10-13/request-v1-refined.png`与`task-v1-refined.png`，均851×1848。内置imagegen分别生成，各作一次定点修正；原图及四份prompt保留。邀请最终图移除可能与1000米招募范围混淆的待命三圈，只保留本人点；任务最终图收紧底部面板至约1/3。
- 邀请卡沿用当前事件类型、粗略距离/预计用时、搜索范围、expiresAt倒计时与接受/拒绝操作；接受前不公开患者点、地址或路线。任务图为服务端确认`GO_TO_PATIENT + assigned`后的示例，主操作“开始前往”；取AED沿用地图/面板骨架并保持到达、领取、携AED前往患者的独立步骤。
- 保留接受后等待任务回执、失败/过期、退出确认/重试、团队、15秒改派及AED不可用规则。“更多”仅拟收纳原退出操作，不发明业务菜单。现有LiveRouteMap仅显示本人和目标点；图中蓝色线路属于未来通过MapKit绘制的重构提案，明确示意，不是手机现状或固定路线资源。
- 主线程view_image检查原图与最终两图；独立只读审核业务边界、可读性与流程规格。PNG完整性、Markdown空白与git diff --check通过。生成图按钮不是严格52pt，实施仍锁定纯色且至少52pt。详情见同目录README.md、RESPONSE-FLOW.md。
- 本轮仅新增/更新设计资料和交接，未修改SwiftUI、构建、安装手机、触发救助事件、部署或提交/推送。下一步等待用户评价布局，然后按认可方案实施，不能把这些概念图当作运行或接单验证。

### 2026-10-13 地图UI业务完整性复核

- 用户回复“好的”，要求最后确认UI没有丢业务。本轮核对Git、既有UI提交、当前源码、设计规格与测试源码；主线程独立将14个关键视图/状态/模型/通知文件与build12 Source做SHA256比较，全部一致。三个子任务分别只读核对待命/邀请、任务/退出、患者/账号/通知，未发现本次概念方案已删除业务的证据。
- 发现并补入设计实施约束：响应状态人数汇总、隐藏正常待命卡时保留最近事件结果、附近人数首刷/手动刷新/清理及120秒失效与请求隔离、实际可见邀请的VIEWED回执、改派接受/拒绝/超时/拒绝原因结果、楼层/进入说明、所有响应者退出三次确认及独立失败重试、完整SafetyBanner和全局模拟/错误/患者/权限/通知边界。细化位置见设计目录RESPONSE-FLOW.md新增“必须保留的业务与展示位置”。
- 确认旧有缺口：朗读位置卡有组件/服务但没有可见页调用，UI提交之前也未接线；接受/拒绝没有独立提交中禁用；已接受尚无任务没有专门等待面板。后两项只列为新UI反馈计划，未实施。视觉倒计时归零本身不清理邀请，保留既有失效通知/本地判定/REST对账，不虚构完成状态。
- 本轮仅补充设计核对结果与交接，没有SwiftUI/业务源修改、构建、测试运行、设备操作、救助事件、提交/推送或部署。下一步落实时按完整功能清单与三张图一起实现，并用离线UI回归验证；不得直接用图片可见控件作为裁剪业务的清单。


## 2026-10-26 行动/设置切换时地图刷新与任务重算审查

- 当前目标：解释用户观察到的切换设置后地图刷新，并区分地图重建、任务状态重置、MapKit 算路和服务端重新分配。本轮完成源码审查；没有修改业务实现。
- 已确认待命地图刷新链：`ResponderDashboardView.swift:23–24` 在出现时刷新附近汇总、消失时清空；`NearbyVolunteerSummaryCoordinator.swift:34–45` 的 refresh 本身也先 clear 并发布 nil。`NearbyVolunteersView.swift:113–120` 在无汇总时移除 LiveNearbyMap，返回数据后重新创建 MKMapView（256–263），重新初始化视角。因此仅删除 onDisappear 的 clear 不能完整解决。
- 已确认任务地图视角：`ResponderNavigationView.swift:582` 每次 onAppear 将相机设为 userLocation，会覆盖用户此前拖动/缩放。当前内嵌任务地图只画位置标记，不自行计算/绘制步行折线。
- 任务状态不会仅因 Tab 切换清零：`AEDResponseApp.swift:4–17` 在 App 层持有同一 AppStore；页面只读其任务投影。切页本身没有 disconnect/reset assignment 调用。
- 但算路确实与页面生命周期耦合：`ResponderNavigationView.swift:19–23` 的视图 task 启动后立即尝试刷新，随后每 30 秒尝试。`AppStore.swift:5064–5103` 仅按事件在途任务和上次尝试时间（至少 30 秒）等业务门禁抑制调用，没有输入指纹缓存。满足门禁且服务端提供 context 时，返页可以触发 GET context → MapKit → PUT routes → replaceEvent。离开页面取消视图循环，但 AppStore 已持有的独立算路 Task 继续；不会仅因快速切页并发重复计算。已取 AED、前往患者、已到患者及终态等受现有门禁保护。
- 服务端影响：`backend/src/service.ts:6897–6901` 接受新计算结果后会 refreshPatientRoutes / replanAssignments。非 ASSIGNED 的已有任务在 8776 锁定分工；尚未开始的 ASSIGNED 任务可按新结果改变角色/AED（8855–8864）；已开始的取 AED 任务可更新同一 AED 路线，相关代码不把进度清零。当前线上服务是否启用 CLIENT_MAPKIT 未查询，不将源码可达路径描述为用户手机本次必然发生的请求。
- 验证：读取 Git status、相关 diff、最近 5 次提交及项目规范，原有大量 dirty work 保留；7 个核心 iOS 文件 SHA256 均与 `Library/Caches/AEDResponseDeviceBuilds/ui-build12-20261013._a5jevfc/Source` 对应快照一致。这是历史 build 12 源码一致证据，不是当前设备版本或现场复现证据。
- 运行尝试：在 backend 执行 `node --import tsx --import ./test/helpers/no-network.mjs --test --test-concurrency=1 test/client-mapkit-routes.test.ts test/aed-reroute.test.ts`，网络由现有 helper 禁用；依赖导入约 84 秒无测试进展后终止，exit 1、2 cancelled、0 pass/0 fail，未到断言。不能记为测试通过或业务断言失败。未重复执行。
- 测试缺口：既有 `AppStoreArchitectureTests.swift:4386–4423` 仅覆盖固定时刻重复调用与服务端确认投影，没有跨 30 秒切 Tab；现有附近汇总测试覆盖取消后旧响应隔离，没有地图相机保留。未运行真机/模拟器、未访问线上后端或真实 MapKit。
- 下一步建议：将取消查询与清空有效展示缓存分开，保持 120 秒过期及权限/账号/角色失效清理；地图结构与人数加载状态解耦并保存视角；把路线刷新周期放到业务生命周期内，按位置/患者/AED/有效期等必要变化触发，保留服务端分配权、在途去重和重试。不要只删除页面 timer 而使路线失去正常更新。
- 本轮修改文件仅 HANDOFF.md（本节）。不得破坏患者优先、任务进度、AED 占用/获取幂等、改派确认、120 秒汇总新鲜度、原有未提交修改；没有构建安装、提交、推送或部署。


## 2026-10-26 地图切换刷新修复（覆盖上节待修状态）

- 当前目标与状态：用户明确回复“修复”。已完成行动/设置切换导致地图重建、视角复位与额外算路触发的代码修复；没有改后端分配规则、提交/推送/部署或重装手机。
- 附近汇总：`NearbyVolunteerSummaryCoordinator` 将取消查询与清空展示分开；仅保留同会话且120秒有效的缓存，错误/取消/迟到响应受代次和业务门保护；`clear()`、账号/权限/角色改变仍清理。`AppStore.refreshNearbyVolunteersIfNeeded()` 供返页使用，手动下拉仍强制刷新。移除待命页onDisappear清空，不再把页面不可见当作业务失效。
- 地图：`NearbyVolunteersView` 统计缺失/过期仅清除范围圈和人数，真实地图子树保持；明确显示人数暂不可用，不伪造0。尚无统计时初始视野按契约最大2km预留，统计到达无需抢走用户镜头。`LiveRouteMap` 只在首次显示、任务或真实目标改变时初始化相机，纯Tab往返不复位。主动列表/地图切换仍是不同显示模式；系统MapKit是否自行重绘未真机验证。
- 算路：新增 `ClientRouteRefreshCoordinator` 由 AppStore 持有，按event/assignment/connection管理30秒周期，同context投影不重启计时；场景active标志只来自App.scenePhase，避免后台Watch恢复误开前台周期。任务页不再拥有周期task。保留原有单飞、30秒尝试间隔、60秒服务端context/quote有效期和REST确认结果；不采用坐标不变永久缓存。
- 生命周期与权限：周期要求真实前台、有效REST会话和已恢复投影；Socket只是通知提示，尚未ready/短暂断线不阻止已恢复REST周期。明确disconnect/重建会话/退出/业务停止取消周期；后台暂停周期，但合法在途算路和原有REST状态变化触发仍按既有流程处理，不宣称关闭全部后台算路。等待边界再次验证当前任务/角色/阶段；获取AED/终态/切换任务后旧结果不能提交或覆盖，新旧算路提示按context隔离并及时清理。
- 修改文件：`ios/AEDResponse/App/{AEDResponseApp,AppStore}.swift`；`Application/{NearbyVolunteerSummaryCoordinator,ClientRouteRefreshCoordinator}.swift`；`Views/{ResponderDashboardView,NearbyVolunteersView,ResponderNavigationView}.swift`；`AEDResponseTests/{APIClientSessionRotationTests,AppStoreArchitectureTests,ClientRouteRefreshCoordinatorTests}.swift`；`AEDResponseUITests/AEDResponseUITests.swift`；`ios/AEDResponse.xcodeproj/project.pbxproj`（由原project.yml生成，仅加入新源码/测试引用）；`scripts/ios-smoke.sh`（接入新增测试过滤项）；本HANDOFF。原有大量dirty改动保留。
- 已运行验证：原生macOS SwiftPM执行生产路线调度器的5项XCTest，5/5通过；Swift 6编译生产Nearby coordinator/domain并用假API运行7项行为检查，7/7通过；Swift语法检查、bash -n scripts/ios-smoke.sh、相关git diff --check通过。新增5项缓存XCTest、2项AppStore集成测试和2项离线UI往返测试；后者未在设备/模拟器执行，不能把编译等同断言通过。
- iOS验证：generic iOS `AEDResponseUnitTests build-for-testing` 最终exit0 / TEST BUILD SUCCEEDED，TestHost与单元测试包编译链接通过。原Desktop构建在NSFileCoordinator读取等待，随后用临时副本；两个Login.strings与ControlledTests.entitlements为原路径云占位，使用build12已缓存的非代码资源。实际编译的127个Swift文件与当前工作树逐字节一致；SocketIO/Starscream按现有锁定commit从本地Git缓存导出，只有临时工程使用本地依赖路径，没有改正式依赖版本或下载。
- 构建过程发现的lazy属性循环类型推断已添加显式类型修复，最终成功构建覆盖此修正与2km初始视野。详细日志及源码hash位于 `/tmp/aed-tab-refresh-20261026.5eiB0S/`，成功日志 `build-for-testing-local-final2.log`、`swift-staging-sha256.json`。路线原生XCTest日志 `/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aed-client-route-refresh-cg94626x/test.log`；附近汇总原生验证 `/tmp/aed-nearby-summary-check-20261026/Harness.swift`。
- 后续与约束：需安装新构建后实际检查MapKit视角、快速往返及停留设置超过30秒的表现，并运行新增AppStore/UI断言。本轮没有启动设备/模拟器、线上API、真实MapKit算路或救助事件。保留患者优先、任务进度、获取AED回执幂等、改派确认、服务端分配权和120秒统计新鲜度；不自动提交、推送、部署。

- 收尾补充：同一临时工程执行 `AEDResponseTestHost build-for-testing` 也exit0 / TEST BUILD SUCCEEDED，包含新增UI用例的AEDResponseUITests编译链接通过；未运行UI断言。日志 `build-for-testing-ui-final.log`，两scheme汇总 `build-verification.json`，资源来源 `noncode-cached-resource-provenance.json`；最终127个Swift源码与工作树再次逐字节核对一致。


## 2026-10-26 地图切换修复已覆盖安装到 iPhone（2.0 / build 13）

- 用户明确要求“安装”。当前连接的iPhone 17 Pro安装前独立查询为`dev.codex.aedresponse` 2.0/build12；正式AEDResponse Debug签名构建成功，覆盖安装命令exit0，安装后独立设备查询确认为2.0/build13。
- 修改仅生产phone/Watch的构建号：`ios/project.yml`从12升13并由XcodeGen同步`ios/AEDResponse.xcodeproj/project.pbxproj`；与本轮备份逐行对比，只有构建号变化。地图修复及原有dirty源码完整保留，没有自动提交、推送或部署。
- 沿用build12的既有Watch模拟编译条件；phone测试工具/拨号器/测试特性均为NO。正式phone、内嵌Watch及独立Watch bundle严格验签通过，profile有效、原有phone APNs/Apple登录/Time Sensitive及Watch跌倒权限保留；内嵌和独立Watch可执行文件hash一致。不能据此称物理Watch已经更新。
- 构建复用已验证的本地依赖源码副本，83个生产Swift文件构建前后与当前工作树逐一SHA256匹配。两个Login.strings仍使用此前build12非代码缓存以避开原路径云占位；没有替换Swift源码。
- 安装采用原bundle ID直接覆盖，没有卸载或清理应用数据。没有启动App、真实算路、救助事件或UI自动测试；当前证据为签名构建、安装成功和设备版本回读。下一步可由用户打开App检查行动/设置往返视角与刷新。
- 完整产物、修改前配置、源码清单、构建/安装日志及独立回读位于 `[BUILD_CACHE]/map-refresh-20261026.xIL0JS`；关键文件为`build.log`、`signed-verification.json`、`install.json`、`installed-after.json`、`installation-verification.json`。

## 2026-10-26 地图主导UI已实现、验证，build14待USB安装

- 用户在确认设计和业务清单后同意继续实现/验证/安装。已经将待命、邀请、任务页面改为原生全页地图和单一底部浮层，隐藏正常待命卡，移除重复列表入口；统计/定位/范围圈/刷新/上报门禁及确认保持。任务地图新增只用于展示的MKDirections步行折线，不改变服务端分配，也不恢复视图周期业务算路。
- 保留完整AED阶段、患者位置楼层/进入说明、协作团队、响应状态、改派倒计时/结果、三次退出及失败重试、最近事件结果、异常/未知人数和完整安全文案。RootView、患者和设置分支未改；6份修改Swift为Dashboard/Nav/Nearby/AppStore/AppStoreArchitectureTests/UITests。构建号phone/Watch13→14并XcodeGen同步工程。
- AppStore新增决策提交中状态/防重复和请求/会话UUID隔离、只读VIEWED等待和复用原过期清理入口。邀请按messageId可见任务推进VIEWED、按原时间判定过期并REST对账；过时结束任务不盖新邀请。TestHost专用离线夹具不再将无服务端可ACK的回执塞入上传队列，不清/ack任何真实遗留回执，生产门禁不放宽。
- 162项业务单测最终完整通过；10个不同离线UI场景最终通过（9普通、1深色最大辅助字号，分批复测）。包括完整AED链、患者误报/结束、接单前隐私/接单后任务、三次退出取消重置、任务设置往返、范围圈关闭仍保留人数、地图尺寸、主按钮≥52pt及可操作。修复既有Presence测试等待精确1条的竞争，未改定位业务和字段/节流/授权断言。
- 手机与Watch生产签名构建成功，三bundle严格验签/profile有效，原权限和phone NO测试开关保持，Watch模拟编译条件与build13相同；内嵌/独立Watch二进制匹配。不据此称手表已更新或真机业务已验收。
- 最新源码快照/日志/测试xcresult/签名/备份位于`[BUILD_CACHE]/action-map-first-20261026.hkwuih3c`。127份构建Swift与清单一致，73份生产phone源码和6份修改Swift最终与工作树一致；5份未改Watch源与TestHost选择器原路径复读超时，沿用本轮初始冻结副本，均与build13缓存一致。Login等未改非代码资源沿用已验证缓存。临时工程用原锁定commit的本地SocketIO/Starscream依赖，隔离SPM目录争用，正式依赖版本未改。
- 原生截图及三概念对照结果在`docs/design/action-map-first-2026-10-13/README.md`和`screenshots-2026-10-26/`；结构化汇总`implementation-verification.json`。主线程view_image逐对检查正常三页与生成稿，地图瓦片/系统Tab等平台差异、完整业务额外内容和离线测试标识已明确。
- **安装尚未执行**：最初USB回读phone为2.0/build13，最终安装前ideviceinstaller返回No device found；CoreDevice仍能无线发现原iPhone17Pro(available paired)，但USB/传统WiFi安装通道均未枚举。已异步请用户USB连接并解锁，不能把build14包已准备说成手机已更新。继续优先使用ideviceinstaller覆盖原bundle，避免DDI/镜像或卸载清数据；安装后独立回读版本再更新本节。
- 本轮只启动既有强制离线TestHost模拟器并恢复外观/字号，无真实后端/救助事件、无服务器部署、无提交/推送。朗读位置卡旧有未接线未修。下一步连接后安装；真机地图、真实接单/后台/导航仍需单独验收。

## 2026-10-26 build14已覆盖安装并独立回读

- 上节等待USB的状态已被本节取代：CoreDevice原有localNetwork配对隧道处于connected，开发设备服务安装前已可用，复用该通道完成覆盖安装；未另执行DDI下载/挂载命令。
- 原iPhone17Pro、bundle `dev.codex.aedresponse`安装前查询2.0/build13；`devicectl device install app`返回success；之后独立`device info apps`确认为2.0/build14。证据见构建缓存的`installed-before-coredevice.json`、`install.json`、`install.log`、`installed-after.json`和`installation-verification.json`。
- 未卸载/清数据/主动启动App，未执行真实后端或救助操作；Watch包已构建签名但未验证Watch设备更新。162单测、10个不同离线UI场景最终通过的结论不变，真机业务和真实地图路线仍未在本轮验收。
- 设计README顶端及`implementation-verification.json`已更新为安装成功。当前修改仍未提交/推送，原有未提交内容完整保留。
