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

列表查询支持 `folder_id`、`starred=1`、`deleted=1`、`q`、`sort_by`、`sort_dir`、`page`、`pageSize`。PATCH 携带 `expected_revision`、UUIDv7 `operation_id`、`content_schema_version: 1` 和要修改的字段。

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

- 正文请求可声明 `content_schema_version: 2`，新客户端应始终声明；schema 1 笔记保存时升级。旧客户端向 schema 2 笔记写入返回 `409 CLIENT_UPDATE_REQUIRED`，需刷新页面，不能忽略新属性继续保存。
- 表格属性：`widthMode: fluid|fixed`；单元格：`colwidth: [64..2000] | null`、`textAlign: left|center|right | null`、`verticalAlign: top|middle|bottom | null`。拒绝非有限数、任意 style 和合并单元格。
- `GET /api/notes` 返回 `totalCount`；排序统一为置顶优先，标题排序空值末尾，同值 id 升序；分页参数必须为有效正整数，每页最多 100 条。
- `GET /api/settings/status` 需会话鉴权，返回应用版本、配置完整性、D1 实际只读探测结果和 R2 已绑定但未探测的状态，不返回资源 ID 或 Secrets。
- 网页换令牌 API 未开放，鉴权仍遵循 v1 的 Worker Secrets 方案。
