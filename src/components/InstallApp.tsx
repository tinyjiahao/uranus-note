import { useRef, useSyncExternalStore } from "react";
import { installController } from "../state/install";

export function InstallApp() {
  const state = useSyncExternalStore(installController.subscribe, installController.getSnapshot);
  const focusTarget = useRef<HTMLHeadingElement>(null);
  return <section aria-labelledby="install-heading">
    <h4 id="install-heading" tabIndex={-1} ref={focusTarget}>安装应用</h4>
    {state.standalone ? <p role="status">当前以独立窗口运行</p> : <>
      {(state.available || state.prompting) && <button disabled={state.prompting} onClick={async () => {
        await installController.prompt();
        // The consumed prompt removes its button; restore focus inside the dialog.
        focusTarget.current?.focus();
      }}>{state.prompting ? "等待浏览器安装提示…" : "安装 Uranus"}</button>}
      <p role="status" aria-live="polite">{state.message}</p>
      <details open={!state.available && !state.prompting}><summary>如何安装</summary>
        <ol>
          <li>使用支持网页应用安装的 Chrome 打开当前部署地址。</li>
          <li>右上角菜单 → 投放、保存和分享 → 将网页安装为应用（名称以浏览器版本为准）。</li>
          <li>安装后打开 Uranus 独立窗口。</li>
          <li>在 Dock 中右键 Uranus 图标 → 选项 → 在程序坞中保留。</li>
        </ol>
        <p>固定 Dock 需要你手工操作，网页无法自动保证。没有安装菜单时，请检查 Chrome 版本或设备管理限制，也可继续使用网页版。</p>
      </details>
    </>}
    <p>应用仍需联网，不提供离线启动或离线附件缓存。关闭窗口前请确认已保存到服务器；会话过期后仍须重新登录。</p>
  </section>;
}
