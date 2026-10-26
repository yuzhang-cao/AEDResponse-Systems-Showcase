# AEDResponse 研究资料与测试证据

这份资料用于判断 AEDResponse 能否成为日本修士申请的研究计划（Research Proposal，本文简称 PR）的基础。它汇集现存开发记录、测试结果、性能数据、测试源码和界面证据，便于追溯结论及寻找尚未解决的研究问题。这里的 PR 不指 GitHub Pull Request。

本次整理没有重新运行历史测试，也没有完成文献新颖性审查。资料能够说明项目做过哪些工程实现和验证；是否存在足够重要、可证伪且区别于已有方法的研究问题，仍需独立判断。允许结论是“目前不能直接写成 PR”。

[下载整个脱敏资料包](https://github.com/yuzhang-cao/AEDResponse-Systems-Showcase/archive/refs/heads/main.zip) · [给 GPT 的深度研究提示词](DEEP_RESEARCH_PROMPT.md)

## 建议阅读顺序

1. 阅读本页和 [公开资料处理说明](PUBLICATION_NOTES.md)，了解数据范围、脱敏及未收录内容。
2. 阅读 [项目 README](project/README.md)、[架构与状态机](project/docs/architecture.md)、[iOS/watchOS 架构](project/ios/ARCHITECTURE.md)，再结合 [交接记录](project/HANDOFF.md) 和 [最新 UI 实施记录](project/docs/design/action-map-first-2026-10-13/README.md) 核对当前状态。
3. 阅读下表中的实验与验证材料。需要查完整目录时使用 [INVENTORY.csv](INVENTORY.csv)，核对来源与哈希时使用 [MANIFEST.json](MANIFEST.json)，检查缺失或未发布项目时使用 [OMISSIONS.csv](OMISSIONS.csv)。
4. 将 [深度研究提示词](DEEP_RESEARCH_PROMPT.md) 与本目录链接交给研究工具。先核实证据，再检索文献，不预设项目已有研究创新。

## 证据分层

| 层次 | 主要材料 | 能支持什么 | 不能由此推出什么 |
| --- | --- | --- | --- |
| 设计与实现说明 | [项目文档](project/docs/)、[交接记录](project/HANDOFF.md) | 当时的设计、约束、问题诊断与处理过程 | 所有设计已落地，或所有旧问题目前仍存在 |
| 测试源码 | [后端测试快照](reference-tests/backend/test/)、[iOS 单测快照](reference-tests/ios/AEDResponseTests/)、[iOS UI 测试快照](reference-tests/ios/AEDResponseUITests/)、[Watch 测试快照](reference-tests/ios/AEDResponseWatchTests/) | 断言、输入、边界条件和可继续实验的代码基础 | 每个测试在每个历史版本均已执行；源码本身就是运行结果 |
| 构建、单测与离线 UI 执行 | [iOS 验证记录](project/ios/VALIDATION.md)、[最新验证汇总](project/docs/design/action-map-first-2026-10-13/implementation-verification.json)、[xcresult 导出](xcresult/) | 指定版本和环境中的构建、断言与界面流程结果 | 真机后台、真实网络、真实救助或临床效果已经通过 |
| 合成性能对照 | [SQLite 原始性能数据及日志](cache/performance-fix-20261004/)、[优化汇总](project/docs/evidence/server-performance-2026-10-04/verification.json) | 相同合成场景中代码路径、耗时和工作量的对照 | 当前线上容量、长期稳定性或固定通用提速比例 |
| 历史容量基线 | [2026-09-11 压测报告](project/docs/load-test-2026-09-11.md)、[压测与探针脚本](loadtest/) | 旧架构的瓶颈、负载方法和优化前参照 | 重构后当前版本的容量或服务等级保证 |
| 手机局部实测 | [路线测速](project/docs/evidence/route-speed-2026-10-13/README.md)、[独立路线验收](project/docs/evidence/mapkit-route-phone-2026-10-13/README.md) | 指定手机、网络、合成场景中的局部路线与导航行为 | 完整正式 App 业务、所有地图回退分支或真实 AED 可用性 |
| 真实待命通信 | [服务器实机集成报告](project/SERVER_INTEGRATION_TEST_REPORT.md) | 当时前台蜂窝网络下待命位置上传与回执的观测 | 患者事件位置、完整双机救助、后台持续运行或 AED 领取送达闭环 |
| 界面证据 | [最新离线运行截图](project/docs/design/action-map-first-2026-10-13/screenshots-2026-10-26/) | 已运行原生测试界面的布局和状态展示 | 示意地图、示例人数及测试 Tab 就是正式在线运行状态 |

公开材料经过处理，不能一概称为未经改动的原始文件。哪些文件直接保留、哪些经过脱敏或从结果包导出，以处理说明、清单和缺失记录为准。

## 历史结果与当前源码要分开读

不同报告来自不同日期、源码版本、测试选集、设备和网络环境。测试数量会随实现和验证范围变化，不能把各轮数字累加为当前通过数，也不能把一次失败永久解释为现版本仍失败。

旧文件名日期、报告内部日期、缓存路径和测试开始/结束时间不总是一致。应结合文件内容、源码哈希和运行标识核对关联，不按文件名强行认定先后，也不只凭时间戳认定某结果覆盖另一结果。

- 本仓库根目录的 [Systems Showcase](https://github.com/yuzhang-cao/AEDResponse-Systems-Showcase) 是选取的可运行核心代码，运行条件和命令以根目录说明为准。
- `reference-tests/` 保存本次收集到的正式项目测试源码供阅读和比较。它不是完整工程，不具备全部依赖与构建上下文，不能独立运行，也不能自动视为每份历史报告对应的源码。
- `historical-test-snapshots/` 用于收录现存构建缓存中的历史测试快照，包括性能实验 baseline/candidate 与 UI 构建 Source 中的测试。每份快照按其缓存来源和阶段单独保留；它们不冒充当前工作树，也不能仅凭缓存目录名保证与某次运行逐字一致，仍需核对哈希和运行记录。
- `loadtest/` 保存负载生成与探针方法；执行仍需要相应版本的后端、隔离数据和环境。某些脚本会写入测试数据，不能把收录脚本理解为已重新执行。
- 历史源码清单、补丁和哈希可帮助核对版本，但不能替代缺失的完整源码快照、依赖环境或运行日志。

正式项目的部分源文件受 iCloud `dataless` 状态影响，可能在本次收集时读取超时。清单应保留这一事实，不用历史缓存静默替代当前源码；具体遗漏及替代资料的独立来源见 [OMISSIONS.csv](OMISSIONS.csv)。

部分文档同时保留旧说明和新决定。当前本地参考后端使用 Node.js/TypeScript 与 SQLite；文档中的 PostgreSQL/PostGIS、缓存和持久队列架构不都是已部署事实。路线方案后来改为手机 MapKit 计算两段步行距离、服务端确认分配，导航优先高德并回退 Apple 地图；旧 ETA 方案不能直接用于解释新版结果。当前还存在“上报发现的患者”入口，较早的触发说明可能没有覆盖它。

## 最新 UI 结果中的失败与复测

8 个现存 `.xcresult` 已可读取摘要。这里同时保留初次失败和后续复测，不只展示成功结果：

| 结果包 | 通过 / 总数 | 摘要与测试树 |
| --- | --- | --- |
| `UnitTests` | 161 / 162 | [summary](xcresult/UnitTests/summary.json) · [tests](xcresult/UnitTests/tests.json) |
| `unit-final` | 162 / 162 | [summary](xcresult/unit-final/summary.json) · [tests](xcresult/unit-final/tests.json) |
| `UITestsFirst` | 0 / 2 | [summary](xcresult/UITestsFirst/summary.json) · [tests](xcresult/UITestsFirst/tests.json) |
| `ui-normal` | 7 / 9 | [summary](xcresult/ui-normal/summary.json) · [tests](xcresult/ui-normal/tests.json) |
| `ui-normal-final` | 1 / 3 | [summary](xcresult/ui-normal-final/summary.json) · [tests](xcresult/ui-normal-final/tests.json) |
| `ui-final-normal` | 3 / 3 | [summary](xcresult/ui-final-normal/summary.json) · [tests](xcresult/ui-final-normal/tests.json) |
| `ui-accessibility` | 0 / 1 | [summary](xcresult/ui-accessibility/summary.json) · [tests](xcresult/ui-accessibility/tests.json) |
| `ui-final-accessibility` | 1 / 1 | [summary](xcresult/ui-final-accessibility/summary.json) · [tests](xcresult/ui-final-accessibility/tests.json) |

最终“162 项业务单测、10 个离线 UI 场景通过”的含义是：业务单测完整复跑；普通 UI 的 9 个不同场景经分批运行和失败项修复复测后通过，再加 1 个深色及最大辅助字号场景。已按测试标识逐项核对，见 [去重结果矩阵](analysis/UI_TEST_MATRIX.md)。不能把表格所有通过数相加。`final` 文件名本身也不是通过证明，例如 `ui-normal-final` 仍有失败。

2.0/build14 的安装与独立版本回读有记录，但该轮未主动启动正式手机 App，也未验收真实接单、后台、地图导航或手表设备更新。完整 `.xcresult` 与本文的轻量导出不是相同交付物；附件和未发布内容见处理说明。

## 可以继续分析的实验基础

- **SQLite 性能：**缓存中的 baseline、candidate 与 candidate-final 数据分别保留 2 个场景、每场景 2 轮，包含耗时、调度延迟、消息数量和内部操作计数。这适合分析开销来源与改动效果；样本规模不足以建立稳定的总体性能结论。
- **MapKit 调度：**手机实测有 1 / 3 个模拟 AED 候选，以及同场景“原版→优化→优化→原版”的四轮对照。每版只有 2 轮且可能受系统缓存影响；原版末轮也接近优化版，不能把均值差写成固定提升。
- **位置与分布式状态：**测试覆盖空间候选筛选、位置窗口与缺测记录、事务一致性、幂等、会话代次隔离和手表持久重试。这些是待审查的工程与实验基础，是否构成独立方法贡献需与现有研究比较。
- **交互：**离线 UI 证据可以帮助确认功能和设计边界，但不包含用户研究、理解程度、认知负担或真实任务成效的实验。

已明确的实现缺口包括朗读位置卡尚未接入页面。8 候选、弱网/蜂窝、冷缓存、业务 GET/PUT 端到端性能、附近真实 AED 和完整双机/后台业务仍有验证缺口。缺少验收不等于已经观察到运行失败。

## 已知缺失的原始临时资料

以下历史路径在本次本机盘点时已不存在；相关报告或项目内证据可能仍在，但不能称作原始临时日志已完整保存：

- `/tmp/aed-mapkit-full-tests-final.log`
- `/tmp/aed-mapkit-ios-tests-final.log`
- `/tmp/aed-mapkit-ios-tests.log`
- `/tmp/aed-mapkit-live-probe.log`
- `/tmp/aed-routing-speed-20261013/`
- `/tmp/aedresponse-registered-20260920/`
- `/tmp/aedresponse-profile-refresh-20260920.log`

这不是对所有旧路径的完整清查。完整收录状态以 [OMISSIONS.csv](OMISSIONS.csv) 为准；“源文件已经缺失”“因隐私未发布”“只导出摘要”应分别记录。报告中的本机绝对路径、服务器路径和相对链接不保证在公开包内可访问。

这些资料支持对工程完成度与研究可行性做有依据的审查，不支持直接声称方法新颖、公共急救部署就绪或临床有效。
