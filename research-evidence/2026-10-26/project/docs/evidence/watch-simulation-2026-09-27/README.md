# Watch 起点受控模拟（进行中）

用户已授权仅测试版入口及对应部署；仅现有 iPhone 17 Pro + Watch 为真机，两名响应者为独立受控客户端。禁止镜像、DDI、Simulator、真实 Fall/SOS/呼叫及外部人员招募。

## 实现与验证

- 测试 Watch 使用合成输入，复用 FallEmergencyCoordinator、独立受保护 outbox、即时/后台 WCSession 和 iPhone 当前登录会话。测试直传完全禁用，未改变独立 App Attest 门禁。
- 服务端默认关闭、限时最多90分钟、精确设备队列、入队事务二次授权、根 `SIMULATED_TEST` 与嵌套 syntheticWatch 原始证据。沿用正常业务状态机与隔离白名单。
- 本地后端全量721/721，Watch纯逻辑50/50，iPhone+Watch签名 build 6成功，手机/独立Watch/嵌入Watch全部严格验签。纯逻辑不是设备通信验收。
- 线上基线为 watch-relay-20260926-r1；候选 watch-simulation-20260927-r1 仅移植本次链路，不发布整个脏工作树。候选本地及VM均通过check/build、463/463原测试及4/4新增HTTP+Socket隔离/两任务/AED/结束测试。基线没有增量state API或关闭账户字段，移植沿用其原store接口及用户存在性/响应可用性门禁；没有带入其它架构重构。
- 源包 SHA-256 `b88b5b275fd16126143f7cbbf4eb67dfaac544811661c80f34694dd5104bccc5`；工作目录 `/tmp/aed-watch-simulation-20260927.dV6GU0` 保存代码基线、候选、日志和签名产物。
- 01:01普通USB完成build 6覆盖安装；手机查询CFBundleVersion=6。01:01:42 appconduitd记录Watch `Finished install` 和 `acknowledged`。未清理登录或正常业务队列。
- Release Watch SDK构建通过：即使命令行传入测试变量，Release未定义DEBUG或测试条件，测试入口分支不编入；这是编译隔离验证，不是已将Release装回真机。新增OpenAPI端点契约smoke5/5、git diff --check通过。

## 当前边界

01:07完成服务端一致性备份（backup service Result=success），切换至限定候选 `watch-simulation-20260927-r1`。服务active、NRestarts=0，公网health200，模拟端点未认证401；未改App Attest配置。新测试许可75分钟，至北京时间2026-09-27 02:22:15到期，runId `REDACTED-ID-0046`。

私人IPC只为该run注册两名新受控账号；两客户端均已bootstrap及真实WSS `system:ready`。患者手机尚未打开/刷新位置，runner在明确等待，不谎报响应者定位已就绪。01:09复核仍为4个历史终态事件、0 ACTIVE；没有实际Watch事件。已请用户打开手机和Watch、先确认测试按钮，尚未让用户点触发。

新增配置均为本轮独立文件：`/etc/aedresponse/watch-simulation.env`、`/etc/systemd/system/aedresponse.service.d/90-watch-simulation.conf`；运行manifest和仅两个虚拟账号凭据在服务器root私有0700目录 `/var/lib/aedresponse/watch-simulation-20260927-r1`，未输出或复制患者凭据。到期服务端拒绝新模拟，runner有75分钟硬截止并尝试退出自己的账号。完整收尾仍需撤下该drop-in/env并重启、确认无活动事件和测试身份不可认证。

新增运维runner只控制两个指定测试身份，使用普通HTTPS/WSS进行接单、状态、位置批次和AED回执。患者凭据不读取、不复制；结束由患者手机UI操作。全流程结束后关闭测试许可，保留审计记录；旧解析器不支持新嵌套观察，事件产生后不能直接回退旧版本解析器。

## 10:43后续真机回合：真实创建与患者结束已通过

