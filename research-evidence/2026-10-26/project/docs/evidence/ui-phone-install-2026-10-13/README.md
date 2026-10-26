# 新 UI 手机安装 · 2026-10-13

已覆盖安装到原 iPhone 17 Pro，独立设备查询确认 `dev.codex.aedresponse` 为 **2.0 (12)**，ProductType为iPhone18,1。

本轮采用当前完整本地源码：已提交的UI优化与既有本地功能一起构建，不把纯UI提交HEAD冒充当前工作树。只将iPhone/Watch构建号11升级为12并重新生成工程；未改业务源码、未自动提交或推送。

## 已完成验证

- 正式AEDResponse Debug签名构建成功，沿用既有Watch模拟测试编译条件，手机测试工具与测试特性开关仍为NO。
- 手机、内嵌Watch、独立Watch三bundle均通过严格验签；phone profile包含本机且APNs development与Time Sensitive有效，Watch Fall Detection权限保留。profile未过期。
- 保存206个iOS/contracts源文件快照并逐一SHA256确认构建过程中未变。内嵌与独立Watch可执行文件哈希相同。
- 普通USB安装返回InstallComplete100%、Complete、exit0；安装后独立list回读2.0/build12。
- 覆盖安装采用原bundle ID，没有卸载旧App或执行数据清理。

## 证据与范围

产物、修改前配置、完整本轮源快照及日志：`[BUILD_CACHE]/ui-build12-20261013._a5jevfc`。其中build.log、install.log、signed-verification.json、source-manifest.json、installation-verification.json分别记录构建、安装、验签、源快照与结果。

本轮未使用镜像、DDI或Simulator；未启动救助/真实跌倒/SOS、未部署后端，未通过本轮证据声称Watch设备已完成更新或App已启动。手机可由用户直接打开查看UI。新MapKit客户端功能需要配套服务端，本轮安装不等于新地图业务前后端验收。
