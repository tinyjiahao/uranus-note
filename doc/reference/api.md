# HTTP API

所有业务 API 同源，认证使用 HttpOnly Cookie。除附件 GET 200/304 使用私有强缓存外，API 返回 `Cache-Control: no-store`。浏览器写请求必须带精确 `Origin` 和登录状态返回的 `X-CSRF-Token`。本文描述当前 v7 工作区，生产部署状态见实施记录。错误结构为：

```json
{"error":{"code":"REVISION_CONFLICT","message":"笔记已在其他位置更新","requestId":"..."}}
```

## 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 会话状态和 CSRF token |
| POST | `/api/session` | `{email,password}` 登录并记住账号（最多 5 个）；已有有效活动会话时也要求其 CSRF |
| POST | `/api/session/activity` | 当前会话 CSRF + Origin；按小时条件续期，返回 {expiresAt} 并同步 Cookie；不续期其他账号 |
| DELETE | `/api/session` | 原子撤销本浏览器记住的全部有效会话并清活动/记住账号 Cookie；要求活动会话 CSRF |
| GET | `/api/account/sessions` | 从 Cookie 验证并返回已登录账号、到期时间、当前状态、limit 及 switchToken；没有有效凭据则空列表，不返回会话凭据 |
| POST | `/api/account/switch` | `{userId}`，精确 Origin + `X-Account-Switch-Token`；仅切换 Cookie 持有的有效会话，不续期；不要求活动会话仍有效 |
| POST | `/api/account/forget` | `{userId}`，活动会话 CSRF；仅移除 Cookie 中持有的非当前账号会话，不删除用户或笔记 |
| POST | `/api/register` | `{email,username,password,confirmPassword}`，默认关闭，100 人硬上限 |
| GET/PATCH | `/api/account` | 当前账号 / `{username}` 修改名称 |
| POST | `/api/account/email` | `{email,currentPassword}`；成功撤销全部会话 |
| POST | `/api/account/password` | `{currentPassword,password,confirmPassword}`；成功撤销全部会话 |
| GET | `/api/health` | 匿名总体状态 |

当前配置 `SESSION_TTL_SECONDS=604800`（7 天）。`uranus_session` 为活动凭据，`uranus_accounts` 为最多 5 个独立签名凭据的 HttpOnly Cookie；两者生产均 Secure/SameSite=Strict/Path=/。Cookie 与服务器当前到期时间保持一致；默认 7 天会话在前台真实交互后的成功业务请求触发滑动续期，每小时最多延期一次至当前时间后 7 天。切换本身不续期，后台轮询不触发续期。账号列表接口返回的 switchToken 仅用于该 Cookie 账号集合的切换 CSRF，不可作为业务 API 会话凭据；集合变化后须重新获取。

## 文件夹与笔记

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/folders` | 列表/创建 |
| PATCH/DELETE | `/api/folders/:id` | 重命名/删除 |
| GET/POST | `/api/notes` | 分页筛选搜索/幂等创建 |
| GET/PATCH/DELETE | `/api/notes/:id` | 详情/条件保存/软删除；`hard=1` 排队清除 |
| GET | `/api/notes/:id/stats` | 只读概要：附件数量与大小（图片/文件、仅历史版本引用、待清理）、历史版本数量与最近时间；回收站笔记也可查询，越权 404 |
| POST | `/api/notes/:id/restore` | 从回收站恢复 |
| POST | `/api/notes/empty-trash` | 创建清空任务 |
| POST | `/api/import/markdown` | 导入 Markdown 并创建笔记 |

列表查询支持 `folder_id`、`starred=1`、`deleted=1`、`q`、`sort_by`、`sort_dir`、`page`、`pageSize`。PATCH 携带 `expected_revision`、UUIDv7 `operation_id`、当前客户端的 `content_schema_version: 15` 和要修改的字段。服务端兼容读取 schema 1—11，旧客户端不得覆盖较新 schema；版本常量以 `shared/schemaVersion.ts` 为准。label/fileAttachment/noteLink 分别从版本 6/7/8 开始支持；附件 display 属性从版本 9 开始，表格内文件附件从版本 10 开始，textColor mark 和 highlight 的 color 属性从版本 11 开始，颜色只接受共享白名单；inlineImage（行内图片）从版本 12 开始支持，只能位于段落内；段落和标题的 `indent` 属性（1–6 的整数，空或 0 表示无缩进）从版本 13 开始支持；代码块的布尔属性 `collapsed`（折叠状态）从版本 14 开始支持；行内文件附件节点 `inlineFile` 从版本 15 开始支持。

## 附件与版本

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/attachments` | multipart：`file/note_id/operation_id` |
| GET/DELETE | `/api/attachments/:id` | 私有流式读取/删除无引用附件 |
| POST | `/api/attachments/:id/copy` | 跨笔记复制 |
| GET/POST | `/api/notes/:id/versions` | 列表/手动标记 |
| GET | `/api/notes/:id/versions/:vid` | 快照正文 |
| POST | `/api/notes/:id/versions/:vid/restore` | 原子备份当前正文并恢复 |

附件接受 PNG/JPEG/WebP/GIF、PDF、docx/xlsx/pptx、ZIP、TXT/Markdown/CSV/JSON/YAML（文本须为无 NUL 的合法 UTF-8），具体 MIME 白名单见 `shared/files.ts`。最大 10,000,000 字节、请求体上限 10.5 MB 不变；正文 JSON 最大 1,500,000 UTF-8 字节。

附件 200/304 为 `Cache-Control: private, max-age=31536000, immutable`，ETag 条件判断前执行用户归属校验。图片 inline；其他文件强制 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`。本机已缓存副本可能在退出登录或服务端删除后保留，浏览器淘汰时机不保证。

## 用户级任务与运维

GET /api/maintenance/jobs/:id 和 POST /api/maintenance/jobs/:id/retry 仅限当前用户任务。全库 mode/backup/restore/attachments 维护接口已移除，默认 admin 也没有全库权限。所有业务路径、列表、搜索、版本、附件和幂等回执按会话 user_id 授权；越权返回统一 404。
