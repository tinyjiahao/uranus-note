import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { closePopups, type PopupAnchor } from "./Popup";
import { forgetAccount, rememberedAccounts } from "../api/client";
import { loginSchema } from "../../shared/account";

export function AccountSwitcher({ anchor, close, change }: { anchor: PopupAnchor; close: () => void; change: (target: { userId: string; switchToken: string } | { email: string; password: string }) => Promise<void> }) {
  const accounts = useQuery({ queryKey: ["remembered-accounts"], queryFn: rememberedAccounts, retry: false });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    closePopups();
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      const trigger = anchor instanceof HTMLElement ? anchor : anchor.element;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [anchor]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="settings-drawer account-switcher" aria-labelledby="account-switcher-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header><h2 id="account-switcher-title">切换账号</h2><button type="button" aria-label="关闭切换账号" disabled={busy} onClick={close}>关闭</button></header>
    <section aria-labelledby="remembered-accounts-title">
    <h3 id="remembered-accounts-title">已登录账号 <span className="account-count">{accounts.data?.accounts.length ?? 0}/5</span></h3>
    <p className="account-switcher-hint">7 天内免密切换，切换不会延长有效期。</p>
    {accounts.isPending && <p role="status">正在读取账号…</p>}
    {accounts.error && <p role="alert">{accounts.error.message}<button onClick={() => void accounts.refetch()}>重试</button></p>}
    {accounts.data?.accounts.length === 0 && <p className="account-empty">暂无有效的已登录账号，请在下方登录。</p>}
    <div className="remembered-account-list">
    {accounts.data?.accounts.map(({ user, current, expiresAt }) => <div className={`remembered-account${current ? " is-current" : ""}`} key={user.id}>
      <button disabled={busy || current} onClick={() => void run(() => change({ userId: user.id, switchToken: accounts.data!.switchToken }))} aria-label={`切换到 ${user.email}`}>
        <strong>{user.username}{current && <span className="current-account-badge">当前账号</span>}</strong><span>{user.email}</span><small>有效至 {new Date(expiresAt).toLocaleString()}</small>
      </button>
      {!current && accounts.data?.accounts.some(account => account.current) && <button disabled={busy} aria-label={`移除 ${user.email}`} onClick={() => void run(async () => { await forgetAccount(user.id); await accounts.refetch(); })}>移除</button>}
    </div>)}
    </div>
    </section>
    <section aria-labelledby="add-account-title">
    <h3 id="add-account-title">登录其他账号</h3>
    <form className="account-form" onSubmit={event => {
      event.preventDefault();
      const parsed = loginSchema.safeParse({ email, password });
      if (!parsed.success) { setError("请填写有效邮箱和密码（8–128 个字符）"); return; }
      void run(() => change(parsed.data));
    }}>
      <label>邮箱<input type="email" autoComplete="username" placeholder="请输入邮箱" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label>
      <label>密码<input type={visible ? "text" : "password"} autoComplete="current-password" placeholder="请输入密码" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      <label className="account-password-visibility"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} disabled={busy} />显示密码</label>
      <button className="primary" type="submit" disabled={busy || !accounts.data || accounts.data.accounts.length >= accounts.data.limit}>{busy ? "正在处理…" : "登录并切换"}</button>
      {accounts.data && accounts.data.accounts.length >= accounts.data.limit && <p role="status">已达到 5 个账号上限，请先移除一个非当前账号。</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
    </form>
    </section>
    <p className="account-switcher-hint">仅在信任的设备上使用。“移除”不删除笔记；“退出”会退出本浏览器记住的所有账号。</p>
  </dialog>;
}
