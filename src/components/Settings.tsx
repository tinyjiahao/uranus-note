import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUiStore } from "../state/ui";

export function SortControls() {
  const { sort, setSort } = useUiStore();
  return <div className="sort-controls"><label>排序 <select aria-label="排序字段" value={sort.by} onChange={e => setSort({ ...sort, by: e.target.value as typeof sort.by })}>
    <option value="updated_at">更新时间</option><option value="created_at">创建时间</option><option value="title">标题</option>
  </select></label><select aria-label="排序方向" value={sort.dir} onChange={e => setSort({ ...sort, dir: e.target.value as typeof sort.dir })}>
    <option value="desc">{sort.by === "title" ? "降序" : "最新在前"}</option><option value="asc">{sort.by === "title" ? "升序" : "最早在前"}</option>
  </select></div>;
}
export function Settings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ui = useUiStore();
  const status = useQuery({ queryKey: ["deployment-status"], queryFn: async () => {
    const response = await fetch("/api/settings/status");
    if (!response.ok) throw new Error("无法读取服务状态");
    return await response.json() as { version: string; configured: boolean; database: string; attachments: string };
  } });
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (trigger?.isConnected) trigger.focus(); else document.querySelector<HTMLButtonElement>('.settings-launcher')?.focus(); };
  }, []);
  return <dialog className="settings-drawer" ref={dialog} aria-labelledby="settings-title" onCancel={onClose}>
    <header><h2 id="settings-title">设置</h2><button aria-label="关闭设置" onClick={onClose}>关闭</button></header>
    <section><h3>编辑与外观</h3><p>仅此浏览器生效</p>
      {ui.storageWarning && <p role="status">无法记忆偏好，本次会话仍可使用。</p>}
      <label>编辑宽度 <select aria-label="编辑宽度" value={ui.widthMode} onChange={e => ui.setWidthMode(e.target.value as "fluid" | "reading")}><option value="fluid">自适应宽版</option><option value="reading">舒适阅读</option></select></label>
      <label>主题 <select aria-label="主题" value={ui.theme} onChange={e => ui.setTheme(e.target.value as typeof ui.theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>布局 <select aria-label="布局" value={ui.layout} onChange={e => ui.setLayout(e.target.value as typeof ui.layout)}><option value="three">三栏</option><option value="two">双栏</option><option value="focus">专注</option></select></label>
      <SortControls />
      <button onClick={() => { if (confirm("恢复布局、主题、宽度和排序的默认偏好？笔记和草稿将保留。")) ui.reset(); }}>恢复默认偏好</button>
    </section>
    <section><h3>安全</h3><p>网页登录令牌由部署端管理。网页直接换令牌尚未交付。</p><p>部署者可通过 Cloudflare Workers → 设置 → 变量和机密更换 API_TOKEN。它是本应用登录凭据，不是 Cloudflare 管理令牌。</p><p>SESSION_SECRET 用于签名会话。任一密钥更换生效后，所有设备需要重新登录。</p></section>
    <section><h3>关于与部署</h3>{status.data ? <><p>Uranus {status.data.version}</p><p>配置：{status.data.configured ? "齐全" : "不完整"}</p><p>D1：{status.data.database}；附件：{status.data.attachments}</p></> : <p>{status.error ? "无法读取服务状态" : "正在检查服务状态…"}</p>}
      <p>D1 / R2 bindings、APP_ORIGIN 和会话时长由部署配置管理。</p><a href="/deployment-guide.html" target="_blank" rel="noopener noreferrer">项目与部署指引</a>
    </section>
  </dialog>;
}
