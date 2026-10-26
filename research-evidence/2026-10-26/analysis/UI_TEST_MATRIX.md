# UI 测试去重矩阵

按历史 xcresult 的 `Test Case.nodeIdentifier` 去重，可以支持 **10 个不同离线 UI 场景均存在最终通过证据**：普通场景 9 项，加深色/最大辅助字号场景 1 项。证据由普通批次与针对失败项的后续复测共同组成，**不是同一轮 10 项完整复跑全绿**。本次只整理已有结果，没有执行测试。

下表“—”表示该轮没有该测试；通过、失败均来自 tests.json。完整 `nodeIdentifier`、逐轮结果和来源见 [机器可读矩阵](UI_TEST_MATRIX.json)。

| 场景 | 首次 UI | 普通 9 项 | 初次大字 | 中间复测 | 普通最终复测 | 大字最终复测 |
|---|---|---|---|---|---|---|
| 取 AED 至患者交接 | — | 通过 | — | — | — | — |
| 深色大字主操作可达 | — | — | 失败 | — | — | 通过 |
| 显示邀请及离线接受 | 失败 | 通过 | — | 通过 | 通过 | — |
| 患者误报确认 | — | 通过 | — | — | — | — |
| 患者结束确认 | — | 通过 | — | — | — | — |
| 隐藏范围圈但保留人数 | — | 失败 | — | 失败 | 通过 | — |
| 设置往返保留任务进度 | — | 通过 | — | — | — | — |
| 权限展示及隐藏开发信息 | — | 通过 | — | — | — | — |
| 退出取消及三次确认 | — | 通过 | — | — | — | — |
| 待命地图及聚合人数 | 失败 | 失败 | — | 失败 | 通过 | — |

## 判定与边界

- 普通批次 `ui-normal` 为 7 通过、2 失败；`ui-final-normal` 对 3 项复测全部通过，其中包括前述 2 个失败项和 1 个已通过项。去重后覆盖普通场景 9 项。
- `ui-final-accessibility` 的独立大字场景 1 项通过，与普通 9 项不重叠；初次失败保留在矩阵中。
- `ui-normal-final` 名称虽含 final，实际为 1 通过、2 失败，不能把它当作最终成功证据。
- 这 6 个 UI 批次各自的 `skippedTests`、`expectedFailures` 均为 0。两字段独立记录，未计入通过数；各轮总数不能累加为独立场景数。
- `unit-final` 的 Test Case 节点为 **162 个不同 nodeIdentifier，全部 Passed**，与汇总的 162/162 一致；`skippedTests=0`、`expectedFailures=0`。与初轮 `UnitTests` 的用例集合完全相同，初轮为 161 通过、1 失败。
- 这些是原生离线 TestHost 结果，不代表物理设备接单、真实地图、后台救助或 Watch 全链路通过。

## 原始导出来源

- `UITestsFirst`：[测试节点](../xcresult/UITestsFirst/tests.json) · [汇总](../xcresult/UITestsFirst/summary.json)
- `ui-normal`：[测试节点](../xcresult/ui-normal/tests.json) · [汇总](../xcresult/ui-normal/summary.json)
- `ui-accessibility`：[测试节点](../xcresult/ui-accessibility/tests.json) · [汇总](../xcresult/ui-accessibility/summary.json)
- `ui-normal-final`：[测试节点](../xcresult/ui-normal-final/tests.json) · [汇总](../xcresult/ui-normal-final/summary.json)
- `ui-final-normal`：[测试节点](../xcresult/ui-final-normal/tests.json) · [汇总](../xcresult/ui-final-normal/summary.json)
- `ui-final-accessibility`：[测试节点](../xcresult/ui-final-accessibility/tests.json) · [汇总](../xcresult/ui-final-accessibility/summary.json)
- `UnitTests`：[测试节点](../xcresult/UnitTests/tests.json) · [汇总](../xcresult/UnitTests/summary.json)
- `unit-final`：[测试节点](../xcresult/unit-final/tests.json) · [汇总](../xcresult/unit-final/summary.json)
