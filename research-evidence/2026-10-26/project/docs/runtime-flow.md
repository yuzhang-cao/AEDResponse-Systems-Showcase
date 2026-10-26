# AEDResponse v2 实际运行流程与技术架构

状态：2026-09-05 已确认。本文只描述最终目标架构；当前实现进度与外部门槛见 `HANDOFF.md`。

## 1. 生产部署与信任边界

```mermaid
flowchart LR
    W[Apple Watch\nwatchOS + SwiftUI\nCore Motion Fall Detection\nCallKit observation\nCore Location]
    I[iPhone\niOS + SwiftUI\nAuthenticationServices\nCore Location + MapKit\nKeychain + APNs]
    EDGE[中国大陆公网入口\nWAF + HTTPS TLS 1.2+\nWSS WebSocket Upgrade\n16 KiB JSON 边界]
    API[Node.js / TypeScript 集群\nREST 单写真相\nSocket.IO 仅通知\n账号与事件状态机]
    DB[(PostgreSQL + PostGIS\n用户/事件/轨迹/审计\n中国大陆生产)]
    CACHE[(Redis-compatible\n短期 presence/幂等/房间)]
    Q[持久队列\nAPNs/超时/留存任务]
    OBJ[(私有对象存储\nAED 照片 <= 5 MiB)]
    MAP[高德 Web Service\n路径规划 2.0\n步行 ETA + 坐标转换]
    APNS[Apple APNs\nopaque IDs only]
    AZ[Global Azure 测试\nContainer Apps / App Insights\n合成数据与 P20 压测]
    GH[GitHub Actions\ncheck + test + build\n部署门禁]

    W -->|公网 HTTPS REST\n触发 / reachability / fallback P| EDGE
    I -->|蜂窝或任意 WAN\nHTTPS REST + WSS Socket.IO| EDGE
    W <-->|Bluetooth/WCSession\n可达性 + 一次性绑定 ticket\n不传业务位置/触发| I
    EDGE -->|受限内网回源\n认证后请求| API
    API -->|SQL transaction + PostGIS| DB
    API <-->|TTL / pub-sub / hot state| CACHE
    API -->|durable jobs| Q
    API -->|signed photoRef| OBJ
    API -->|HTTPS walking ETA\nWGS-84 derived conversion| MAP
    Q -->|token-based provider auth| APNS
    APNS -->|Time Sensitive / generic payload| I
    GH -->|CI/CD; no production secrets in repo| API
    GH -->|synthetic deployment only| AZ
```

生产真实数据只进入中国大陆部署。Windows 是本地开发、真机联调和压测控制端；Tailscale 只用于管理员 SSH，不在上图业务链路中。

## 2. App 启动、登录、协议和权限

```mermaid
flowchart TD
    A[启动 iPhone App] --> B{Keychain 中有\n可恢复登录会话?}
    B -- 否 --> C[登录页\n手机号验证码 或 Sign in with Apple]
    C --> D[HTTPS POST auth\n后端验证 SMS challenge\n或 Apple identity token]
    D -->|失败| C
    D -->|成功: userId + scoped session| E{协议与隐私版本\n全部有效?}
    B -- 是; refresh 成功 --> E
    E -- 否 --> F[患者协议 + 志愿协议\n隐私政策 + 敏感信息单独同意]
    F -->|拒绝/关闭| Z[停留门禁\n零业务初始化]
    F -->|全部同意| G{Always + 精确定位\n通知权限均可用?}
    E -- 是 --> G
    G -- 否 --> H[权限说明与系统设置入口\n不提供待命/救助服务]
    G -- 是 --> I[激活 WCSession\n签发一次性 Watch 绑定 ticket]
    I --> J[REST bootstrap / 恢复事件真相]
    J --> K[连接 WSS Socket.IO\n进入 NEUTRAL 待命]
```

未通过任一门禁时，不得定位、不连接业务后端、不启动 Watch 业务监控。生产 App 没有游客、密码、邮箱或其他登录。

## 3. Fall 检测与事件成立

```mermaid
flowchart TD
    A[Apple Watch\nCMFallDetectionManager 回调] --> B[保存最小 Fall 上下文\n稳定 eventId; 120 秒]
    B --> C[App 单次询问\n是否需要帮助?]
    C -->|需要帮助| D[事件立即成立\n不等待电话]
    C -->|不需要帮助| X[本次不成立\n清除待决上下文]
    C -->|未回答| E{120 秒内观察到\n新的 outgoing call?}
    E -- 否 --> X
    E -- 是 --> D
    D --> F[取得触发位置快照\n无原始传感器/健康数据]
    F --> G[HTTPS PUT 触发观察\n稳定 eventId + idempotency]
    G -->|ACK| H[删除 outbox payload\n保留 24h 最小去重标记]
    G -->|网络失败且 Fall+35min 内| I[加密最小 outbox\n按同一 payload 重试]
    I --> G
    G -->|超过 35min| J[丢弃迟到触发\n不得新建事件]
    H --> K[后端 ACTIVE / RECRUITING\n通知患者 iPhone]
```

CallKit 只提供“观察到一个新的外拨”，不能提供号码，因而不能证明拨打 120；App 也不能检测系统给紧急联系人的短信。

## 4. P/R 定位、Watch 降级与动态扩圈

