# AGENTS.md

适用于整个 Uranus 仓库，指导实现 Cloudflare 原生笔记应用。

## 需求基线

- 基础实现与验收基线为 `doc/plan_v1.md`；v2 增量需求见 `doc/plan_v2.md`，开始工作前阅读相关章节。v2 未变更的约束继续沿用 v1；标为待确认的鉴权方案不得自动实施。
- v3 交互实施与验收见 `doc/plan_v3.md`，`doc/ux_v1.md` 仅为走查来源。v3 明确调整的交互优先，其余沿用 v1/v2；26 项来源的范围和验收以 v3 为准，不实施其排除项。
- v3 保持 content schema 4，不为纯 UI 优化新增迁移或变更鉴权；搜索片段使用有界规范化文本和明确的码点范围，不能把范围当原始正文位置。菜单、右键和键盘入口复用同一命令与保存路径。
- 顶部标题是文档首个顶层段落/标题块的编辑投影，正文区不重复显示；保存前合并完整 JSON 并走原保存队列。不得抽走表格/列表子节点，也不得只保存拆分后的正文。规则见 plan_v3 §7.2 补充。
- v3 格式工具栏保留当前按钮顺序和独立入口，不重排、不分组、不收纳原有按钮；窄屏局部横向滚动。实现与待验收范围记录在 `doc/implementation-v3.md`，真机、IME 和读屏测试未完成时不得宣称 v3 已通过全部发布门槛。
- 项目按规格从脚手架开始建设，逐步创建代码、配置、测试和开源文件。
- 执行任务前检查实际文件和可用脚本，不得把目标命令描述为已可用。
- 按规格区分 v1、P2 和非目标，不把规划功能报告为已实现。
- v2 核心体验与网页令牌轮换分开发布/验收；plan_v2 第 8 节仅为后续规划。设置入口存在不代表已支持网页换令牌，待确认安全方案不自动覆盖现有规则。
- 正文段落/标题对齐使用 content schema 3（见 plan_v2 §3.5）；兼容读取 1/2，旧客户端不得覆盖 schema 3。发布前先备份并应用 0004 迁移。
- 图片对齐与表格内图片使用 content schema 4（见 plan_v2 §3.6），兼容读取 1/2/3，旧客户端不得覆盖 schema 4；发布前备份并应用追加的 0005 迁移。单元格仅允许段落和图片，不开放嵌套表格等复杂块。

## 技术方案与目录

- 前端：React、TypeScript strict、Vite、React Router 客户端 Declarative Mode。
- TanStack Query 管理服务端数据，Zustand 管理少量 UI 状态，TipTap/ProseMirror 管理编辑内容。
- 后端：Hono 运行于 Cloudflare Workers，同源 `/api/*`，静态资源与 Worker 一起部署。
- Cloudflare Vite Plugin 和 Wrangler 提供本地 Workers Runtime、模拟 bindings、构建和部署。
- 页面在浏览器中渲染，数据请求统一通过同源 API；React Router 只负责客户端导航。
- 选择兼容稳定依赖、提交 lockfile、固定开发 Node 版本和 compatibility date；仅在依赖确需且验证后启用 nodejs_compat。
- `src/`：浏览器入口、页面、编辑器、API client、Query hooks、UI store、保存队列。
- `worker/index.ts`：fetch/scheduled；`worker/middleware/`：鉴权、配置、CSRF、错误和日志；`worker/routes/`：HTTP 接口。
- `worker/services/`、`worker/repositories/`：业务与数据访问，显式接收 D1/R2，不依赖 Hono Context。
- `shared/`：DTO、Zod 校验和内容 schema，不包含 Secrets 或服务端模块。
- `migrations/d1/`：SQL；`tests/`：单元、Workers 集成和浏览器测试；`public/`：静态资源；`doc/`：有效规格和开发文档。

## Cloudflare 与数据库约束

- 结构化数据只通过 D1 binding `DB`，附件只通过私有 R2 binding `UPLOADS` 访问。
- HTTP/scheduled 入口获取 env 后显式传入业务层。浏览器不直连资源；运行时不使用管理 REST API 或 R2 S3 密钥替代 bindings。
- 不依赖本地文件持久化、全局数据库连接或长驻 timer。定时任务使用 Cron Trigger，进度和重试状态持久化。
- `/api/*` 优先进入 Worker，未知 API 返回 JSON 404，不落入 SPA fallback；客户端深链接刷新正常返回 SPA。
- 所有项目表、虚表、索引、触发器和视图以 `uranus_` 开头，平台内部对象除外。
- Wrangler 迁移表固定 `uranus_d1_migrations`，schema 版本独立于共享数据库中其他应用管理。
- 初始化、迁移、清理和恢复不影响共享 D1 中其他应用对象；前缀不代表权限隔离，也不隔离多个 Uranus 实例。
- SQL 参数绑定，排序字段白名单。已发布 migration 只追加不改写，普通请求不执行 DDL。
- v1 仅使用普通表 `uranus_note_search` 做规范化字面子串搜索，不创建 FTS 虚表，不混合分词检索；范围、排序、分页及基准测试按规格执行。
- TipTap JSON 是唯一权威正文；遵守 1,500,000 字节正文上限及整体行预算，不在同一行额外存完整 HTML/纯文本。
- R2 key 使用 `uranus/attachments/` 前缀，维护仅操作此范围，私有附件通过鉴权 API 流式读取。

