# HTTP API

所有业务 API 同源、返回 `Cache-Control: no-store`，认证使用 HttpOnly Cookie。浏览器写请求必须带精确 `Origin` 和登录状态返回的 `X-CSRF-Token`。错误结构为：

```json
{"error":{"code":"REVISION_CONFLICT","message":"笔记已在其他位置更新","requestId":"..."}}
```

## 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 会话状态和 CSRF token |
| POST | `/api/session` | `{email,password}` 登录（拒绝旧 token 字段） |
| DELETE | `/api/session` | 撤销当前会话并清 Cookie |
| POST | `/api/register` | `{email,username,password,confirmPassword}`，默认关闭，100 人硬上限 |
| GET/PATCH | `/api/account` | 当前账号 / `{username}` 修改名称 |
| POST | `/api/account/email` | `{email,currentPassword}`；成功撤销全部会话 |
| POST | `/api/account/password` | `{currentPassword,password,confirmPassword}`；成功撤销全部会话 |
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

## 用户级任务与运维

GET /api/maintenance/jobs/:id 和 POST /api/maintenance/jobs/:id/retry 仅限当前用户任务。全库 mode/backup/restore/attachments 维护接口已移除，默认 admin 也没有全库权限。所有业务路径、列表、搜索、版本、附件和幂等回执按会话 user_id 授权；越权返回统一 404。
