// @vitest-environment jsdom
// Installing through the page (#167): the install's steps and the restart timer, on a stand-in page with React's props
// on its elements, as the game renders them. E2 drives the real page (packages/e2/test/effectors.e2.test.ts).
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NS } from "../../src/ns.ts";
import { openGamePage } from "../../src/page/game-page.ts";
import { armRestartAfterInstall, installOnPage, RESTART_STEP_LIMITS_MS } from "../../src/page/install-page.ts";

const BOOT = "agent/boot.js";
const STARTED: string = "Running script with 1 thread, pid 1 and args: [].";
const clicks: string[] = [];
const withProps = <T extends Element>(element: T, props: Record<string, unknown>): T =>
  Object.assign(element, { __reactProps$test: props });
const element = (tag: string, fields: Record<string, unknown> = {}) =>
  Object.assign(document.createElement(tag), fields);

/** The install's alert, as the AlertManager renders it: a dialog whose paper holds its X, then its text. */
function installAlert(): Element {
  const dialog = element("div", { className: "MuiModal-root" });
  const paper = element("div");
  paper.append(
    withProps(element("button"), {
      onClick: () => {
        clicks.push("the alert's X");
        dialog.remove();
      },
    }),
    element("span", { textContent: "You slowly drift to sleep as scientists put you under … Neurotrainer I" }),
  );
  dialog.append(paper);
  document.body.append(dialog);
  return dialog;
}

/**
 * The Terminal: its output and its controlled input. Typing sets the line, and the input renders it a moment later
 * with new handlers; Enter runs the line its last render saw: the echo, then what `answer` prints for it.
 */
function terminal({ answer = (_line: string) => STARTED, typed = "", enterDoesNothing = false } = {}) {
  const output = element("ul", { id: "terminal" });
  output.append(element("li", { textContent: "Bitburner v3.0.1 (1da7316)" }));
  const input = element("input", { id: "terminal-input", value: typed }) as unknown as HTMLInputElement;
  const ran: string[] = [];
  const render = (line: string) => {
    input.value = line;
    withProps(input, {
      onChange: (event: { target: { value: string } }) => setTimeout(() => render(event.target.value), 10),
      onKeyDown: (event: { key: string }) => {
        if (event.key !== "Enter" || enterDoesNothing) return;
        ran.push(line);
        output.append(element("li", { textContent: `[home /]> ${line}` }));
        if (line !== "") output.append(element("li", { textContent: answer(line) }));
        render("");
      },
    });
  };
  render(typed);
  document.body.append(output, input);
  return { input, ran };
}

/** The sidebar's Options, which opens the Options page with its "Force kill all active scripts". */
function optionsInSidebar({ withForceKill = true } = {}) {
  const options = withProps(element("div"), {
    onClick: () => {
      clicks.push("Options");
      if (!withForceKill) return;
      document.body.append(
        withProps(element("button", { textContent: "Force kill all active scripts" }), {
          onClick: () => clicks.push("Force kill all active scripts"),
        }),
      );
    },
  });
  options.setAttribute("role", "button");
  options.append(element("p", { textContent: "Options" }));
  document.body.append(options);
}

afterEach(() => {
  vi.useRealTimers();
  clicks.length = 0;
  document.body.replaceChildren();
  (window as { onbeforeunload: unknown }).onbeforeunload = null;
});

