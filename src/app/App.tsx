import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { getSession, login, register, switchAccount, type Session } from "../api/client";
import { AccountSwitcher } from "../components/AccountSwitcher";
import { loginSchema, registrationSchema } from "../../shared/account";
import { lockIdentity, identityTabId } from "../state/identity";
import { Workspace } from "./Workspace";
import { installSessionActivity } from "../state/sessionActivity";

function LoginPage({ registrationEnabled = false }: { registrationEnabled?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = creating ? registrationSchema.safeParse({ email, username, password, confirmPassword }) : loginSchema.safeParse({ email, password });
      if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map(issue => [String(issue.path[0]), issue.message]))); return; }
      setErrors({});
      if (creating) { await register(parsed.data); setCreating(false); setNotice("注册成功，请登录"); }
      else { await login(email, password); await queryClient.invalidateQueries({ queryKey: ["session"] }); navigate("/"); }
      setPassword(""); setConfirmPassword("");
    },
  });
  return <main className="login-shell">
    <form className="login-card" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <img src="/icon.svg" alt="" width="56" height="56" />
      <h1>Uranus Notes</h1>
      <p>{creating ? "创建个人笔记空间" : "使用邮箱和密码登录"}</p>
      <label htmlFor="email">邮箱</label><input id="email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required autoFocus />
      {errors.email && <small role="alert">{errors.email}</small>}
      {creating && <><label htmlFor="username">用户名</label><input id="username" autoComplete="nickname" value={username} onChange={event => setUsername(event.target.value)} required />{errors.username && <small role="alert">{errors.username}</small>}</>}
      <label htmlFor="password">密码</label><input id="password" type={visible ? "text" : "password"} autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} required />
      {errors.password && <small role="alert">{errors.password}</small>}
      {creating && <><label htmlFor="confirm-password">确认密码</label><input id="confirm-password" type={visible ? "text" : "password"} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required />{errors.confirmPassword && <small role="alert">{errors.confirmPassword}</small>}</>}
      <label className="login-password-visibility"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />显示密码</label>
      {notice && <p role="status">{notice}</p>}
      {mutation.error && <div className="error-banner" role="alert">{mutation.error.message}</div>}
      <button className="primary" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "正在处理…" : creating ? "注册" : "登录"}</button>
      {!creating && <button type="button" onClick={event => setAccountAnchor(event.currentTarget)}>切换已登录账号</button>}
      {registrationEnabled && <button type="button" onClick={() => { setCreating(!creating); setPassword(""); setConfirmPassword(""); setErrors({}); mutation.reset(); }}>{creating ? "返回登录" : "注册账号"}</button>}
    </form>
    {accountAnchor && <AccountSwitcher anchor={accountAnchor} close={() => setAccountAnchor(null)} change={async target => {
      if ("userId" in target) await switchAccount(target.userId, target.switchToken);
      else await login(target.email, target.password);
      const session = await getSession(); queryClient.clear(); queryClient.setQueryData(["session"], session); navigate("/", { replace: true });
    }} />}
  </main>;
}

function ProtectedWorkspace() {
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, retry: false });
  const location = useLocation();
  if (session.isLoading) return <div className="center-message">正在连接私人笔记空间…</div>;
  if (!session.data?.authenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <Workspace key={session.data.user.id} user={session.data.user} defaultDataOwner={session.data.defaultDataOwner === true} />;
}

export function App() {
  useEffect(installSessionActivity, []);
  const client = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const expired = () => { void client.cancelQueries(); client.clear(); client.setQueryData<Session>(["session"], { authenticated: false }); navigate("/login", { replace: true }); };
    window.addEventListener("uranus-session-expired", expired);
    const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("uranus-account-change");
    if (channel) channel.onmessage = event => { if (event.data?.sender !== identityTabId) lockIdentity(); };
    return () => { window.removeEventListener("uranus-session-expired", expired); channel?.close(); };
  }, [client, navigate]);
  return <Routes>
    <Route path="/login" element={<LoginGate />} />
    <Route path="/" element={<ProtectedWorkspace />} />
    <Route path="/notes/:id" element={<ProtectedWorkspace />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}

function LoginGate() {
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, retry: false });
  const params = useParams();
  useEffect(() => { void params; }, [params]);
  if (session.isLoading) return <div className="center-message">正在检查会话…</div>;
  if (session.error) return <div className="center-message" role="alert">{session.error.message}<button onClick={() => void session.refetch()}>重试</button></div>;
  return session.data?.authenticated ? <Navigate to="/" replace /> : <LoginPage registrationEnabled={session.data?.registrationEnabled === true} />;
}
