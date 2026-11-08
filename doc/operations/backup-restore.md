# v6 受控备份、恢复与初始化

本地工具强制 remoteBindings:false；远程工具 `scripts/remote-operations.mjs` 显式使用 Cloudflare 受控临时预览和真实 bindings。不使用应用令牌或普通账号 Cookie，不部署公网维护路由。远程切换步骤见 deployment.md，历史验证及当前发布记录见 implementation-v6.md。

## 本地备份与初始化

先停止开发/预览服务，确认已同步草稿。工具进入 draining，存在 pending 操作、running 任务、pending/deleting 附件时拒绝继续；处理在途任务后重试，不擅自删除它们。

```bash
npm run db:migrate:local
npm run backup -- backups/local-before-v6
node scripts/local-operations.mjs initialize admin@example.com backups/local-before-v6
# 使用备份命令输出的维护 id，确认 v6 Worker 已就绪后解除冻结：
node scripts/local-operations.mjs resume <maintenance-id>
npm run dev
```

初始化密码只从未提交的 .dev.vars 中 ADMIN_INITIAL_PASSWORD 读取，不能放在命令行参数。重复初始化不会重置已有账号密码。默认 admin 不是超级管理员，所有未归属业务数据归该账号的稳定 id，正文和 revision 不改写。

备份将账号哈希、业务记录与 uranus/attachments/ 下附件逐文件 AES-256-GCM 加密，manifest 同样加密，COMPLETE 保存清单校验和。默认独立密钥位于 .wrangler/backup.key，权限 0600；可通过 URANUS_BACKUP_KEY_FILE 指向已有 32 字节密钥文件。必须单独妥善保存密钥，丢失将无法恢复，不能把密钥与备份一起公开。会话不导出。

## 空目标恢复演练

URANUS_LOCAL_STATE_DIR 指向本地模拟状态目录，不能指向其他应用或生产资源。

```bash
URANUS_LOCAL_STATE_DIR=.wrangler/restore-check node scripts/local-operations.mjs migrate
URANUS_LOCAL_STATE_DIR=.wrangler/restore-check npm run restore -- backups/local-before-v6
```

目标必须没有用户和业务数据；不要先初始化 admin。只清除空库 migration 生成的无归属默认 Notes，不触碰其他前缀表或对象。恢复前验证完整清单和所有密文校验和，逐批记录进度；同一备份在相同状态目录重跑可续传，其他备份不能接管。恢复完成核对计数和 Uranus 外键，保持 frozen，所有旧会话失效。账号备份保留稳定 user_id、默认账号标记与原密码哈希。

迁移前的 v5 备份没有用户：恢复后须先重新完成受控备份与初始化，不能直接开放访问。已有账号的 v6 备份恢复后使用原邮箱密码登录，不再创建第二个 admin。

## 当前验证范围

2026-10-27：本地历史数据的加密导出和隔离目录恢复通过，包含 673 篇笔记、641 个历史版本、134 个附件记录。账号加密往返、中断续传、密文篡改拒绝、非空目标拒绝、其他应用资源保留等 8 项演练通过。远程发布的实际执行结果另记于 implementation-v6.md；独立远程空目标恢复和真机人工验收不能由本地测试替代。
