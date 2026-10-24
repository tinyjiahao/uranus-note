# 备份与恢复

备份包含明文笔记、版本和附件字节。请使用受保护目录、加密磁盘和最小文件权限；不要提交到 Git。

## 备份

令牌通过环境变量传入，不放命令行参数。工具登录后进入持久维护模式，等待可确认的在途操作排空，分页导出白名单记录并下载每个 ready 附件。

```bash
URANUS_ORIGIN=https://notes.example.com \
URANUS_API_TOKEN='应用令牌' \
npm run backup -- /secure/path/uranus-backup
```

输出包括 `records/*.jsonl`、`attachments/*.bin`、`manifest.json` 和完成标记 `COMPLETE`。manifest 记录格式/schema/migration 版本、计数、字节数、ETag 和 SHA-256。只有带 `COMPLETE` 且全部校验和通过的目录可用于恢复。

默认成功后仍保持 frozen。确认文件后，可在首次命令前设置 `URANUS_EXIT_MAINTENANCE=1` 自动明确退出；中断时使用工具输出的 maintenance id 设置 `URANUS_MAINTENANCE_ID` 重试。不要通过更换 id 绕过仍在进行的维护。

## 恢复

恢复只允许 migrations 已创建、但除系统默认文件夹外没有 Uranus 业务数据的目标。其他应用在共享 D1/R2 中的对象不会被清理。先配置全新的目标 bindings、Secrets 并执行：

```bash
npm run db:migrate:remote
URANUS_ORIGIN=https://new-notes.example.com \
URANUS_API_TOKEN='新目标的应用令牌' \
npm run restore -- /secure/path/uranus-backup
```

工具先验证本地清单和全部文件校验和，再进入 `restoring`。记录按依赖顺序分批导入；附件通过私有 API 写入 R2；批次 id 与校验和持久化，因此相同内容可安全重试，不同内容复用批次 id 会返回 409。搜索表从权威正文重建，不恢复会话、旧操作或运行中任务。

服务端完成引用、搜索行数和附件状态检查后转为 frozen。抽样打开至少 20 篇笔记（不足时全部），检查历史版本图片，并核对附件长度/校验和；确认后设置 `URANUS_EXIT_MAINTENANCE=1` 解除冻结。恢复失败时不要发布部分目标，保留 frozen 状态并用相同 maintenance id 重试。

共享 D1 的整库 Time Travel 会同时影响其他应用，不能作为 Uranus 单应用恢复方案。