describe("the restart timer", () => {
  test("after the install: the alert closed, `run agent/boot.js` typed and run, its line read: started", async () => {
    vi.useFakeTimers();
    optionsInSidebar();
    const restart = armRestartAfterInstall(document, BOOT);
    // The install happens as the worker clicks: the alert shows, and the Terminal comes back.
    installAlert();
    const { ran } = terminal();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restart.state()).toEqual({ outcome: "started", fallbackReason: null });
    expect(ran).toEqual(["run agent/boot.js"]);
    expect(clicks).toEqual(["the alert's X"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ran).toHaveLength(1);
  });

  test("the run refused (the terminal says why): Options, then Force kill, the unload prompt cleared", async () => {
    vi.useFakeTimers();
    optionsInSidebar();
    (window as { onbeforeunload: unknown }).onbeforeunload = () => "Your work will be lost.";
    const restart = armRestartAfterInstall(document, BOOT);
    installAlert();
    terminal({ answer: () => "Script agent/boot.js does not exist on home." });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restart.state()).toEqual({
      outcome: "reloading",
      fallbackReason: "the terminal said: Script agent/boot.js does not exist on home.",
    });
    expect(clicks).toEqual(["the alert's X", "Options", "Force kill all active scripts"]);
    expect((window as { onbeforeunload: unknown }).onbeforeunload).toBeNull();
  });

  test("a line the owner typed is never typed over: the fallback once the terminal's time is up", async () => {
    vi.useFakeTimers();
    optionsInSidebar();
    const restart = armRestartAfterInstall(document, BOOT);
    installAlert();
    const { input, ran } = terminal({ typed: "ls" });
    await vi.advanceTimersByTimeAsync(RESTART_STEP_LIMITS_MS.terminal - 500);
    expect(restart.state().outcome).toBe("waiting");
    expect(input.value).toBe("ls");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restart.state()).toEqual({ outcome: "reloading", fallbackReason: "the terminal didn't take the line" });
    expect(ran).toEqual([]);
  });

  test("the run never confirmed: the fallback once its time is up", async () => {
    vi.useFakeTimers();
    optionsInSidebar();
    const restart = armRestartAfterInstall(document, BOOT);
    installAlert();
    terminal({ enterDoesNothing: true });
    await vi.advanceTimersByTimeAsync(RESTART_STEP_LIMITS_MS.started + 2_000);
    expect(restart.state()).toEqual({ outcome: "reloading", fallbackReason: "the terminal didn't say it ran" });
  });

  test("no install's alert in time: nothing was installed, so it stops, touching nothing", async () => {
    vi.useFakeTimers();
    optionsInSidebar();
    terminal();
    const restart = armRestartAfterInstall(document, BOOT);
    await vi.advanceTimersByTimeAsync(RESTART_STEP_LIMITS_MS.install + 500);
    expect(restart.state().outcome).toBe("noInstall");
    installAlert();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clicks).toEqual([]);
  });

  test("disarmed (the worker is alive after its click): it stops", async () => {
    vi.useFakeTimers();
    const restart = armRestartAfterInstall(document, BOOT);
    restart.disarm();
    installAlert();
    terminal();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(restart.state().outcome).toBe("disarmed");
    expect(clicks).toEqual([]);
  });

  test("no Force kill to be found: it gives up once the fallback's time is up", async () => {
    vi.useFakeTimers();
    optionsInSidebar({ withForceKill: false });
    const restart = armRestartAfterInstall(document, BOOT);
    installAlert();
    terminal({ answer: () => "Failed to start script" });
    await vi.advanceTimersByTimeAsync(RESTART_STEP_LIMITS_MS.fallback + 2_000);
    expect(restart.state()).toEqual({ outcome: "gaveUp", fallbackReason: "the terminal said: Failed to start script" });
    expect(clicks).toEqual(["the alert's X", "Options"]);
  });
});

