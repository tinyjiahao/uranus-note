# Security Policy

## Supported versions

项目尚处于 `0.x` 开发阶段，仅最新提交接受安全修复。

## Reporting

请不要公开披露尚未修复的漏洞。通过仓库维护者提供的私密安全报告渠道提交复现步骤、影响范围和建议修复；本仓库发布前必须在托管平台启用 Security Advisories 或公布专用安全邮箱。

报告中请使用测试数据，不要附带真实密码、SESSION_SECRET、Cookie、Cloudflare 凭据、笔记正文或附件。

## Deployment notes

- SESSION_SECRET 至少 32 随机字节；密码使用 PBKDF2-SHA256、随机盐与逐条成本记录，用户指定 10,000 次迭代，离线猜密强度低于 600,000 次建议。
- 轮换 SESSION_SECRET 使全部旧会话失效；修改邮箱/密码原子递增凭据版本并撤销全部会话。
- 退出在服务端撤销当前会话，写入提交时再次验证会话。退出失败锁定界面，不宣称已撤销。
- 备份包含敏感密码哈希与私人内容，AES-256-GCM 加密；密钥须独立保管。远程运维仅通过部署者控制的临时预览，不使用普通用户会话，也不得部署永久运维入口；实际验收范围见 doc/implementation-v6.md。
- Cloudflare Access 可叠加使用，但不能替代应用鉴权、Origin 和 CSRF 校验。
