import { t, useLocale } from "../state/locale";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { changeEmail, changePassword, getAccount, renameAccount } from "../api/client";
import { changeEmailSchema, changePasswordSchema, changeUsernameSchema, type AccountIdentity } from "../../shared/account";

export function AccountSettings({ user, beforeSensitiveChange }: { user: AccountIdentity; beforeSensitiveChange: () => Promise<void> }) {
  useLocale();
  const client = useQueryClient();
  const account = useQuery({ queryKey: ["user", user.id, "account"], queryFn: getAccount });
  const [mode, setMode] = useState<"username" | "email" | "password">("username");
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async () => {
    const input = mode === "username" ? { username } : mode === "email" ? { email, currentPassword } : { currentPassword, password, confirmPassword };
    const parsed = (mode === "username" ? changeUsernameSchema : mode === "email" ? changeEmailSchema : changePasswordSchema).safeParse(input);
    if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map(issue => [String(issue.path[0]), issue.message]))); return; }
    setErrors({}); setBusy(true); setMessage("");
    try {
      if (mode === "username") { await renameAccount(username); await client.invalidateQueries({ queryKey: ["user", user.id, "account"] }); setMessage(t("用户名已更新")); }
      else {
        await beforeSensitiveChange();
        if (mode === "email") await changeEmail(input); else await changePassword(input);
        setCurrentPassword(""); setPassword(""); setConfirmPassword("");
        setMessage(t("已处理；如凭据发生变化，请重新登录"));
      }
    } catch (error) { setMessage(t((error as Error).message) + (mode === "username" ? "" : t("。若网络中断，请尝试使用新凭据登录确认。"))); }
    finally { setBusy(false); }
  };
  const fieldError = (name: string) => errors[name] && <small role="alert">{t(errors[name])}</small>;
  return <details className="account-settings"><summary>{t("账号与安全")}</summary>
    <p>{t("用户名：")}{account.data?.username ?? user.username}</p><p>{t("当前邮箱：")}{account.data?.email ?? user.email}</p>
    <p>{t("邮箱仅作为登录账号，暂未验证。暂不支持自助找回密码。")}</p>
    <div className="account-mode-switch" role="group" aria-label={t("账号修改项目")}>{(["username", "email", "password"] as const).map((value, i) => <button key={value} disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); setErrors({}); setMessage(""); setCurrentPassword(""); setPassword(""); setConfirmPassword(""); }}>{[t("修改用户名"), t("修改邮箱"), t("修改密码")][i]}</button>)}</div>
    <form className="account-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {mode === "username" ? <><label>{t("用户名")}<input value={username} autoComplete="nickname" onChange={e => setUsername(e.target.value)} required /></label>{fieldError("username")}</> : <>
        {mode === "email" && <><label>{t("新邮箱")}<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>{fieldError("email")}<p>{t("保存后需使用新邮箱重新登录，不会发送验证邮件。")}</p></>}
        <label>{t("当前密码")}<input type={visible ? "text" : "password"} autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required /></label>{fieldError("currentPassword")}
        {mode === "password" && <><label>{t("新密码")}<input type={visible ? "text" : "password"} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>{fieldError("password")}<label>{t("确认密码")}<input type={visible ? "text" : "password"} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required /></label>{fieldError("confirmPassword")}</>}
        <label className="account-password-visibility"><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} />{t("显示密码")}</label>
      </>}
      {message && <p role="status">{message}</p>}<button className="primary" type="submit" disabled={busy}>{busy ? t("正在保存…") : t("保存账号设置")}</button>
    </form>
  </details>;
}