## 保存与资源一致性

- 800ms 防抖、正文和元数据共用客户端串行队列、整数 revision 乐观锁、operation_id 幂等；保存确认绑定 edit_sequence，不能删除或覆盖较新草稿。
- 条件更新零行返回 409；D1 batch 不会因此自动回滚，搜索表、版本、引用及幂等写入必须受相同成功条件保护。
- 幂等操作遵守 UUIDv7 时间窗口、租约接管和固定回执契约，不以最新正文代替原回执；过期重试不可自动重新创建。
- 请求取消或 beacon 入队不等于保存成功；仅确认服务端响应后显示已保存。
- 草稿配额、退出提交预算、冲突、重试和登录过期按规格处理，不静默覆盖或宣称无限离线保障。
- 草稿存 IndexedDB，localStorage 只存 UI 偏好；笔记和快照携带 content_schema_version，未知版本/节点拒绝写入，不静默丢弃。
- v2 内容 schema 为 2，兼容读取 schema 1；旧客户端不得覆盖 schema 2。表格列宽限定 64–2000px，对齐与宽度模式使用共享白名单。0003 迁移保留旧 CHECK 列为兼容占位列，不重建有附件引用的父表；产生 schema 2 内容后不得直接回滚旧 Worker。
- 当前正文和历史快照共同维护附件引用，不能因正文移除图片破坏历史版本。
- 跨笔记图片复制生成目标专属附件；零引用宽限从 unreferenced_at 起算，检查零引用并转 deleting 与新增引用互斥，禁止先查后无条件删除。
- 硬删除先持久化状态，再删 R2，最后清除记录；失败保留 object_key 与重试进度。
- D1/R2 无跨资源事务，使用幂等、补偿和分批任务保持一致。
- 每日发现过期回收站、每 5 分钟处理到期队列；持久化租约、游标、退避和失败状态，提供人工重试。
- v1 提供运维备份恢复工具，不建设可视化中心；持久化维护模式并排空在途写入后导出业务数据和附件字节，记录 schema 与校验和，支持中断续传。搜索表可重建，恢复仅限空目标，不把共享 D1 整库回滚视为单应用恢复。

## 鉴权与安全

- API_TOKEN 为应用令牌；SESSION_SECRET 为会话签名密钥，分别由至少 32 字节安全随机数生成。
- 生产使用 Worker Secrets，本地用未提交的 `.dev.vars`；所有 VITE_* 都视为公开。
- 浏览器用 HttpOnly 会话，生产 Cookie 设置 Secure、SameSite=Strict、Path=/，不设 Domain。
- Cookie Max-Age/Expires 与会话期限一致；登录使用 LOGIN_RATE_LIMITER binding，默认每 IP 每 60 秒 10 次，不宣称严格全局计数。
- 验证签名、期限及当前 Token 指纹；密钥轮换生效后旧会话失效。签名不等于加密，载荷不得含原始 Token。
- 数据 API 统一鉴权，浏览器写请求校验 Origin 与会话绑定 CSRF；beacon 同样执行保护。
- 缺少 binding/secret 返回 503 并拒绝访问，不降级公开或本地生产存储。
- Token 不进入 localStorage、IndexedDB、URL 或日志；本地草稿生命周期按规格管理。
- 日志不得记录正文、标题、搜索词、附件内容、Cookie、Authorization 或 Secrets；路由使用模板。
- HTML、URL、上传内容按白名单校验；条件下载与 Range 不得绕过鉴权。
- 公开 SPA shell 不含私人数据；敏感 API 不进入共享缓存，主题初始化须兼容 CSP。
- 官方 note.searchdiff.com 不作为硬编码依赖，使用请求 origin 或 APP_ORIGIN。

## 验证与交付

- 首日起使用本地 D1/R2，dev、preview、migration 共用已验证状态目录，默认不访问生产。
- 脚手架应提供 dev、build、preview、deploy、cf:typegen、db:migrate:local、db:migrate:remote、typecheck、test、test:e2e；创建后逐项验证，不能假定当前存在。
- 使用 npm ci 复现安装；有意更新依赖同步 lockfile。preview 验证构建后的 Worker 与 bindings，不能只是静态文件服务。
- 业务修改运行相关单元测试；数据、安全、上传和并发改动需 Workers 集成测试；编辑器和关键流程需浏览器测试。
- 隔离测试预置非 uranus_ 表和非 uranus/ 对象，验证初始化、升级、清理及恢复不影响它们。
- 发布按 plan_v1 的退出条件完成类型、构建、测试、staging、自部署和备份恢复验证。
- 文档变更检查结构、命令、配置及引用，无需为纯文档变更新增业务测试。
- 项目提供 README、LICENSE、CONTRIBUTING、SECURITY、配置示例及部署/API/备份文档。
- 重大需求变化同步本文件和对应版本需求文档；不覆盖无关用户改动。v2 网页令牌轮换方案确认前，继续遵循现有 API_TOKEN Secret 鉴权规则。
- 不提交真实 Secrets、资源配置、数据库、附件、备份及构建物；调整 gitignore 时保留示例文件规则。
- 最终交付说明列明完成内容、实际验证及未完成范围，不用规划替代完成证据。