describe("the install's steps", () => {
  /** A worker's `ns`: its waits, which throw once the install has killed it, as the game's do. */
  function workerNs() {
    const state = { dead: false };
    const ns = {
      asleep: (ms: number) => {
        if (state.dead) throw new Error("ScriptDeath");
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    } as unknown as NS;
    return { ns, state };
  }

  /** A sidebar item, as the game renders one, recording its click and doing `then`. */
  function sidebarItem(name: string, then: () => void = () => {}) {
    const item = withProps(element("div"), {
      onClick: () => {
        clicks.push(name);
        then();
      },
    });
    item.setAttribute("role", "button");
    item.append(element("p", { textContent: name }));
    document.body.append(item);
  }

  /** The Augmentations page's Install, enabled or not, opening the confirmation unless `confirmation` is off. */
  function augmentationsPage({
    enabled,
    confirmation = true,
    onConfirm = () => {},
  }: {
    enabled: boolean;
    confirmation?: boolean;
    onConfirm?: () => void;
  }) {
    const install = withProps(element("button", { textContent: "Install Augmentations", disabled: !enabled }), {
      onClick: () => {
        clicks.push("Install Augmentations");
        if (!confirmation) return onConfirm();
        const dialog = element("div", { className: "MuiModal-root" });
        dialog.append(
          element("div", { textContent: "Installing will reset - money …" }),
          withProps(element("button", { textContent: "Confirm" }), {
            onClick: () => {
              clicks.push("Confirm");
              onConfirm();
            },
          }),
        );
        document.body.append(dialog);
      },
    });
    document.body.append(install);
  }

  test("nothing queued: Install disabled, so nothing to install, and nothing clicked", async () => {
    sidebarItem("Stats");
    sidebarItem("Augmentations", () => augmentationsPage({ enabled: false }));
    const nothingToInstall = { seen: false };
    const gamePage = openGamePage(workerNs().ns, Date.now() + 1_000);
    if (!gamePage) throw new Error("no page");
    expect(await installOnPage(gamePage, BOOT, nothingToInstall)).toBeNull();
    expect(nothingToInstall.seen).toBe(true);
    expect(clicks).toEqual(["Augmentations"]);
  });

  test("never an augmentation: no Augmentations beside Stats is nothing to install; without Stats, a collapsed section", async () => {
    sidebarItem("Stats");
    const nothingToInstall = { seen: false };
    const gamePage = openGamePage(workerNs().ns, Date.now() + 700);
    if (!gamePage) throw new Error("no page");
    expect(await installOnPage(gamePage, BOOT, nothingToInstall)).toBeNull();
    expect(nothingToInstall.seen).toBe(true);
    document.body.replaceChildren();
    const collapsed = { seen: false };
    const again = openGamePage(workerNs().ns, Date.now() + 700);
    if (!again) throw new Error("no page");
    expect(await installOnPage(again, BOOT, collapsed)).toBe(
      'no "Augmentations" in the sidebar (is its section collapsed?)',
    );
    expect(collapsed.seen).toBe(false);
  });

  test("installed: the timer is armed before the click, the confirmation confirmed, and the worker dies with it", async () => {
    const { ns, state } = workerNs();
    sidebarItem("Stats");
    sidebarItem("Augmentations", () =>
      augmentationsPage({
        enabled: true,
        onConfirm: () => {
          state.dead = true;
          installAlert();
        },
      }),
    );
    terminal();
    const gamePage = openGamePage(ns, Date.now() + 1_500);
    if (!gamePage) throw new Error("no page");
    await expect(installOnPage(gamePage, BOOT, { seen: false })).rejects.toThrow("ScriptDeath");
    // The timer, armed before the click, takes over.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(clicks).toEqual(["Augmentations", "Install Augmentations", "Confirm", "the alert's X"]);
    expect([...document.querySelectorAll("#terminal > li")].map((line) => line.textContent)).toContain(STARTED);
  });

  test("with the confirmation turned off, Install itself installs: the timer was armed before it", async () => {
    const { ns, state } = workerNs();
    sidebarItem("Stats");
    sidebarItem("Augmentations", () =>
      augmentationsPage({
        enabled: true,
        confirmation: false,
        onConfirm: () => {
          state.dead = true;
          installAlert();
        },
      }),
    );
    terminal();
    const gamePage = openGamePage(ns, Date.now() + 1_500);
    if (!gamePage) throw new Error("no page");
    await expect(installOnPage(gamePage, BOOT, { seen: false })).rejects.toThrow("ScriptDeath");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(clicks).toEqual(["Augmentations", "Install Augmentations", "the alert's X"]);
  });

  test("alive after Confirm: nothing was installed, the timer is disarmed, and it says so", async () => {
    sidebarItem("Stats");
    sidebarItem("Augmentations", () => augmentationsPage({ enabled: true }));
    terminal();
    const gamePage = openGamePage(workerNs().ns, Date.now() + 1_500);
    if (!gamePage) throw new Error("no page");
    expect(await installOnPage(gamePage, BOOT, { seen: false })).toBe("the game didn't install after its confirmation");
    // An alert that shows now isn't the install's restart to make.
    installAlert();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(clicks).toEqual(["Augmentations", "Install Augmentations", "Confirm"]);
  });
});
