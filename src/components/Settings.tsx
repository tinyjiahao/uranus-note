import { useEffect, useRef, useState } from "react";
import { Popup, closePopups } from "./Popup";
import { useQuery } from "@tanstack/react-query";
import { useUiStore, parseEditorFontSize } from "../state/ui";
import { InstallApp } from "./InstallApp";

export function SortControls() {
  const { sort, setSort } = useUiStore();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const names = { updated_at: "更新时间", created_at: "创建时间", title: "标题" };
  return <div className="sort-controls"><button aria-label="笔记排序" aria-haspopup="dialog" aria-expanded={!!anchor} onClick={event => setAnchor(anchor ? null : event.currentTarget)}>{names[sort.by]} {sort.dir === "desc" ? "↓" : "↑"}</button>
    {anchor && <Popup anchor={anchor} title="笔记排序" close={() => setAnchor(null)}>
      <p>排序字段</p>{(["updated_at", "created_at", "title"] as const).map(by => <button key={by} aria-pressed={sort.by === by} onClick={() => setSort({ ...sort, by })}>{names[by]}</button>)}
      <hr /><p>排序方向</p>{(["desc", "asc"] as const).map(dir => <button key={dir} aria-pressed={sort.dir === dir} onClick={() => setSort({ ...sort, dir })}>{sort.by === "title" ? dir === "desc" ? "标题降序" : "标题升序" : dir === "desc" ? "最新在前" : "最早在前"}</button>)}
    </Popup>}
  </div>;
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
    closePopups();
    const trigger = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (trigger?.isConnected) trigger.focus(); else document.querySelector<HTMLButtonElement>('.settings-launcher')?.focus(); };
  }, []);
  return <dialog className="settings-drawer" ref={dialog} aria-labelledby="settings-title" onCancel={onClose}>
    <header><h2 id="settings-title">设置</h2><button aria-label="关闭设置" onClick={onClose}>关闭</button></header>
    <section><h3>编辑与外观</h3><p>仅此浏览器生效</p>
      {ui.storageWarning && <p role="status">无法记忆偏好，本次会话仍可使用。</p>}
      <label>编辑器字号 <select aria-label="编辑器字号" value={ui.editorFontSize} onChange={e => ui.setEditorFontSize(parseEditorFontSize(e.target.value))}><option value="14">小 · 14px（默认）</option><option value="16">标准 · 16px</option><option value="18">大 · 18px</option><option value="20">特大 · 20px</option></select></label>
      <p>字号仅调整正文、表格及历史预览的显示，不修改笔记内容。</p>
      <label>编辑宽度 <select aria-label="编辑宽度" value={ui.widthMode} onChange={e => ui.setWidthMode(e.target.value as "fluid" | "reading")}><option value="fluid">自适应宽版</option><option value="reading">舒适阅读</option></select></label>
      <label>主题 <select aria-label="主题" value={ui.theme} onChange={e => ui.setTheme(e.target.value as typeof ui.theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>布局 <select aria-label="布局" value={ui.layout} onChange={e => ui.setLayout(e.target.value as typeof ui.layout)}><option value="three">三栏</option><option value="two">双栏</option><option value="focus">专注</option></select></label>
      <SortControls />
      <button onClick={() => { if (confirm("恢复布局、主题、宽度、字号和排序的默认偏好？笔记和草稿将保留。")) ui.reset(); }}>恢复默认偏好</button>
    </section>
    <details><summary>安全</summary><p>网页登录令牌由部署端管理。网页直接换令牌尚未交付。</p><p>部署者可通过 Cloudflare Workers → 设置 → 变量和机密更换 API_TOKEN。它是本应用登录凭据，不是 Cloudflare 管理令牌。</p><p>SESSION_SECRET 用于签名会话。任一密钥更换生效后，所有设备需要重新登录。</p></details>
    <details><summary>关于与部署</summary>{status.data ? <><p>Uranus {status.data.version}</p><p>配置：{status.data.configured ? "齐全" : "不完整"}</p><p>D1：{status.data.database}；附件：{status.data.attachments}</p></> : <p>{status.error ? "无法读取服务状态" : "正在检查服务状态…"}</p>}
      <InstallApp />
      <p>D1 / R2 bindings、APP_ORIGIN 和会话时长由部署配置管理。</p><a href="/deployment-guide.html" target="_blank" rel="noopener noreferrer">项目与部署指引</a>
      <p>剪切、复制、粘贴使用系统菜单或键盘快捷键。对象菜单可用 Shift+F10 打开，方向键导航，Escape 关闭。</p>
    </details>
  </dialog>;
}
