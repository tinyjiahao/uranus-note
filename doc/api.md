# HTTP API

所有业务 API 同源、返回 `Cache-Control: no-store`，认证使用 HttpOnly Cookie。浏览器写请求必须带精确 `Origin` 和登录状态返回的 `X-CSRF-Token`。错误结构为：

```json
{"error":{"code":"REVISION_CONFLICT","message":"笔记已在其他位置更新","requestId":"..."}}
```

## 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 会话状态和 CSRF token |
| POST | `/api/session` | `{token}` 登录 |
| DELETE | `/api/session` | 退出 |
| GET | `/api/health` | 匿名总体状态 |

## 文件夹与笔记

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/folders` | 列表/创建 |
| PATCH/DELETE | `/api/folders/:id` | 重命名/删除 |
| GET/POST | `/api/notes` | 分页筛选搜索/幂等创建 |
| GET/PATCH/DELETE | `/api/notes/:id` | 详情/条件保存/软删除；`hard=1` 排队清除 |
| POST | `/api/notes/:id/restore` | 从回收站恢复 |
| POST | `/api/notes/empty-trash` | 创建清空任务 |
| POST | `/api/import/markdown` | 导入 Markdown 并创建笔记 |

列表查询支持 `folder_id`、`starred=1`、`deleted=1`、`q`、`sort_by`、`sort_dir`、`page`、`pageSize`。PATCH 携带 `expected_revision`、UUIDv7 `operation_id`、当前客户端的 `content_schema_version: 5` 和要修改的字段。服务端兼容读取 schema 1—5，旧客户端不得覆盖较新 schema。

## 附件与版本

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/attachments` | multipart：`file/note_id/operation_id` |
| GET/DELETE | `/api/attachments/:id` | 私有流式读取/删除无引用附件 |
| POST | `/api/attachments/:id/copy` | 跨笔记复制 |
| GET/POST | `/api/notes/:id/versions` | 列表/手动标记 |
| GET | `/api/notes/:id/versions/:vid` | 快照正文 |
| POST | `/api/notes/:id/versions/:vid/restore` | 原子备份当前正文并恢复 |

附件只接受 PNG/JPEG/WebP/GIF，最大 10,000,000 字节；正文 JSON 最大 1,500,000 UTF-8 字节。

## 维护

`/api/maintenance/mode` 管理 `normal → draining → frozen` 备份状态，或空目标的 `normal → restoring → frozen` 恢复状态。`/api/maintenance/backup` 和 `/api/maintenance/restore` 供仓库脚本使用。任务状态通过 `/api/maintenance/jobs/:id` 查询，失败任务可 POST `retry`。

维护 id 只关联作业，不是认证凭证。普通会话、Origin 和 CSRF 始终必需。
# v2 增量

- v2 初始正文版本为 `content_schema_version: 2`；后续段落对齐升级至 3，图片对齐及格内图片升级至 4。旧客户端向较新 schema 笔记写入返回 `409 CLIENT_UPDATE_REQUIRED`，需刷新页面，不能忽略新属性继续保存。
- 表格属性：`widthMode: fluid|fixed`；单元格：`colwidth: [64..2000] | null`、`textAlign: left|center|right | null`、`verticalAlign: top|middle|bottom | null`。拒绝非有限数、任意 style 和合并单元格。
- `GET /api/notes` 返回 `totalCount`；排序统一为置顶优先，标题排序空值末尾，同值 id 升序；分页参数必须为有效正整数，每页最多 100 条。
- `GET /api/settings/status` 需会话鉴权，返回应用版本、配置完整性、D1 实际只读探测结果和 R2 已绑定但未探测的状态，不返回资源 ID 或 Secrets。
- 网页换令牌 API 未开放，鉴权仍遵循 v1 的 Worker Secrets 方案。

## v5 内容增量

- schema 5 新增语义 `small` mark，以及表格单元格中的无序/有序/待办列表、引用和代码块；仍拒绝嵌套表格、合并单元格和任意 HTML。
- `small` 不允许出现在标题、代码块或行内代码中。表格仍必须是矩形，每行单元格数量相同。
- 跨笔记图片复制继续使用 `POST /api/attachments/:id/copy` 生成目标笔记专属附件；同笔记复制可复用原附件引用。
- schema 5 对数据库约束的支持由追加迁移 `0006_content_v5.sql` 提供。部署 Worker 前先备份并执行迁移。

## v3 搜索片段（可选响应扩展）

有非空 `q` 的列表项增加 `searchMatch`，不传查询时省略：

```json
{"source":"body","text":"😀前abc后","ranges":[[2,5]],"normalized":true,"before":false,"after":true}
```

- 语义仍是 NFKC + 小写后的字面子串，标题命中优先，否则取正文首个命中；不引入相关性排序。
- `text` 最多 200 个 Unicode 码点，`ranges` 是该文本的码点半开区间；不是 UTF-16 索引，不是原文位置。上例区间对应 `abc`。
- `before/after` 表示两侧被截断，省略号由前端另行展示，不计入区间。前端按纯文本节点和 mark 渲染，不注入 HTML。
- SQLite 只为当前返回页的 id 裁剪片段；响应不含完整规范化搜索正文或正文 JSON。现有鉴权、范围、置顶、稳定排序及分页不变。
- 列表菜单仍使用原 PATCH/删除/恢复接口；修改正在编辑的笔记必须经已有串行保存队列，不新增旁路保存 API。
