import { t, useLocale } from "../state/locale";
import { AccountSettings } from "./AccountSettings";
import { deploymentStatus } from "../api/client";
import { useEffect, useRef, useState } from "react";
import { Popup, closePopups } from "./Popup";
import { useQuery } from "@tanstack/react-query";
import { useUiStore, parseEditorFontSize } from "../state/ui";
import { InstallApp } from "./InstallApp";
import { LanguagePicker } from "./LanguagePicker";

export function SortControls() {
  useLocale();
  const { sort, setSort } = useUiStore();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const names = { updated_at: t("更新时间"), created_at: t("创建时间"), title: t("标题") };
  return <div className="sort-controls"><button aria-label={t("笔记排序")} aria-haspopup="dialog" aria-expanded={!!anchor} onClick={event => setAnchor(anchor ? null : event.currentTarget)}>{names[sort.by]} {sort.dir === "desc" ? "↓" : "↑"}</button>
    {anchor && <Popup anchor={anchor} title={t("笔记排序")} close={() => setAnchor(null)}>
      <p>{t("排序字段")}</p>{(["updated_at", "created_at", "title"] as const).map(by => <button key={by} aria-pressed={sort.by === by} onClick={() => setSort({ ...sort, by })}>{names[by]}</button>)}
      <hr /><p>{t("排序方向")}</p>{(["desc", "asc"] as const).map(dir => <button key={dir} aria-pressed={sort.dir === dir} onClick={() => setSort({ ...sort, dir })}>{sort.by === "title" ? dir === "desc" ? t("标题降序") : t("标题升序") : dir === "desc" ? t("最新在前") : t("最早在前")}</button>)}
    </Popup>}
  </div>;
}
export function Settings({ onClose, user, beforeSensitiveChange }: { onClose: () => void; user: import("../../shared/account").AccountIdentity; beforeSensitiveChange: () => Promise<void> }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const ui = useUiStore();
  const [syncInput, setSyncInput] = useState(String(ui.syncIntervalSeconds));
  useEffect(() => setSyncInput(String(ui.syncIntervalSeconds)), [ui.syncIntervalSeconds]);
  const status = useQuery({ queryKey: ["user", user.id, "deployment-status"], queryFn: deploymentStatus });
  useEffect(() => {
    closePopups();
    const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { if (trigger?.isConnected) trigger.focus(); else document.querySelector<HTMLButtonElement>('.note-more, .workspace-more')?.focus(); };
  }, []);
  return <dialog className="settings-drawer" ref={dialog} aria-labelledby="settings-title" onCancel={onClose}>
    <header><h2 id="settings-title">{t("设置")}</h2><button aria-label={t("关闭设置")} onClick={onClose}>{t("关闭")}</button></header>
    <section><h3>{t("编辑与外观")}</h3><p>{t("仅此浏览器生效")}</p>
      <LanguagePicker />
      {ui.storageWarning && <p role="status">{t("无法记忆偏好，本次会话仍可使用。")}</p>}
      <label>{t("编辑器字号")} <select aria-label={t("编辑器字号")} value={ui.editorFontSize} onChange={e => ui.setEditorFontSize(parseEditorFontSize(e.target.value))}><option value="14">{t("小 · 14px（默认）")}</option><option value="16">{t("标准 · 16px")}</option><option value="18">{t("大 · 18px")}</option><option value="20">{t("特大 · 20px")}</option></select></label>
      <p>{t("字号仅调整正文、表格及历史预览的显示，不修改笔记内容。")}</p>
      <label>{t("编辑宽度")} <select aria-label={t("编辑宽度")} value={ui.widthMode} onChange={e => ui.setWidthMode(e.target.value as "fluid" | "reading")}><option value="fluid">{t("自适应宽版")}</option><option value="reading">{t("舒适阅读")}</option></select></label>
      <label>{t("主题")} <select aria-label={t("主题")} value={ui.theme} onChange={e => ui.setTheme(e.target.value as typeof ui.theme)}><option value="system">{t("跟随系统")}</option><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option></select></label>
      <label>{t("布局")} <select aria-label={t("布局")} value={ui.layout} onChange={e => ui.setLayout(e.target.value as typeof ui.layout)}><option value="three">{t("三栏")}</option><option value="two">{t("双栏")}</option><option value="focus">{t("专注")}</option></select></label>
      <SortControls />
      <label>{t("远程同步间隔（秒）")}<input aria-label={t("远程同步间隔（秒）")} type="number" min="5" max="300" step="1" value={syncInput} onChange={e => {
        setSyncInput(e.target.value);
        const value = Number(e.target.value);
        if (Number.isInteger(value) && value >= 5 && value <= 300) ui.setSyncIntervalSeconds(value);
      }} onBlur={() => setSyncInput(String(ui.syncIntervalSeconds))} /></label>
      <p>{t("默认 30 秒，可设为 5–300 秒。停止输入 0.8 秒后存入本机草稿，持续输入时最多每 3 秒存一次；有改动时按此间隔同步。切换笔记或按 ⌘/Ctrl+S 立即同步。未同步内容仅保存在此浏览器。")}</p>
      <button onClick={() => { if (confirm(t("恢复布局、主题、宽度、字号、排序和同步间隔的默认偏好？笔记和草稿将保留。"))) ui.reset(); }}>{t("恢复默认偏好")}</button>
    </section>
    <AccountSettings user={user} beforeSensitiveChange={beforeSensitiveChange} />
    <details><summary>{t("关于与部署")}</summary>{status.data ? <><p>Uranus {status.data.version}</p><p>{t("配置：")}{status.data.configured ? t("齐全") : t("不完整")}</p></> : <p>{status.error ? t("无法读取服务状态") : t("正在检查服务状态…")}</p>}
      <InstallApp />
      <p>{t("D1 / R2 bindings、APP_ORIGIN 和会话时长由部署配置管理。")}</p><a href="/deployment-guide.html" target="_blank" rel="noopener noreferrer">{t("项目与部署指引")}</a>
      <p>{t("剪切、复制、粘贴使用系统菜单或键盘快捷键。对象菜单可用 Shift+F10 打开，方向键导航，Escape 关闭。")}</p>
    </details>
  </dialog>;
}