```mermaid
flowchart TD
    A[事件 ACTIVE] --> B[REST 下发本设备\n权威参与时间窗]
    B --> C[iPhone 患者/已接受响应者\n每个合法 UTC 秒槽一条]
    C -->|同秒首次提交前\n取最新合格 fix| C
    C --> D{已有 5 个连续槽\n或累计移动 10m?}
    D -- 是 --> E[首次 REST 提交\n本地 record 立即永久封口]
    E --> F{服务端收到时\n最后秒槽已完整结束?}
    F -- 否 --> G[425 Too Early\n零落库; 原批原样重试]
    G --> F
    F -- 是 --> H[服务端 append-only 落库\n返回完整 ACK]
    H --> I[客户端删除本地重试副本\n不改写已封口 record]
    E -. 后续 REST 证明未 ACK 批次跨越 endedAt .-> J[合法 records 内容不变重组\n越界 records 追加隔离证据]
    J --> F
    A --> K{WatchConnectivity\nACTIVATED + reachable?}
    K -- 是 --> K2{后端快照\nfallbackAllowed?}
    K2 -- 否 --> L[Watch 不上传 fallback P]
    K2 -- 是 --> M
    K -- 否 --> M{Watch 自身有 WAN?}
    M -- 否 --> N[不能上传; 不自动结束事件]
    M -- 是 --> O[Watch 立即备份上传\n之后 5 秒或移动 10m]
    O --> P{后端连续 10 秒\n无有效 iPhone P?}
    P -- 否 --> Q[保存为备份事实\n不覆盖 iPhone]
    P -- 是 --> R[WATCH_FALLBACK 成为有效 P]
    H --> S[任一有效 iPhone P\n立即夺回主来源]
    R --> S
    H --> T[PostGIS 候选筛选]
    R --> T
    T --> U[1 km 候选]
    U -->|候选 <3| V[扩至 1.5 km]
    U -->|候选 >=3 但 30s 接受 <3| V
    V -->|仍不足| W[扩至 2 km]
    W --> X[按实际接受 N 继续\n只通知新增环带; 不缩圈]
```

非事件普通待命 R 为 120 秒/100 米；进入搜索圈而未接受为 15 秒/30 米。两者只保留最新位置，服务端 10 分钟 TTL 删除。事件参与者在自身权威参与窗口内对每个合法 UTC 整秒槽恰好留一条：有新定位则为 `FIX`，没有则为 `NO_NEW_FIX/NO_FIX`，进程未运行且重启等待 5 秒后仍缺失则为 `NO_NEW_FIX/APP_NOT_RUNNING`。不复制旧坐标。首次提交后只可原样重试；ACK 只解锁本地重试副本的删除。

## 5. 响应、AED 调度与退出

```mermaid
flowchart TD
    A[候选收到通用 APNs\n无患者精确位置/身份] --> B{30 秒内接受?}
    B -- 否 --> C[REFUSED / EXPIRED\n不计入 N]
    B -- 是 --> D[接受时后端重验资格\n计入有效 N]
    D --> E[目标 3 人; 动态补招]
    E --> F[目标 AED 数 = round N/3\n按 R -> A -> P 全程 ETA 排序\n资源不足者 GO_TO_PATIENT]
    F --> G{手机 MapKit 上报两段距离\n后端复核路线上下文与 AED 可用性}
    G -- 否 --> H[前往患者 + 记录 AED 缺口\n继续搜索其他资源]
    G -- 是 --> I[FETCH_AED: R -> A -> P\n每人一台且互不重复]
    I --> J{AED 可用?}
    J -- 是 --> K[AED_ACQUIRED 幂等回执\n向患者播报并前往 P]
    J -- 否 --> L[AED_UNAVAILABLE\n立即重派]
    L --> M{其他响应者有可用 AED 路线\n按完整 R-A-P 距离比较}
    M -- 是 --> N[15 秒改道 offer]
    N -->|明确同意| I
    N -->|拒绝/超时| H
    M -- 否 --> H
    D --> O{响应者主动退出?\n唯一响应者须连续确认 3 次}
    O -- 是 --> P[立即撤销精确位置/团队/通信权限\nuserId 对本事件 EXITED_FINAL]
    P --> Q{AED 已在手且能当面交接?}
    Q -- 是 --> R[双方各确认一次交接]
    Q -- 否 --> S[App 内拍照 + 当前定位\n生成临时 AED 任务]
```

## 6. 结束、留存和查看申请

```mermaid
flowchart TD
    A[事件仍 ACTIVE] --> B{明确结束操作?}
    B -- 患者选择误报并确认一次 --> C1[CANCELLED_CONFIRMED_FALSE_ALARM\n意外触发]
    B -- 患者选择结束救助并确认一次 --> C2[RESOLVED\n患者已得到救助]
    B -- 到场响应者报告急救接管 --> C2
    B -- 否 --> D[T+30 分钟状态询问]
    D -->|5 分钟内继续| A
    D -->|T+35 无回答| E[CLOSED_UNCONFIRMED_NO_RESPONSE]
    C1 --> F[撤销实时权限/导航\n广播 REST 真相]
    C2 --> F
    E --> F
    F --> G[0-30 天受限在线原始证据]
    G --> H[31 天-3 年加密封存]
    H --> I[满 3 年删除精确轨迹/照片/消息/设备关联\n只留不可逆聚合]
    G --> J[本人提交查看申请]
    J --> K[登录 + 本机生物识别/密码\n服务器 challenge]
    K --> L[<=15 工作日审批\n最多 24h 只读自己的数据]
    L --> M[禁止下载/导出/分享]
```

事件证据按序号和 SHA-256 hash chain 追加，媒体和位置批次各有 hash，终态生成服务器签名 manifest。该结构证明记录完整性，不证明现实内容必然真实。