- 昨晚许可已过期且0 ACTIVE，旧runner不在运行；重新核对同一手机/Watch后开启r2。没有复用过期授权。r1的两个测试账号随后通过正常refresh/logout撤销账号族（204），不影响患者账号。
- r2 `REDACTED-ID-0047`：首次用户报告“测试未就绪”。旧UI隐藏具体错误，未获得能唯一归因的请求证据，**不能称其根因已查明**。新增简短分类提示和仅方法/状态码的手机即时RPC日志，build7已严格签名验证并通过USB装到两端（Watch10:52:55–57实际安装ack）。51项Watch纯逻辑通过。
- 随后用户在Watch回答需要帮助，确认手机出现事件。数据库明确记录：合成Fall `2026-09-27T02:53:25.416Z`、事件创建 `02:53:29.124Z`、根/triggerSource均SIMULATED_TEST、triggeringWatch与nestedWatch都匹配实表、NEEDS_HELP；手机真实P为IPHONE_PRIMARY，后续正常刷新。事件总数4→5、ACTIVE=1。
- WSS两名指定响应者都收到response:requested；只有这两条delivery，外部delivery/notification均0。由于最初runner等操作员手动accept，两条30秒offer已过期，**这轮没有接单/任务/AED验收**。未回填决策时间或改写过期记录。
- 用户在手机“结束救助→问题已解决”后确认回待命。只读复核r2=RESOLVED，总数5/ACTIVE0，保留30条本轮通知及过期邀请事实。这轮证实Watch→iPhone→服务器创建、手机位置接管、隔离招募与手机结束，不是完整响应者闭环。
- 修正测试runner：首次heartbeat见到合法本轮offer立即VIEWED+ACCEPT，不依赖聊天响应；2项独立函数回归通过，过期测试与外部事件在任何写操作前拒绝。虚拟响应者固定在各自合成测试位置，不随患者GPS刷新节奏停掉heartbeat；没有修改实际患者定位或服务器新鲜度门禁。终态使用本轮精确只读审计识别，因为listEvents会隐藏终态/过期邀请；退出自身设备和账号会话，私有JSONL日志不含令牌或坐标。

## 当前r3与一键要求（build8已实装，待触发）

- 用户明确“点击后就从Watch发出跌倒信息给绑定iPhone，不再询问需要帮助”。只调整受控测试composition：`WatchSimulationInput`一次调用完成合成输入+模拟NEEDS_HELP并走同一协调器/outbox/RPC，UI仅单按钮/发送中/结果；正式Fall的确认流程不变，不宣称模拟字段为真实用户回答。
- 51项Watch测试通过，自动接单2项通过；build8签名构建、三bundle严格验签通过，手机与Watch bundle version均8。11:03:00 Watch实际Finished install/ack，普通USB覆盖，无镜像/DDI或清登录。
- r3 `REDACTED-ID-0048`，到北京时间12:14:20到期。r2已明确结束后才换新run/新虚拟身份。两名r3响应者已注册、WSS ready、位置年龄约2秒，11:03只读仍5个历史事件/0 ACTIVE。
- runner PID545587，由私有FIFO `/run/aedresponse-watch-sim/control-r3` 控制；日志/凭据/manifest位于root私有 `/var/lib/aedresponse/watch-simulation-20260927-r3`。后台客户端仅在75分钟窗口内运行，自动接单；导航/AED/到达仍需按阶段发送命令。无新Watch触发时不创建事件。已请用户重新打开两端、只点一次模拟跌倒，暂不结束新事件。

## 11:06一键真机证据与测试客户端回执修正

