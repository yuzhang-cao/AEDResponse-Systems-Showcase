# 容量压测工具（2026-09-11）

这些脚本用于对 Azure 联调后端（`aedresponse-server`，Japan East）做容量压测。
结果与结论见 [`docs/load-test-2026-09-11.md`](../../../docs/load-test-2026-09-11.md)。

## 使用前提

- 负载生成器运行在**服务器本机**（`127.0.0.1:8787`）。从外部经公网压测会被链路限制在
  约 570 RPS，测不到服务器上限。
- 代码路径假设部署在 `/opt/aedresponse/current/backend`，Node 在 `/opt/node/bin/node`。
- **写事务是全库串行的**：任何会写库的脚本都必须在 `aedresponse.service` 停止后运行，
  不得与服务进程并发写同一个 SQLite。

## 脚本

| 脚本 | 作用 | 是否需要停机 |
| --- | --- | --- |
| `probe-txcost.mjs` | 在**数据库副本**上测 no-op 事务成本（clone+validate+持久化）；只读，不动线上库 | 否 |
| `probe-breakdown.mjs` | 拆分一次写的成本：clone / 校验+历史+深比较 / flatten+提交 | 否（用副本） |
| `probe-scale.mjs` | 在**隔离库**上按用户数生成合成状态，测存储层成本曲线 | 否（独立库） |
| `seed-fleet.mjs` | 用真实服务 API（`provisionControlledTestAccount` + `bootstrap`）签发 N 个受控账号与 iPhone 会话，输出令牌清单 | **是** |
| `inject-users.mjs` | 在**一个事务**内把合成待命用户直接注入目标库，用于测"数据量增长后容量如何下降" | **是** |
| `loadgen.mjs` | 负载生成器：`probe` 逐端点测定、`sat <端点> <并发> <秒>` 并发饱和、`sockets <N> <秒>` 连接保持 | 否 |
| `socket-scale.mjs` | 阶梯式开 N 条 Socket.IO 连接，测建连速率/延迟/内存 | 否 |
| `sweep.sh` | 一次跑完全部并发档位的编排脚本 | 否 |
| `dump-shapes.mjs` | 从库副本导出记录形状（用于构造合成数据） | 否 |

`sweep-20260911.log` 是 2026-09-11 那轮完整饱和扫描的原始输出。

## 典型流程

```sh
# 0) 备份（务必先做）
sudo sh -c 'cd /var/lib/aedresponse && cp -a state.sqlite backups/state.pretest-$(date -u +%Y%m%dT%H%M%SZ).sqlite'

# 1) 签发合成机队（需停机；令牌写入 /tmp/aed-loadtest/fleet.json）
sudo systemctl stop aedresponse
sudo systemd-run --unit=aed-seed --uid=aedresponse --gid=aedresponse --collect --wait \
  --property=WorkingDirectory=/opt/aedresponse/current/backend \
  --property=EnvironmentFile=/etc/aedresponse/backend.env \
  --property=Environment=AED_ENABLE_CONTROLLED_TEST_ACCOUNTS=true \
  /opt/node/bin/node /tmp/aed-loadtest/seed-fleet.mjs 50 /tmp/aed-loadtest/fleet.json
sudo chmod 644 /tmp/aed-loadtest/fleet.json
sudo systemctl start aedresponse

# 2) 逐端点测定 + 并发饱和
PID=$(systemctl show aedresponse -p MainPID --value)
/opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs probe --pid=$PID --fleet=/tmp/aed-loadtest/fleet.json
/opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat events 16 20 --pid=$PID --fleet=/tmp/aed-loadtest/fleet.json

# 3) 测完务必还原数据库（合成用户会永久拖慢线上服务）
sudo systemctl stop aedresponse
sudo sh -c 'cd /var/lib/aedresponse && rm -f state.sqlite-wal state.sqlite-shm \
  && cp -a backups/state.pretest-<时间戳>.sqlite state.sqlite && chown aedresponse:aedresponse state.sqlite'
sudo systemctl start aedresponse
```

## 注意

- `fleet.json` 含真实可用令牌，测后应 `shred`。
- 受控测试账号开关（`AED_ENABLE_CONTROLLED_TEST_ACCOUNTS`）只允许在开发 VM 上启用。
- 压测会把线上服务压到不可用（实测 p95 可达数十秒），**不要让真实用户在此期间使用**。
