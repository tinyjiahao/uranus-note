# Uranus Notes

Uranus 是一个面向单用户自部署的 Cloudflare 原生笔记应用。React SPA、Hono API、D1 数据库和私有 R2 附件通过同一个 Worker 部署；浏览器不会直接接触 Cloudflare 资源凭据。

> 当前版本：`0.2.0-preview.1`。v2 核心编辑体验已在本地实现，详情见 [v2 实现与验收](doc/implementation-v2.md)。网页令牌轮换未交付；尚未完成 staging 与生产发布验收。原 v1 未完成范围见 [实现状态](doc/implementation-status.md)。

## 已实现

- 应用令牌登录、HttpOnly 签名会话、令牌轮换失效、Origin/CSRF 校验和登录限流 binding。
- 三栏、双栏和专注视图，深浅主题，文件夹/全部/星标/回收站列表，稳定排序和字面子串搜索。
- TipTap 富文本、标题、列表、待办、引用、代码、高亮、链接、基础表格、只读模式和 Markdown 导入。
- 800ms 串行自动保存、整数 revision 乐观锁、UUIDv7 幂等操作和 IndexedDB 未提交草稿。
- PNG/JPEG/WebP/GIF 私有 R2 附件、魔数检查、正文/历史版本引用和 24 小时无引用回收。
- 自动/手动版本快照、只读预览和原子恢复。
- 软删除、恢复、分批硬删除队列、30 天定时发现、持久租约和失败退避。
- 持久维护模式、逻辑记录与附件字节备份、空目标分批幂等恢复及校验和验证。
- Workerd 中的 D1/R2 集成测试和 Chrome 浏览器主流程测试。

## 本地开发

要求 Node.js 24。实际开发版本记录在 `.nvmrc`。

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
```

将 `wrangler.jsonc` 中 D1/R2 改为本地配置，并在 `.dev.vars` 中填入两个不同的、至少 32 字节的随机值：

```text
API_TOKEN="..."
SESSION_SECRET="..."
```

不要使用 Cloudflare API Token 作为应用令牌。可用 `openssl rand -base64 48` 分别生成两个值。

```bash
npm run cf:typegen
npm run db:migrate:local
npm run dev
```

开发服务默认由 Vite 输出实际 URL。`.wrangler/` 保存本地 D1/R2 状态；`dev`、`preview` 和本地迁移使用同一配置。若要精确清空本项目的本地模拟数据，请先停止开发服务，再移走项目目录下的 `.wrangler/`；不要对主目录或其他项目执行递归删除。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run preview
npm run test:e2e
```

`preview` 使用 Cloudflare Vite Plugin 在 Workers Runtime 中运行构建后的 Worker 和 bindings，不是普通静态文件服务器。浏览器测试优先使用系统 Chrome；当前配置适配了 Playwright 不再提供旧 macOS Chromium 构建的环境。

浏览器测试从未提交的 `.dev.vars` 读取 `API_TOKEN`，也可通过环境变量 `URANUS_TEST_API_TOKEN` 提供测试目标的应用令牌。不要将真实令牌写入测试源码。`.dev.vars*`（示例除外）、`.env*`（示例除外）、真实 Wrangler 配置、本地数据库、备份和测试截图/trace 均不提交。

## 部署

部署前阅读 [部署指南](doc/deployment.md)，创建独立的 D1、私有 R2 和 Rate Limiting binding，执行远端 migrations，再设置 Secrets 和发布。生产配置不得提交到仓库。

```bash
npm run db:migrate:remote
npx wrangler secret put API_TOKEN
npx wrangler secret put SESSION_SECRET
npm run deploy
```

API 摘要见 [API 文档](doc/api.md)，备份与恢复见 [运维指南](doc/backup-restore.md)。完整产品与验收基线始终是 [doc/plan_v1.md](doc/plan_v1.md)。

## 隐私与安全

Uranus 不包含遥测、广告或第三方脚本。笔记正文和附件以明文存放在部署者控制的 D1/R2 与运维备份中；客户端“只读”只是防误触偏好，不是权限边界。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT](LICENSE)
