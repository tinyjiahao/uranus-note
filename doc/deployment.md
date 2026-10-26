# 部署指南

升级前阅读 [schema 2—4 升级与验证说明](implementation-v2.md) 和 [schema 5 实施记录](implementation-v5.md)。必须先备份再迁移；已有新 schema 内容时不能直接回滚到旧 Worker。本地实现不代表已执行生产发布。

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

生成两个不同的安全随机值，并通过交互式命令输入，避免出现在 shell history：

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put SESSION_SECRET
```

两个值各自至少 32 随机字节。`VITE_*` 是公开客户端配置，绝不能用于 Secrets。

## 3. 构建和发布

```bash
npm run typecheck
npm test
npm run build
npm run preview
npm run deploy
```

Cloudflare Vite Plugin 生成 `dist/worker/wrangler.json`，部署脚本使用该构建输出。`/api/*` 由 `run_worker_first` 优先进入 Worker，其余未知导航由 SPA fallback 返回 `index.html`。

## 4. 冒烟检查

发布后逐项验证：匿名 `/api/health`；错误 Token；正确登录及刷新复用；新建和自动保存；中英文及 `%/_` 搜索；图片上传/读取；手动版本与恢复；回收站及硬删除任务；备份进入/退出维护模式。

自定义域名必须验证 HTTPS、Secure Cookie、Origin/CSRF 和 HSTS。配置缺失时 API 必须返回 503，不能临时公开数据。

## 5. 升级

升级前完成 D1+R2 备份，检查依赖与 Cloudflare release notes。顺序固定为：新 migrations → 应用部署 → 冒烟。v5 必须先应用 `0006_content_v5.sql`，再开放单元格富文本和小号文本入口。已发布 migration 不得改写；Worker 回滚不等于 schema 回滚。
