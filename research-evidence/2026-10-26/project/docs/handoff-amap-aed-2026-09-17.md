# 高德 AED 采集结果（2026-09-17）

- 范围：佛山、广州、深圳及行政区 API 返回的 25 个区。市/区 5 个关键词，中心点 50km 周边 2 个关键词；并非覆盖所有空间网格的普查。
- 扩大采集 199 次请求，59 个去重结果，名称/地址/设施标签明确匹配 AED 的候选 1 个。无分页达到设定上限，无请求错误。其余 58 个不能认定为 AED。
- 另有接口比较探测 3 次；坐标转换导出独立调用，不包含在 199 次中。
- server-field-drafts.json/csv 与服务器 aedSchema 字段对齐，但缺失值保持 null，不能直接导入。
- server-schema-validation.json 使用项目实际 Zod schema 验证：id/name/aedPosition 子集通过 1 条；完整记录通过 0 条。
- 缺失字段：openFrom/openUntil/floor/floorTransferSeconds/accessNote/accessDelaySeconds/verificationSeconds/available。
- provenance.json 保留原始高德 GCJ-02 坐标、原始 POI、来源时间与坐标转换过程。WGS-84 坐标采用高德正向转换接口的数值逆解，回代一致性不代表物理定位精度。
- registration 另需来源许可、维护主体、核验与有效期、物理精度等信息；没有伪造这些字段。
- raw.jsonl 为完整请求参数与响应，不含 Key；未导入服务器数据库，未改变业务代码和 schema。
- 下一步：对照高德 App/网页的已知 AED 点位，判断普通 POI API 与专题 AED 数据覆盖差异；取得更多数据后复用字段导出脚本，不能用自动化公司等误命中补数量。

## 本轮新增脚本

- scripts/collect-amap-aed-expanded.py：限额采集、保存原始响应、去重和误匹配分离。
- scripts/export-amap-aed-drafts.py：坐标逆解、服务器字段草稿和来源元数据。
- 两个脚本语法检查通过，实际采集及导出通过；完整 schema 验证未通过的原因见上。
- 保留既有未提交修改；Key 只通过进程环境使用。

结果目录：/Users/REDACTED/Documents/ChatGPT/毕设项目 2/output/amap-aed-expanded-20260917-101941