- 用户确认build8只点一次即让手机出现新事件。r3合成Fall `03:06:33.066Z`，服务器创建 `03:06:33.384Z`，SIMULATED_TEST/实际Watch绑定均匹配。手机USB日志11:06:33.000 `simulationContext status=ok`；11:06:33.917 HTTP201；11:06:33.924后台 `simulationObservation status=ok`；11:06:33.989即时同方法ok。数据库只增加一条事件（5→6），可见后台/即时并发没有重复创建。
- 两名虚拟客户端都收到WSS招募，外部邀请/通知仍0。但自动accept前的receipt代码错误地SENT→VIEWED，真实后端严格要求SENT→DELIVERED→VIEWED，因此409。两条offer随后EXPIRED，无任务；一次当前时间的补充受控读取确认已无可接offer，没有回填时间/篡改数据库，也没有强行接受过期邀请。
- 修正runner为完整回执顺序，已增加实际函数+真实HTTP组合测试，覆盖自动回执/接单、两分工、R→A→P、幂等AED_ACK和完成。当前本地定向7/7，VM上用**线上服务源码**启动隔离临时内存HTTP后端，5/5通过（包括实际runner完整流程）。这些是本地/VM临时测试，不是本次实机任务已完成。修正helper SHA256 `6ded8086a33b18b2484191986bac77aa4f18fa187facd8aaab5c654221330711`。
- 先前的自动接单2项模拟request测试未覆盖真实回执转换，所以不足以发现409；本次真实HTTP回归已补入主npm test。修正前一轮全量723/723通过；新增完整runner HTTP回归后的全量数字尚未重跑。`npm run check`及定向真实HTTP通过。
- 11:11已请用户在手机结束r3并回待命，准备下一run。不要把尚未完成的接单/导航/AED实机闭环算作通过；不得复用过期offer。build8一键链路无需再次改App。

## r4准备与最新回归

- 用户确认结束后，r3在03:14:07Z=RESOLVED、两虚拟身份03:14:08正常退出设备/账号并停止runner，available=false；6个事件/0ACTIVE/0外部邀请通知。
- r4 `REDACTED-ID-0045` 许可到北京12:29:57，使用修正helper（SHA同上），未改业务认证或30秒邀请规则。服务健康；私有runner已注册两身份并连接WSS。首次启动曾因IPC尚未ready而在注册前退出，随后加IPC检查/文件锁并成功启动，无重复账号或事件。
- 最新本地完整后端 **724/724通过**（backend-full-r4.log），包含真实runner完整HTTP回归。仍不能替代r4实机执行。
- 11:17已请用户保持手机前台、Watch单击，r4自动接单，再由操作员推进任务。初始手机GPS较旧时runner明确等待新位置，未改变实际患者位置或新鲜度规则。

## r4实机结果：一键链路、招募、接单、前往患者完成；AED分支受数据阻塞

- 用户确认新事件出现。Watch合成时间 `03:18:11.747Z`，服务器 `03:18:12.030Z` 创建唯一r4，事件总数6→7；根/triggerSource均SIMULATED_TEST，触发表/nested表均匹配，手机P为IPHONE_PRIMARY。
- 03:18:19–20两虚拟响应者都收到真实WSS邀请；03:18:28.536与03:18:32.201分别正常完成送达/查看/ACCEPT，两delivery=ACCEPTED。没有过期接受或改写数据库，外部delivery/notification均0。
- 两个assignment都为GO_TO_PATIENT。03:19:20–21通过正常接口进入EN_ROUTE并收到WSS assignment:updated；03:22:03–08分别ARRIVED_AT_PATIENT→COMPLETED，API和持久状态确认，不代表真人实际行走。没有FETCH_AED任务或AED_ACQUIRED回执，不能标记整套AED闭环通过。
- 明确原因：已有`aed-demo-01/02`均available=true且24小时开放，但距本次实际患者P约91.5/91.1公里。线上使用配置的AmapAedRouteProvider（不是本地Reference测试路由）。只读诊断使用同一planner和正常配置：坐标转换成功（HTTP200/status1/10000），walking返回HTTP200/status0/OVER_DIRECTION_RANGE/20803，planner结果UNAVAILABLE/PROVIDER_UNAVAILABLE。诊断未输出密钥、请求URL或坐标，也未改AED数据/切换路由提供者/强制分工。
- 11:22之后已请用户核对手机两人完成状态，并结束本轮模拟；另请求允许补充**仅本次模拟可见**的附近虚拟AED以继续。用户未批准前不改现有AED坐标或添加全局虚拟资产，不把91公里样本强行视作附近设备。
