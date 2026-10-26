# Uranus Notes

Uranus 是一个面向单用户自部署的 Cloudflare 原生笔记应用。React SPA、Hono API、D1 数据库和私有 R2 附件通过同一个 Worker 部署；浏览器不会直接接触 Cloudflare 资源凭据。

> 当前版本：`0.2.0-preview.1`，已接入 v6 邮箱账号与用户独立笔记空间。实际部署、验证证据及剩余人工验收见 [v6 实施记录](doc/implementation-v6.md)；不以已实现代替全项验收。旧网页令牌轮换规划已由邮箱账号方案替代。

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

## 安装为独立窗口（v4）

部署本版后，在“设置 → 关于与部署 → 安装应用”中安装 Uranus；若浏览器没有提供安装提示，则按“如何安装”中的 Chrome 菜单指引操作。

macOS 上安装后打开应用，在 Dock 中右键 Uranus 图标 → 选项 → 在程序坞中保留。之后可从 Dock 启动独立窗口，不必与其他网站标签页混用。固定图标由用户操作，网页不能自动保证。

应用仍需联网；没有 Service Worker、离线启动、资源预缓存或后台同步。现有会话规则与草稿机制不变，关闭窗口前请确认服务端保存成功；会话过期仍须重新登录。独立窗口中不重复提供安装按钮。

清单与图标使用同源路径，适用于现有根路径自部署。安装名称/图标的刷新由浏览器控制。开发者如修改品牌 SVG，可在安装了 Chrome 的环境运行 `node scripts/generate-install-icons.mjs` 重新生成 PNG 图标；生成的图标需随源码提交。实际 macOS Chrome 安装与 Dock 验收状态见 [v4 实现记录](doc/implementation-v4.md)。

## 本地开发

要求 Node.js 24。实际开发版本记录在 `.nvmrc`。

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
```

将 `wrangler.jsonc` 中 D1/R2 改为本地配置，SESSION_SECRET 至少 32 字节随机值；初始化密码由部署者自行设置（8–128 个 Unicode 码点）：

```text
ADMIN_INITIAL_PASSWORD="..."
SESSION_SECRET="..."
```

用 `openssl rand -base64 48` 生成会话密钥。v6 不再使用应用 API_TOKEN。

```bash
npm run cf:typegen
npm run db:migrate:local
npm run backup -- backups/initial-local
node scripts/local-operations.mjs initialize admin@example.com backups/initial-local
node scripts/local-operations.mjs resume <备份输出的维护-id>
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

浏览器测试使用 URANUS_TEST_EMAIL / URANUS_TEST_PASSWORD；本地可从未提交的 .dev.vars 读取 ADMIN_INITIAL_PASSWORD。凭据、真实配置、数据库、备份及测试产物均不提交。

## 部署

部署前阅读 [部署指南](doc/deployment.md)，配置 D1、私有 R2 和 Rate Limiting binding。升级既有实例须先受控冻结、加密备份并验证恢复，再追加 migrations、初始化归属和切换新 Worker；不能直接覆盖旧鉴权。生产配置不得提交到仓库。

```bash
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET
npm run deploy
```

API 摘要见 [API 文档](doc/api.md)，备份与恢复见 [运维指南](doc/backup-restore.md)。完整产品与验收基线始终是 [doc/plan_v1.md](doc/plan_v1.md)。

## 隐私与安全

Uranus 不包含遥测、广告或第三方脚本。笔记正文和附件以明文存放在部署者控制的 D1/R2 中；v6 本地运维备份采用独立密钥加密；客户端“只读”只是防误触偏好，不是权限边界。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT](LICENSE)
