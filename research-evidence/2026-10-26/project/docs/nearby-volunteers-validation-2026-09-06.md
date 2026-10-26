# 附近待命人数：实现与验证

## 已确认需求

中立待命用户可查看附近待命、可以接受救助请求的其他用户。列表与地图同时提供，默认列表，显示“多少范围内多少人”；不披露个人身份、精确位置或轨迹。此处不是查看正在救助中的响应者。

范围暂沿用 1/1.5/2 公里。三个值为累计人数，不相加；同一稳定用户拥有多个设备时也只计一人。地图只显示以自身位置为中心的范围圈与人数图例，没有他人的点位。

## 实现边界

- 后端以认证查看者已存的有效最新 R 为查询中心，不接受任意经纬度查询参数。只读聚合，不修改 presence、位置或事件，不产生通知/任务。
- 同意、权限、可参与状态、位置时效/精度及活动事件状态共同决定资格；排除本人全部设备、患者和正在参与救助的用户。
- 响应只包含 `generatedAt`、`ranges[].radiusMeters`、`ranges[].count`。无用户/设备 ID、电话号码、坐标、轨迹或个人距离。
- iOS 数据模型验证固定三层半径及非负、非递减计数。进入待命页或下拉时请求；角色/会话变化与旧异步结果隔离，展示缓存超过 120 秒失效。未成功取得统计和合法 0 人结果区别处理。
- TestHost 强制离线，显示标记为示例的 3/5/8 人；离线地图使用范围示意，不构造在线 MapKit 请求。生产代码提供实际 MapKit 范围圈层，但这不是本批在线地图验收证据。

## 本批验证

- 新增 `NearbyVolunteerSummaryTests`：macOS 原生 XCTest 7/7 通过。临时无依赖 SwiftPM 包链接仓库中的模型和同一测试文件，契约日期编码器从当前 `Models.swift` 提取；不是模拟器或 iPhone 测试。日志：`/tmp/aed-nearby-native-model-20260906.log`。
- `AEDResponseTestHost` generic iOS `build-for-testing` 通过，新增的默认列表/地图切换/患者与响应者隐藏 UI 用例、只读 API transport stub 用例均已编译；尚未在设备运行。最终日志：`/tmp/aedresponse-nearby-build-final-20260906.log`。
- `AEDResponse` Production Release generic iOS 构建通过。日志：`/tmp/aedresponse-nearby-release-20260906.log`。
- 后端纯业务 `npm run test:business` 72/72 通过，包含 4 个新增统计用例；`npm run check` 通过。覆盖累计去重、本人多设备、字段白名单、未知/合法零人、权限与可用状态、过期位置、活动患者/响应者、未接受 offer 仍为中立、接近范围边界且计算值不超过阈值的浮点坐标。日志：`/tmp/aedresponse-nearby-business-20260906.log`、`/tmp/aedresponse-nearby-check-20260906.log`。
- OpenAPI YAML 可解析，32 个 operationId 唯一，187 个内部引用可解析。HTTP 路由本身只通过类型/静态检查，未运行服务器接收测试。
- `git diff --check` 通过；无 commit/push。没有启动真实服务器、HTTP/Socket 测试、Windows 服务或物理 Watch 测试。

## 本次实机执行

用户最新明确“有线无线无所谓，直接开始”，撤销本次测试的无数据线限制。2026-09-06 11:45 核实物理 iPhone 17 Pro 已连接、解锁；实际 `transportType=wired`，iOS 27.0 / 24A5430a。

本批已重新签名、安装并运行当前源码的 TestHost Tests/UITests。物理 Tests 为 196 项中 185 通过、11 项仓库源码检查按设计跳过、0 失败。首轮 UI 旧 11 项通过，新场景的 SegmentedControl 类型限定查询失败；列表的范围/人数断言和实机截图已通过，地图尚未到达。日志 `/tmp/aedresponse-nearby-physical-20260906-1146.log`，结果 `/tmp/aedresponse-nearby-physical-20260906-1146.xcresult`。

只修订 UI 测试，改用稳定标识跨元素类型定位 Picker，增加地图人数图例断言及 accessibility hierarchy 附件；没有修改产品逻辑。定点复跑 `/tmp/aedresponse-nearby-physical-20260906-1153.log` / `.xcresult` 在 11:53 编译后因手机锁屏等待用户解锁，尚不能记为通过。

没有使用 Simulator。上述实机结果不代表无线/蓝牙传输、真实服务器接收、真实登录、在线地图、公网数据传输或物理 Watch 验收；这些既有冻结范围不因此自动恢复。

## 主要文件

- `ios/AEDResponse/Domain/NearbyVolunteerSummary.swift`：不含个人位置/身份的汇总模型。
- `ios/AEDResponse/Views/NearbyVolunteersView.swift`：默认列表与地图范围展示。
- `ios/AEDResponse/Views/ResponderDashboardView.swift`、`App/AppStore.swift`：待命页接线和异步状态隔离。
- `ios/AEDResponse/Application/Ports.swift`、`Networking/APIClient.swift`：只读聚合接口。
- `backend/src/service.ts`、`models.ts`、`server.ts`、相关业务测试、`contracts/openapi.yaml`：资格过滤与服务端匿名聚合契约。
- `docs/requirements.md`、`ios/README.md`、`HANDOFF.md`：需求与交接边界。
