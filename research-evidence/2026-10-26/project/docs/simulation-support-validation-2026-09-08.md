# 模拟事件支持：实现与部署记录

用户已明确批准测试支持改动和部署，保留“发现业务bug只记录、不修复”的约束。

## 实现

- 独立 `SIMULATED_TEST` 触发来源与观察结构，只有管理批次、时间、两用户/设备绑定，没有Fall、外拨或App Attest字段。来源和绑定追加后不可改写或删除。
- 管理方法 `createSimulatedEvent`：默认关闭，原服务main/loadConfig不启用；独立VM管理工具必须显式启用，服务停止后才允许单写者操作。没有新增公开HTTP触发路由或匿名身份入口。
- 创建前要求两名不同受控用户、两台不同iPhone、现有协议/权限/可参与状态和真实位置合格；存在任何活动事件即拒绝。不会伪造GPS；使用患者手机已上报的最近真实位置作为初始P。
- 逐设备与逐用户白名单限制患者可见性、事件投影、候选筛选和请求发送。正常接受/分配/退出/位置/结束逻辑不变。
- REST事件与响应请求返回最小模拟标记，仅runId/label，不包含白名单身份；普通operator投影同样带标记，以便区分模拟记录。没有实现或声称真实救助统计系统已上线。
- iPhone识别标记并显示“模拟测试 · 非真实急救事件”；解码拒绝跨事件标记、模拟患者混入Fall证据，以及模拟请求中夹带精确患者字段。新来源没有通过弱化未知字段校验来接入。

## 保持bug未修复

后端候选来自线上源码的哈希一致快照，而不是把本地较新的整个工作区发布。
线上main/server未改，仍没有Apple challenge路由；COMM-01未修复。

17 Pro重装测试支持时显式设置 `DEBUG AED_CONTROLLED_TEST AED_LEGACY_LATEST_POSITION_CADENCE`。
该仅测试兼容开关让最新值队列保持原未限频行为，避免把本地频率修复带给17。
16未设置，维持它前一阶段已装的频率门控；事件参与者秒槽批次不受此开关影响。
手机实际日志确认：17 legacyLatestPositionCadence=true，16=false。
这是对既有过频行为的受控兼容，不是保留旧二进制，也不是修复COMM-02。
正式目标/Release无法打开该兼容分支。

## 验证

- 隔离后端：原114项回归通过；新模拟测试覆盖默认拒绝、禁止Fall字段、独立用户、幂等、拒绝并行活动事件、第三人不可见/无请求、模拟标记、证据不可删除/改绑、SQLite重启保真、正常接受后GO_TO_PATIENT任务。
- Azure候选：编译通过，115/115测试通过，日志 `/home/REDACTED/aed-simulation-candidate-tests-20260908.log`。临时数据库合成测试，不是实机救助事件。
- 主工作区：check/build相关检查通过，`npm test` 122/122；比候选多出的测试来自本地已开发但未随本补丁上线的功能。
- iPhone16真机单元回归223项：207通过、16条件跳过、0失败；其中新增2项模拟契约测试。不是模拟器，也不是已完成实际任务分配。
- 两台测试支持Debug签名构建、codesign严格校验、覆盖安装和启动通过；没有卸载、重发身份或代签协议。此后追加的兼容开关由两台实际诊断日志验证。
- 正式iPhone及内嵌Watch Release未签名编译通过，日志 `release-build.log`；该结果不代表Watch entitlement或真机系统Fall能力获批。
- 20:45:42部署短暂停服，17在20:45:43、16在20:45:45重新Socket连接并收到ready。服务healthz正常、数据库integrity_check=ok，仍2用户/2设备、无事件/任务。

## 部署与恢复边界

- 候选：`/opt/aedresponse/releases/simulation-support-20260908`。
- 旧src/dist：`/opt/aedresponse/releases/before-simulation-support-20260908`。
- 一致性数据库备份：`/var/lib/aedresponse/backups/before-simulation-support-20260908.sqlite`。
- 仅从候选覆盖既有src/dist和新增管理工具；账号、凭据、运行配置、数据库表结构未改。模拟记录一旦产生，旧解析器不能读取新来源；不得为回滚删除测试证据或恢复旧库丢弃后续写入，应使用兼容模拟解析器的代码恢复方案。
- 线上main SHA256：980df7e74fc2dfefe21a0c793f648aa1307000b1afebe32d5b52770c702b108f。
- 线上server SHA256：af0b6273dc6d5db9a9f88b6bd42bb46b50add1b4222f94b6abdfecbaa5c4f2b7，与部署前一致。
- 本地隔离候选/证据：`/tmp/aedresponse-simulation-support.C8agIa`。手机live日志含精确位置，仅本机保存，不公开整份。

## 下一步（尚未执行）

等待用户确认两台保持解锁并准备操作。管理清单在触发时生成新runId和requestedAt，绑定16患者/17响应者，然后备份、停服、管理工具创建、立即恢复。
不要在用户未准备时提前制造会过期的请求；本轮尚未生成管理清单或模拟事件。
随后依次测试接受、位置同步、唯一响应者退出、另外事件的正常结束与误报。出现业务bug记录并停止受影响场景，不修改；若为测试驱动自身错误，必须明确与产品bug区分。
