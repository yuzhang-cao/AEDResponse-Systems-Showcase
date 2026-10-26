# G13-A 完成验收证据

- `verification.json`：最终断言摘要；44 个后端源文件与测试版本匹配。
- `source-manifest.json`：当前工作树源码 SHA-256。项目仍有既有未提交修改，不能只用 Git HEAD 表示被测版本。
- `test-final.log`：完整后端 498/498（含 7 个新事务/索引用例和 3 个 HTTP 范围用例）。
- `check-final.log`、`build-final.log`、`smoke-final.log`：类型/构建与契约 5/5、后端 smoke 18/18。
- `http-distance-results.json`、`http-distance-final.log`：Memory/SQLite，各 0/250/1,000 名远方用户，19 种 HTTP 操作；每档输出与计数在用例内逐项断言一致。原生调度器开启，GET 路由执行真实 tick，outbox 实际落盘/重试；另有隐藏实体事务能力的负向对照。
- `instrumentation.patch`：只向隔离副本的距离函数、网格方法和 HTTP 测试增加计数。业务源码未加入测试专用全局变量。
- `probe.mjs`、`instrumented-results.json`、`unmodified-results.json`、`baseline-results.json`：同一合成 service 场景的插桩当前版、未插桩当前版、本轮开始时源码版本；各 42 条观测 + 10 项跨格/相邻格/重开检查，业务输出逐项相同。运行第三个参数使用 `current`/`control`，旧 `instrumented` 分支保存的是首次审查预期，不用于整改后断言。

复现：当前项目 `backend` 目录运行 `npm test`（新文件已加入默认测试）或 `node --import tsx --test test/incremental-state.test.ts test/g13-operation-scope.test.ts`。距离插桩须在独立副本复制 `backend/src`、`backend/test`、`backend/package.json`、`backend/tsconfig.json` 和 `contracts`，链接本地 `backend/node_modules` 后于副本根目录执行 `patch -p1 < instrumentation.patch`，再从副本 backend 运行 HTTP 测试。不得将插桩应用到业务工作树。

所有数据为合成数据，SQLite/HTTP 在本机临时目录与随机回环端口运行。它们不代表生产压测、真实 Apple/Watch/APNs、签名包或发行验收。冷启动/显式导入仍可重建索引；已到期位置与通知属于应处理工作集。原容量目标未恢复。
