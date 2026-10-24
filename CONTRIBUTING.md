# Contributing

`doc/plan_v1.md` 是唯一有效的功能与验收基线。提交变更前先确认目标属于 v1、P2 还是非目标，不要把规划能力写成已实现。

1. 使用 Node 24 和 `npm ci` 安装锁定依赖。
2. 复制示例配置并只连接本地 D1/R2；不得提交 `.dev.vars`、真实资源 id、数据、附件或备份。
3. 已发布 migration 只追加，不改写。所有项目数据库对象以 `uranus_` 开头，R2 对象限定在 `uranus/attachments/`。
4. service/repository 显式接收 bindings，不依赖 Hono Context；共享代码不得导入服务端 Secrets。
5. 至少运行 `npm run typecheck && npm test && npm run build`。编辑器或关键流程变更还要运行 `npm run test:e2e`。
6. PR 说明完成内容、实际验证和未完成范围。数据、安全、上传、并发变更需要 Workerd 集成测试。

日志与错误中不得出现正文、标题、搜索词、Cookie、Authorization、附件内容或 Secrets。
