// What the browser page gives the game besides the Router (router.ts): the globals that index.tsx and the libraries
// set on `window`, and the UI that shows popups, toasts, the error popup and prompts. Headless there is no UI, so
// these are reported to the host as events instead, and prompts go to the host's rules.
// Bundled with the game (entry.ts); docs/sim/parity.md §3 and §4 list what it covers. Mirrors, at v3.0.1:
// index.tsx:15-16 and :60-70, AlertManager.tsx, Snackbar.tsx, ErrorModal.tsx (onClose) and PromptManager.tsx.
import _ from "lodash";
import React from "react";
import ReactDOM from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "../../../../../vendor/bitburner-src/src/ErrorHandling/ErrorState";
import { TTheme } from "../../../../../vendor/bitburner-src/src/Themes/ui/Theme";
import { AlertEvents } from "../../../../../vendor/bitburner-src/src/ui/React/AlertManager";
import { PromptEvent } from "../../../../../vendor/bitburner-src/src/ui/React/PromptManager";
import { SnackbarEvents } from "../../../../../vendor/bitburner-src/src/ui/React/Snackbar";
import type { GameEvent, PromptRequest } from "../../protocol.ts";
import { installAgentSimEffectors } from "./agent-effectors.ts";

/** The messages of index.tsx's `print`/`prompt` traps (test/page.test.ts checks them against the game's source). */
export const PRINT_TRAP = "You accidentally called window.print instead of ns.print";
export const PROMPT_TRAP = "You accidentally called window.prompt instead of ns.prompt";

/**
 * In a browser `globalThis` is `window`, so whatever the page puts on `window` is a global for player scripts too.
 * Headless they are two objects. These live on the global object, and `window` gets accessors for them, so either way
 * of reaching one sees the same value, before and after a script changes it:
 * - `sprintf`/`vsprintf`, which sprintf-js puts on `window` when it loads
 * - lodash's `_`, which lodash puts on the global object under webpack (its AMD branch)
 * - `React`/`ReactDOM`, and the `print`/`prompt` traps, from index.tsx
 */
export function installPageGlobals(): void {
  const win = window as unknown as Record<string, unknown>;
  if (typeof win.sprintf !== "function" || typeof win.vsprintf !== "function") {
    throw new Error("sprintf-js didn't put sprintf/vsprintf on window: load the engine after installDom");
  }
  const globals: Record<string, unknown> = {
    sprintf: win.sprintf,
    vsprintf: win.vsprintf,
    _,
    React,
    ReactDOM,
    print: () => {
      throw new Error(PRINT_TRAP);
    },
    prompt: () => {
      throw new Error(PROMPT_TRAP);
    },
  };
  // The Agent's `sim` effectors (#145): not the page's, but put where the page's globals are.
  installAgentSimEffectors();
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(globals)) {
    scope[name] = value;
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => scope[name],
      set: (next) => {
        scope[name] = next;
      },
    });
  }
}

/** Block elements end a line of text, as they would on screen. */
const LINE_ENDS = /<br\s*\/?>|<\/(?:p|div|li|h[1-6]|pre|tr)>/gi;

/**
 * What a popup or toast shows, as text. Game content is a string, HTML (`ns.alert`), or React content: often MUI and
 * game components, which need the game's theme to render. Never throws: the game emits these from its own code paths
 * (finishing work, offline progress), and in a browser an emit can't fail.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined || typeof content === "boolean") return "";
  try {
    const markup = renderToStaticMarkup(React.createElement(TTheme, null, content as React.ReactNode));
    const parsed = document.createElement("div");
    parsed.innerHTML = markup.replace(LINE_ENDS, (tag) => `${tag}\n`);
    return (parsed.textContent ?? "").replace(/\n+$/, "");
  } catch (error) {
    return `(content that couldn't be rendered as text: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Reports what the UI would have shown. Call once, before booting. */
export function captureUi(report: (event: GameEvent) => void): void {
  // AlertManager.tsx and Snackbar.tsx subscribe to these; dialogBoxCreate (DialogBox.tsx) emits through AlertEvents.
  // Unlike them, the log keeps repeats (AlertManager drops an alert identical to one still queued) and toasts on pages
  // that hide messages (the Snackbar unsubscribes there).
  AlertEvents.subscribe((content) => report({ type: "alert", text: textOf(content) }));
  SnackbarEvents.subscribe((content, variant) => report({ type: "toast", text: textOf(content), variant }));
  // ErrorModal.tsx shows each error the game reports, and the game reports a new one only while no popup is open.
  // Each is closed at once, as the popup's Close button does (onClose): marked read, and with no unread error left to
  // show next, the popup closes. Otherwise only the first error would ever be reported.
  ErrorState.ErrorUpdate.subscribe((error) => {
    report({
      type: "error",
      errorType: error.errorType,
      message: error.message,
      host: error.server,
      script: error.scriptName,
      pid: error.pid ?? null,
    });
    error.unread = false;
    ErrorState.ActiveError = null;
    ErrorState.UnreadErrors = ErrorState.Errors.filter((e) => e.unread).length;
  });
}

type Prompt = Parameters<Parameters<typeof PromptEvent.subscribe>[0]>[0];

/** What closing a prompt without answering gives (PromptManager.tsx:23-29). */
function dismiss(prompt: Prompt): void {
  prompt.resolve(["text", "select"].includes(prompt.options?.type ?? "") ? "" : false);
}

/**
 * Answers `ns.prompt` in the player's place (PromptManager.tsx resolves it when the player answers). `answer` returns
 * the answer, or `undefined` for no answer: then the prompt stays open, as for a player who isn't there, until a newer
 * prompt replaces it, which closes it as dismissing does (PromptManager.tsx:31-40). Call once, before booting.
 */
export function answerPrompts(answer: (prompt: PromptRequest) => string | boolean | undefined): void {
  let open: Prompt | null = null;
  PromptEvent.subscribe((prompt) => {
    if (open) dismiss(open);
    open = null;
    // PromptManager shows a text or select prompt for those types, and a yes/no prompt for anything else.
    const type = prompt.options?.type;
    const kind = type === "text" || type === "select" ? type : "boolean";
    const given = answer({ text: prompt.txt, kind, choices: prompt.options?.choices ?? [] });
    if (given === undefined) open = prompt;
    else prompt.resolve(given);
  });
}
