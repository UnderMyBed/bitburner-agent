// What the browser page gives the game besides the Router (router.ts): the globals that index.tsx and the libraries
// set on `window`, and the UI that shows popups, toasts, the error popup and prompts. Headless there is no UI, so
// these are reported to the host as events instead, and prompts are answered by the host's rules.
// Bundled with the game (entry.ts); docs/sim/parity.md §3 and §4 list what it covers.
import _ from "lodash";
import React from "react";
import ReactDOM from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "../../../../../vendor/bitburner-src/src/ErrorHandling/ErrorState";
import { AlertEvents } from "../../../../../vendor/bitburner-src/src/ui/React/AlertManager";
import { PromptEvent } from "../../../../../vendor/bitburner-src/src/ui/React/PromptManager";
import { SnackbarEvents } from "../../../../../vendor/bitburner-src/src/ui/React/Snackbar";
import type { GameEvent, PromptRequest } from "../../protocol.ts";

/**
 * In a browser `globalThis` is `window`, so whatever the page puts on `window` is a global for player scripts too.
 * Headless they are two objects, so these go on both:
 * - `sprintf`/`vsprintf`, which sprintf-js puts on `window` when it loads
 * - lodash's `_`, which lodash puts on the global object under webpack (its AMD branch)
 * - `React`/`ReactDOM`, and the `print`/`prompt` traps, from index.tsx (:15-16, :60-70)
 */
export function installPageGlobals(): void {
  const win = window as unknown as Record<string, unknown>;
  if (typeof win.sprintf !== "function" || typeof win.vsprintf !== "function") {
    throw new Error("sprintf-js didn't put sprintf/vsprintf on window: load the engine after installDom");
  }
  const globals = {
    sprintf: win.sprintf,
    vsprintf: win.vsprintf,
    _,
    React,
    ReactDOM,
    print: () => {
      throw new Error("You accidentally called window.print instead of ns.print");
    },
    prompt: () => {
      throw new Error("You accidentally called window.prompt instead of ns.prompt");
    },
  };
  Object.assign(window, globals);
  Object.assign(globalThis, globals);
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

/** What a popup or toast shows, as text. Game content is a string or React content (often MUI components). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined || typeof content === "boolean") return "";
  const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, content as React.ReactNode));
  return markup
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_match, name: string) => entities[name] ?? "");
}

let report: (event: GameEvent) => void = () => {};
let capturing = false;

/** Reports what the UI would have shown. Call once, before booting. */
export function setGameEventListener(listener: (event: GameEvent) => void): void {
  report = listener;
  if (capturing) return;
  capturing = true;
  // AlertManager.tsx and Snackbar.tsx subscribe to these; dialogBoxCreate (DialogBox.tsx) emits through AlertEvents.
  AlertEvents.subscribe((content) => report({ type: "alert", text: textOf(content) }));
  SnackbarEvents.subscribe((content, variant) => report({ type: "toast", text: textOf(content), variant }));
  // ErrorModal.tsx shows each error the game reports. Dismissing it at once (its close button with `force`, which
  // clears the active error) lets the game report the next one: otherwise only the first error would ever appear.
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

/** Answers `ns.prompt` (PromptManager.tsx resolves it when the player answers). Call once, before booting. */
export function setPromptAnswerer(answer: (prompt: PromptRequest) => string | boolean): void {
  PromptEvent.subscribe(({ txt, options, resolve }) => {
    // PromptManager shows a text or select prompt for those types, and a yes/no prompt for anything else.
    const kind = options?.type === "text" || options?.type === "select" ? options.type : "boolean";
    resolve(answer({ text: txt, kind, choices: options?.choices ?? [] }));
  });
}
