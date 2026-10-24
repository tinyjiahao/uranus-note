import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { getSession, login } from "../api/client";
import { Workspace } from "./Workspace";

function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const mutation = useMutation({
    mutationFn: () => login(token),
    onSuccess: async () => { setToken(""); await queryClient.invalidateQueries({ queryKey: ["session"] }); navigate("/"); },
  });
  return <main className="login-shell">
    <form className="login-card" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <img src="/icon.svg" alt="" width="56" height="56" />
      <h1>Uranus Notes</h1>
      <p>输入此部署实例的应用访问令牌。</p>
      <label htmlFor="token">访问令牌</label>
      <input id="token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} autoFocus />
      {mutation.error && <div className="error-banner" role="alert">{mutation.error.message}</div>}
      <button className="primary" type="submit" disabled={!token || mutation.isPending}>{mutation.isPending ? "正在验证…" : "登录"}</button>
      <small>令牌只用于本次 HTTPS 登录，不会写入浏览器存储。</small>
    </form>
  </main>;
}

function ProtectedWorkspace() {
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, retry: false });
  const location = useLocation();
  if (session.isLoading) return <div className="center-message">正在连接私人笔记空间…</div>;
  if (!session.data?.authenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Workspace />;
}

export function App() {
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
  return session.data?.authenticated ? <Navigate to="/" replace /> : <LoginPage />;
}
