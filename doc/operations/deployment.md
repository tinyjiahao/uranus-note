# 部署指南

> v6 使用受控部署工具迁移邮箱账号，不通过普通账号 Cookie 或公开维护接口操作全站数据。实际发布记录与仍需人工验收的范围见 implementation-v6.md。

升级前阅读 [schema 2—4 升级与验证说明](../implementation/implementation-v2.md) 和 [schema 5 实施记录](../implementation/implementation-v5.md)。必须先备份再迁移；已有新 schema 内容时不能直接回滚到旧 Worker。本地实现不代表已执行生产发布。

v7 工作区新增 0010 迁移，保留旧列并回填新的版本范围列，应用层支持 schema 1—11。升级步骤与未完成的真机验收见 [v7 实施记录](../implementation/implementation-v7.md)；最新发布状态以实施记录末尾为准。产生 label/fileAttachment/noteLink 后不得回滚到 v6 Worker。

## 1. 创建资源

登录 Wrangler 后创建 D1 和私有 R2：

```bash
npx wrangler login
npx wrangler d1 create uranus-notes
npx wrangler r2 bucket create uranus-notes-uploads
```

复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`，填写 D1 的 `database_name/database_id`、R2 bucket 名称和本环境独立的正整数 Rate Limiting namespace。生产、staging、development 必须使用不同资源、域名和 Secrets。

R2 bucket 不应启用 `r2.dev` 或公开自定义域名。应用只通过 `UPLOADS` binding 访问 `uranus/attachments/` 前缀。

## 2. 配置与迁移

`APP_ENV` 在生产保持 `production`。如使用自定义域名，将 `APP_ORIGIN` 配置为精确 origin（例如 `https://notes.example.com`，不要带尾部 `/`）。

```bash
npm ci
npm run cf:typegen
npm run db:migrate:remote
```

迁移历史表固定为 `uranus_d1_migrations`。共享 D1 中只能有一个使用 `uranus_` 前缀的 Uranus 空间；迁移和恢复不会操作其他前缀对象，但前缀不是数据库权限隔离。

生成 SESSION_SECRET 安全随机值，并通过交互式命令输入，避免出现在 shell history：

```bash
npx wrangler secret put SESSION_SECRET
```

SESSION_SECRET 至少 32 随机字节。初始 admin 密码通过受控本地工具读取，不能部署公开初始化接口。REGISTRATION_ENABLED 默认 false。`VITE_*` 是公开客户端配置，绝不能用于 Secrets。

## 3. 构建和发布

### 3.1 无数据变更：直接发布

按用户最新要求，样式、表格吸顶、菜单及其他不涉及数据库结构、持久化内容格式、数据写入/删除逻辑或附件存储的改动，走轻量发布路径：

1. 检查 diff 和目标环境，运行类型检查、构建及本次改动相关测试。只改文档不需要业务测试或部署。
2. 直接发布 Worker 与静态资源，不进入维护模式、不执行 D1/R2 全量备份、不创建临时运维预览、不执行远程迁移。`npm run deploy` 已包含构建；如已验证当前构建且源码未变，可用 `npx wrangler deploy -c dist/worker/wrangler.json` 发布同一产物，避免重复构建。
3. 检查线上健康、匿名 API 保护、静态资源与相关功能，记录实际结果及版本。检查不依赖备份清单，不为验证而写入用户笔记。
4. 用户要求 commit/push 时，更新发布记录后提交并推送，确认工作区与远程同步。

本次表头滚动优化属于此路径。无需为了纯界面更新中断线上写入或反复导出附件。

### 3.2 涉及数据的发布

涉及数据库迁移、数据转换/回填、正文持久化格式、写入/删除规则或附件存储的改动，按对应版本需求执行备份及必要的维护排空、迁移和数据一致性验证。是否需要备份依据实际行为，不能仅检查是否新增 migration 文件。首次初始化或旧版本数据升级沿用第 5 节流程。

### 3.3 可用命令

```bash
npm run typecheck
npm test
npm run build
npm run preview
npm run deploy
```

Cloudflare Vite Plugin 生成 `dist/worker/wrangler.json`，部署脚本使用该构建输出。`/api/*` 由 `run_worker_first` 优先进入 Worker，其余未知导航由 SPA fallback 返回 `index.html`。

## 4. 冒烟检查

每次发布检查匿名 `/api/health`、静态资源加载与匿名 API 保护。其余按改动范围验证：登录、保存、搜索、图片、历史版本、回收站等相关流程；纯界面发布不执行全库备份和维护模式演练。完整版本升级的验收仍覆盖错误邮箱/密码、登录及刷新复用、新建和自动保存、中英文及 `%/_` 搜索、图片上传/读取、手动版本与恢复、回收站及硬删除任务；备份/维护流程仅在涉及数据的发布中验证。

自定义域名必须验证 HTTPS、Secure Cookie、Origin/CSRF 和 HSTS。配置缺失时 API 必须返回 503，不能临时公开数据。

## 5. 升级

本节针对涉及数据的升级；无数据变更的发布按 §3.1 直接部署。数据升级前完成 D1+R2 备份；涉及依赖或平台配置升级时检查相关 release notes。v6 顺序为：维护排空与备份 → 追加 migrations → 受控初始化/归属回填 → 新鉴权切换 → 验证后解除冻结。v5 必须先应用 `0006_content_v5.sql`，再开放单元格富文本和小号文本入口。已发布 migration 不得改写；Worker 回滚不等于 schema 回滚。

### v5 → v6 受控远程切换

先检查 `wrangler.jsonc` 确实指向目标实例，登录 Wrangler。将初始化密码放入被 Git 忽略的 `.env.production.local` 的 `ADMIN_INITIAL_PASSWORD`；不要使用 `VITE_` 前缀，也不要上传该文件。已有 `SESSION_SECRET` 保留，初始密码只由本机脚本读取用于生成密码哈希，无需设为 Worker Secret。

```bash
node --use-env-proxy scripts/remote-operations.mjs status
node --use-env-proxy scripts/remote-operations.mjs backup backups/production-before-v6
node --use-env-proxy scripts/remote-operations.mjs migrate backups/production-before-v6
node --use-env-proxy scripts/remote-operations.mjs initialize admin@example.com backups/production-before-v6
npm run deploy
node --use-env-proxy scripts/remote-operations.mjs audit backups/production-before-v6
# 确认新入口健康、归属与密码哈希正确后解除冻结（冻结期间禁止签发登录会话）：
node --use-env-proxy scripts/remote-operations.mjs resume <maintenance-id>
node --use-env-proxy scripts/verify-production-v6.mjs backups/production-before-v6 admin@example.com
```

工具使用 Cloudflare 登录凭据创建临时远程预览，通过真实 D1/R2 bindings 操作；另加每次随机的运维密钥，结束即关闭预览，不部署永久运维路由。**不得 deploy `scripts/operations-preview.worker.ts` 或临时配置**。需要代理的环境须显式设置 HTTPS_PROXY/HTTP_PROXY，NO_PROXY 包含 localhost/127.0.0.1，不修改用户系统配置。任何失败保留冻结状态及可重试进度；先检查状态，不能为绕过错误直接解除冻结。

远程工具不提供覆盖式恢复；备份先在独立本地空目标验证，远程空目标恢复尚需独立目标的验收。切换成功后删除已无使用方的旧 `API_TOKEN` Worker Secret；不要删除 `SESSION_SECRET`。
