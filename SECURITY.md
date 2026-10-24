# Security Policy

## Supported versions

项目尚处于 `0.x` 开发阶段，仅最新提交接受安全修复。

## Reporting

请不要公开披露尚未修复的漏洞。通过仓库维护者提供的私密安全报告渠道提交复现步骤、影响范围和建议修复；本仓库发布前必须在托管平台启用 Security Advisories 或公布专用安全邮箱。

报告中请使用测试数据，不要附带真实 API_TOKEN、SESSION_SECRET、Cookie、Cloudflare 凭据、笔记正文或附件。

## Deployment notes

- API_TOKEN 与 SESSION_SECRET 必须不同，且各自至少 32 个随机字节；只存 Worker Secrets 或未提交的本地 `.dev.vars`。
- 轮换 SESSION_SECRET 会使全部旧会话立即失效；轮换 API_TOKEN 也会因指纹变化使旧会话失效。不要在混用新旧 Secret 的渐进部署中期望会话继续有效。
- 无状态退出只能清除浏览器 Cookie，不能撤销已被复制的 Cookie；紧急撤销请轮换 Secret。
- 备份包含明文私人内容和附件，必须加密存储介质并限制文件权限。
- Cloudflare Access 可叠加使用，但不能替代应用鉴权、Origin 和 CSRF 校验。
