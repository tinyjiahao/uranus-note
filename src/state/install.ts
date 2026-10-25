export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
export type InstallSnapshot = Readonly<{
  available: boolean; prompting: boolean; standalone: boolean; message: string;
}>;

// Browser events are ephemeral, never persisted as an "installed" preference.
export class InstallController {
  private event: InstallPromptEvent | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private detach: (() => void) | undefined;
  private state: InstallSnapshot = { available: false, prompting: false, standalone: false, message: "" };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(values: Partial<InstallSnapshot>) {
    this.state = { ...this.state, ...values };
    this.listeners.forEach(listener => listener());
  }
  start(target: EventTarget, media: MediaQueryList) {
    this.detach?.();
    this.update({ standalone: media.matches });
    const before = (event: Event) => {
      if (typeof (event as InstallPromptEvent).prompt !== "function") return;
      event.preventDefault();
      if (this.state.prompting || this.state.standalone) return;
      this.event = event as InstallPromptEvent;
      this.update({ available: true, message: "" });
    };
    const installed = () => {
      this.generation++;
      this.event = null;
      this.update({ available: false, prompting: false, message: "浏览器已报告安装完成，可打开 Uranus 独立窗口。" });
    };
    const mode = () => {
      if (media.matches) { this.generation++; this.event = null; }
      this.update({ standalone: media.matches, ...(media.matches ? { available: false, prompting: false } : {}) });
    };
    target.addEventListener("beforeinstallprompt", before);
    target.addEventListener("appinstalled", installed);
    media.addEventListener("change", mode);
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      target.removeEventListener("beforeinstallprompt", before);
      target.removeEventListener("appinstalled", installed);
      media.removeEventListener("change", mode);
      this.generation++;
      this.event = null;
      this.update({ available: false, prompting: false });
      if (this.detach === cleanup) this.detach = undefined;
    };
    this.detach = cleanup;
    return cleanup;
  }
  prompt = async () => {
    const event = this.event;
    if (!event || this.state.prompting || this.state.standalone) return;
    this.event = null;
    const generation = ++this.generation;
    this.update({ available: false, prompting: true, message: "请在浏览器安装提示中选择。" });
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (generation === this.generation) this.update({ message: choice.outcome === "accepted"
        ? "已接受安装提示，请等待浏览器完成安装。" : "已取消安装，仍可继续使用网页版。" });
    } catch {
      if (generation === this.generation) this.update({ message: "无法打开安装提示，请按下方指引手工安装。" });
    } finally {
      if (generation === this.generation) this.update({ prompting: false });
    }
  };
}
export const installController = new InstallController();
