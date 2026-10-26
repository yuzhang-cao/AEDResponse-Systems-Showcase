# iPhone 路线与地图验收 · 2026-10-13

本轮完成独立验收 App 的手机 MapKit 算路、经 USB 桥提交到实际隔离后端并确认分配，以及用户确认高德和 Apple 地图能打开。没有验收正式环境全流程。

## 实际结果

| 项目 | 结果与证据 |
| --- | --- |
| 设备与安装 | iPhone 17 Pro / iOS 27.2；独立 `dev.codex.aedresponse.routeacceptance` 1.0 (2)，显示名“路线验收”；generic iOS 签名构建、严格验签和普通 USB 安装成功。 |
| 手机算路 | 复用当前生产 `MapKitAedRouteCalculator`，固定上海合成 R/A/P、1 个 AED 候选；两次上报均为 **260 + 443 = 703 米**。没有使用预填的距离或地图 Web API Key。 |
| 后端确认 | 实际 `createBackend + MemoryStateStore + CLIENT_MAPKIT`；核对 PUT 200、AED ID、两段和、`FETCH_AED`、`CLIENT_MAPKIT` 及 `R→A→P` 一致。见 `result.json`、`events.jsonl`、`verification.json`。 |
| 用户界面 | 用户确认“已经通过”，并确认“打开都正确”；后一句对应高德和 Apple 地图的打开验收。 |
| 高德检测 | 手机报告 `canOpenURL(iosamap)` 为 true，设备已有高德与 Apple 地图。 |
| 地图回调边界 | 日志有一次患者目标的高德打开失败、其自动 Apple 回退失败，以及一次 AED 目标的强制 Apple 打开成功。用户确认两款地图实际可见；不能把该确认扩写成每次回调均成功，或自动失败回退已通过。 |

这三个点在上海。算路的“响应者”是合成 R，不是手机实际定位；外部地图链接省略起点后采用手机真实位置，因此用户看到目的地很远。正式代码的输入来自服务端绑定的响应者/患者位置与候选 AED，没有固定使用这组上海坐标。

## 传输与耗时

首次局域网版本报 `NSURLErrorDomain / -1004`。用户确认同一 Wi-Fi、本地网络权限已允许；Mac 地址正确、后端监听正常、Mac 自身访问返回 401、实际 Node 二进制已获防火墙允许，但后端没有收到手机请求。具体网络阻断原因未查明，不写成已确认的校园网隔离或 VPN 问题。

改用普通 USB HouseArrest/AFC 文件交换，Mac 只转发当前合成事件的 GET/PUT 路线和 POST 观测接口。MapKit 仍在 iPhone 上通过其网络计算，服务端仍执行实际校验。该结果不证明 iPhone URLSession 直连 Mac 已恢复。

首轮服务端观测时间：启动 11:56:57.445、GET 11:57:01.891、MapKit 完成观测 11:57:06.259、PUT 11:57:11.047。首尾 **13.602 秒**包括四轮串行 USB 请求及诊断回报；GET 到完成观测的 **4.368 秒**也包含传输，不能视为纯 MapKit 耗时。正式客户端直接 GET→MapKit→PUT，没有首次固定等待，但最多 8 个候选依次计算、每个候选两段并发；多候选实机耗时尚未测量。

## 修改与核验

- 本任务只新增此证据目录和 HANDOFF 记录；临时验收源码位于 `/tmp/aed-route-acceptance-20261013`。生产业务源码未在本轮修改。
- `production-source-manifest.json` 记录本轮复用的真实路线代码和 DTO 来源哈希，构建后再次核对一致；`probe-source-manifest.json` 记录临时程序哈希。
- 构建命令：`xcodebuild -project /tmp/aed-route-acceptance-20261013/app/AEDRouteAcceptance.xcodeproj -scheme AEDRouteAcceptance -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/aed-route-acceptance-20261013/DerivedData -allowProvisioningUpdates build`；日志 `build-usb.log` 位于上述临时目录，结果 `BUILD SUCCEEDED`。
- `codesign --verify --deep --strict` 在可访问系统信任钥匙串的环境成功；沙箱内曾出现 `CSSMERR_TP_NOT_TRUSTED`，未将它误判为最终签名失败。
- `ideviceinstaller ... install` 返回 `InstallComplete (100%)`、`Complete`、exit 0；安装后独立回读 build 2。正式 App 当前 build 12 属于另一路 UI 安装工作，见相邻 `ui-phone-install-2026-10-13` 记录；本任务没有安装正式包或原 testhost。
- 没有使用 DDI、Simulator、手机镜像；没有操作生产数据库、真实救助、跌倒/SOS、APNs 或远程部署。

## 剩余边界与清理

未覆盖：当前位置附近真实 AED 的实地匹配、多候选最短选择及耗时、正式手机网络端到端、真实未安装高德、自动失败回退成功、真实 `AED_ACQUIRED` 阶段推进。验收页的阶段 Picker 只切换目的地，不执行领取业务。

12:01:16 已停止临时后端和 USB 桥，后端凭据失效，私有 token 配置已删除。手机留下的独立 build 2 不含 token；临时服务关闭后不能继续点击重测。既有生产 App 与测试 App 保留，没有提交、推送或部署。
