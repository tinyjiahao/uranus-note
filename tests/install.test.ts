import { describe, expect, it, vi } from "vitest";
import { InstallController, type InstallPromptEvent } from "../src/state/install";

function setup() {
  const controller = new InstallController();
  const target = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: false }) as unknown as MediaQueryList;
  const stop = controller.start(target, media);
  function dispatch(outcome: "accepted" | "dismissed" = "dismissed", fail = false) {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(async () => { if (fail) throw new Error("unavailable"); }),
      userChoice: Promise.resolve({ outcome }),
    }) as InstallPromptEvent;
    target.dispatchEvent(event);
    return event;
  }
  return { controller, target, media, stop, dispatch };
}
describe("ephemeral installation lifecycle", () => {
  it("does not auto prompt; cancellation consumes exactly once", async () => {
    const { controller, dispatch, stop } = setup();
    expect(controller.getSnapshot().available).toBe(false);
    const event = dispatch();
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompt).not.toHaveBeenCalled();
    await Promise.all([controller.prompt(), controller.prompt()]);
    await controller.prompt();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ available: false, prompting: false });
    expect(controller.getSnapshot().message).toContain("取消");
    stop();
  });
  it("acceptance is not completion; appinstalled wins even during a pending prompt", async () => {
    const { controller, target, dispatch, stop } = setup();
    dispatch("accepted"); await controller.prompt();
    expect(controller.getSnapshot().message).toContain("等待浏览器");
    dispatch("accepted"); const pending = controller.prompt();
    target.dispatchEvent(new Event("appinstalled")); await pending;
    expect(controller.getSnapshot().message).toContain("报告安装完成");
    expect(controller.getSnapshot().standalone).toBe(false);
    stop();
  });
  it("recovers from failure and detects standalone mode changes", async () => {
    const { controller, media, dispatch, stop } = setup();
    dispatch("dismissed", true); await controller.prompt();
    expect(controller.getSnapshot().message).toContain("手工安装");
    Object.assign(media, { matches: true }); media.dispatchEvent(new Event("change"));
    const event = dispatch(); await controller.prompt();
    expect(event.prompt).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ standalone: true, available: false, prompting: false });
    stop();
  });
  it("cleans up listeners across restarts, subscriptions and in-flight requests", async () => {
    const { controller, target, media, dispatch, stop } = setup();
    const listener = vi.fn(); const unsubscribe = controller.subscribe(listener);
    dispatch(); const pending = controller.prompt(); stop(); await pending;
    expect(controller.getSnapshot().message).not.toContain("取消");
    const event = dispatch(); expect(event.defaultPrevented).toBe(false);
    const stopAgain = controller.start(target, media); stop();
    dispatch(); expect(controller.getSnapshot().available).toBe(true);
    unsubscribe(); listener.mockClear(); stopAgain();
    expect(listener).not.toHaveBeenCalled();
    expect(dispatch().defaultPrevented).toBe(false);
  });
});
