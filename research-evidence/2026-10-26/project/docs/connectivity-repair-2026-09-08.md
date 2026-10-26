# 联通修复与17 Pro蜂窝验证

## 授权与范围

用户恢复修复授权，要求联通可靠性达到上架要求；随后明确今天只使用17，不操作16。此次未宣称完整产品上架就绪，未发布商店版本。手机只安装真实联网构建，未运行会覆盖手机的离线测试宿主。

## 已修复

1. **实际消息发送**：模拟事件事务提交后发送patient-activated和response:requested，不再只生成SENT记录。
2. **不停服的管理输入**：私有Unix IPC由活跃服务处理，CLI不直接打开数据库、不停服，不公开新增HTTP触发入口。目录0700、socket0600，默认无配置即关闭；正式环境不装模拟管理配置。
3. **重连和未送达重试**：Socket房间加入和设备状态确认后补发有效请求；持久SENT每5秒重试，收到回执或过期后停止定时重试。保持原消息ID、30秒有效期和真实回执语义，不恢复过期请求。
4. **手机状态恢复**：恢复连接只清除对应旧错误，不抹掉其他错误；回前台重新取REST状态。待命R及可响应状态ACK后刷新附近人数，处理依赖状态尚未更新时的早期失败结果。
5. **积压不阻塞网络**：从最后封口秒槽继续，补录逐槽让出MainActor；冷启动恢复每次最多5槽，再让出执行时间。既有批次、坐标、秒槽和隔离证据不删除、不倒填。
6. **时间编解码性能**：每个编解码操作复用带锁ISO格式器，不再为每个日期创建解析器；保持毫秒向下截断和整数秒兼容。

主要文件：backend/src/{service,server,config,simulation-admin}.ts；backend/deploy/azure/{create-simulated-event.mjs,aedresponse-simulation-admin.conf}；ios/AEDResponse/{App/AppStore.swift,Domain/Models.swift}；相关回归测试。

## 代码验证

- 本地和Azure完整后端124/124通过，TypeScript check/build通过。新增真实IPC→Socket测试覆盖实际发送、重连补发、过期不复活、相同ID重试及默认关闭。
- iPhone真实联网Debug构建通过并安装17；新增恢复分段测试源码build-for-testing编译通过，未安装/运行离线宿主，因此不将该步骤写成真机单元测试通过。
- 独立Mac Swift测试：1500个时间戳往返、毫秒不跨槽、整秒兼容、非法时间拒绝均通过；旧实现约0.466秒，新实现约0.081秒。不是跨硬件性能承诺。
- `git diff --check`通过。未自动提交或推送。

## 实机和服务器证据

- 17经USB调试，真实HTTP任务metrics的有效响应均cellular=true；没有以Wi-Fi探针或开关状态替代实际请求证据。
- 用户确认17显示“模拟测试”患者页。真实REST事件/时间线读取200，Socket收到system:ready。
- 发现本地积压且没有发送后，定位MainActor补录阻塞并修复。最终积压队列到0，事件批次通过蜂窝持续200；期间30个取消请求的相同路径随后均成功。
- 最终服务器保存311个事件批次、1516条记录，含真实FIX与如实记录的NO_NEW_FIX；没有删除旧数据。
- 用户仅在17点击误报：2026-09-08T13:38:46Z，确认接口实际cellular=true、HTTP200；服务器终态CANCELLED_CONFIRMED_FALSE_ALARM，reason=FALSE_ALARM，resolvedAt=13:38:46.744Z。
- 17 currentEventId=null、最新位置回到R；最后两次事件批次ACK用于收束此前已采集数据，随后队列0，不是继续采样新患者轨迹。
- 最终待命版本再次安装17，21:42:49的附近人数请求均HTTP200、cellular=true；同刻authenticated/agreementsComplete/businessAccessReady均true、connectionState=connected，legacy兼容关闭。之后恢复普通无诊断环境启动，没有操作16。
- 线上私有管理IPC对既有清单幂等重放返回replayed=true，前后MainPID均27427，未创建新事件、未停服。

## 必须披露的限制

- 历史秒槽核对存在199秒缺口：13:24:56–13:28:14Z，属于旧阻塞/重启阶段。没有原始记录就不事后伪造；已存记录唯一无重复。最新修复后的观察段连续，但不能声称整段历史已满足每秒完整性。
- 此次没有16接受请求，也没有双机蜂窝任务闭环或多人AED分配验收。
- 没有完成后台/锁屏/终止后的APNs实际投递、真实SMS/Apple身份全流程、Watch特殊权限与系统Fall/Emergency SOS验收。
- 当前SQLite单写者参考后端不是已完成的境内PostgreSQL/PostGIS、持久队列与正式高并发架构；20万用户/2万在线/60分钟验收没有通过证明。
- 因此这是明确联通缺陷的修复与17单机实测，不是“全部达到上架条件”的声明。

## 部署与证据路径

- 候选/回滚代码：`/opt/aedresponse/releases/connectivity-repair-20260908`、`/opt/aedresponse/releases/before-connectivity-repair-20260908`。
- DB备份：`/var/lib/aedresponse/backups/before-connectivity-repair-20260908.sqlite`。不得恢复旧库抹掉之后的事件证据。
- Azure测试日志：`/home/REDACTED/aed-connectivity-repair-tests-20260908.log`。
- 本机证据：`/tmp/aed-connectivity-release.gGDotU/`；日志含精确定位，禁止公开整目录。另有`/tmp/aed-connectivity-repair-backend.log`。
- 模拟事件 `REDACTED-ID-0003` 已正常终结，不自动另建事件。
