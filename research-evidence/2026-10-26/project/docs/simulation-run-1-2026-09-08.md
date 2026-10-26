# 首轮模拟触发：测试工具权限阻塞，未修复

## 执行范围

用户确认“准备好了”后，按已批准范围尝试创建16患者/17响应者的首个模拟事件。
runId：`REDACTED-ID-0051`。
清单requestedAt：`2026-09-08T12:49:25.000Z`，不是实际事件成立时间。

执行前两台connected，服务器active、0活动事件，两用户最新位置均在有效期内。
已建立备份 `/var/lib/aedresponse/backups/before-simulation-run-1-20260908.sqlite`，
以服务账号启动管理工具；退出时的恢复步骤已重新启动业务服务。

## SIM-01：模拟管理脚本不可被服务账号读取（确认）

- 原始错误：`EACCES: permission denied, open '/opt/aedresponse/current/backend/deploy/azure/create-simulated-event.mjs'`。
- 运行身份：`aedresponse`；脚本实际权限：`root:root 0600`。
- 路径上级目录均可遍历，直接阻塞点是脚本只允许root读写。
- 原因：上一轮由助手部署脚本时，使用root和umask077复制了新文件，未核对实际服务账号的可读性。候选编译和回归通过不能覆盖这个部署权限检查缺口。这是测试工具部署错误，不归因于用户设备权限。
- 失败发生在Node加载脚本阶段，`createSimulatedEvent`没有执行，因此不能判为接受/任务分配算法失败。
- 按“发现bug只记录、不修复”，本轮没有chmod/chown、提权运行脚本或换路径绕过，没有再次触发。

## 恢复与结果

北京时间20:50:13对应健康检查：服务active、`/healthz`返回ok，SQLite integrity_check=ok。
数据库：events=0、deliveries=0、assignments=0。没有模拟事件或任务残留；没有删除任何业务数据。
此次短暂停服后17日志显示重新bootstrap和Socket ready；没有把它算作任务分配验收。

## 下一步

需要用户单独允许修正SIM-01测试工具权限后才能重试。即使允许，也仅修测试工具读取权限，其他已登记业务问题保持未修复。
重试前必须确认零活动事件、两机就绪并生成新的runId/新requestedAt（旧清单的30秒有效期已过）；保留本次清单、备份与记录，不覆盖失败尝试。
