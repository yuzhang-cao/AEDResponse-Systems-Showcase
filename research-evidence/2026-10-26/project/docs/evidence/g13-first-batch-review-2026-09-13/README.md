# G13-A 第一批复核证据

完整结论见 `../../G13-A第一批整改复核-2026-09-13.md`。

- `source-manifest.json`：被测当前工作树 42 个后端源文件 SHA-256。并非单独以 Git HEAD 表示未提交源码。
- `probe.mjs`：合成患者、Watch、3 个附近响应者及 0/250/1,000 个远方设备；Memory/临时 SQLite，各测 7 类操作。运行时第三个参数使用 `current` 或 `control`；原始 `instrumented` 分支保留整改前预期，不能用于本轮创建路径。
- `instrumentation.patch`：只在隔离副本增加计数，不修改业务条件。包含距离、网格重建、候选全 key 构造、患者同账号检查和事务底层 key/谓词检查。
- `current-results.json`：当前代码插桩输出，42 条操作记录 + 10 项正确性检查。
- `unmodified-results.json`：当前源码未插桩的同场景对照；插桩计数为 0，业务输出与当前插桩逐项相同。
- `control-prior-tx.patch`：当前源码到旧事务适配器的差异，仅用于隔离负向对照；不应用到业务工作树。
- `control-prior-tx-results.json`：旧适配器对照输出，其余当前逻辑不变；共享函数/实体事务底层仍插桩，位置事务设备 key 和 committed 谓词检查均为 0，业务输出一致。
- `verification.json`：源文件未变化、业务输出对照及关键计数断言结果。
- `check.log` / `build.log` / `tests.log` / `smoke.log` / `ios-smoke.log`：本轮完整检查摘要或日志。
- `ios-account-architecture.log`：不包含于默认 128 项的账户入口源码结构断言，另行运行 1/1 通过。
- `caddy-validate.log` / `caddy-loopback-results.json`：实际 Caddy 解析及本地伪造头检查；不代表生产链路/完整反代限流验收。

复现方法：在新的临时目录复制项目 `backend/src`、`backend/package.json`、`backend/tsconfig.json`、`contracts`，令副本的 `backend/node_modules` 链接已有本地依赖。在副本根目录以 `patch -p1` 应用 `instrumentation.patch`；从原项目 backend 工作目录运行 `node --import tsx /绝对路径/probe.mjs /副本根目录 /输出文件 current`。未插桩对照将副本根目录替换为原项目路径，使用 `control` 模式。旧适配器对照从另一份原源码副本应用 `control-prior-tx.patch`，再应用 `instrumentation.patch` 中除 `tx-recruitment-context.ts` 以外的四个文件差异，运行相同场景。所有数据为合成数据，SQLite 使用临时路径并在退出时清理。

计数包括真实 service 入口内部的 tick/outbox。没有隔离 HTTP 路由全覆盖、并发/供应商/真机测试，不能用这些结果替代整项验收或生产耗时测试。源码继续变动后，应重新生成源哈希和结果，不将本目录当作新版本证据。
