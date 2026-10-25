import type { PromptRequest, PromptRule } from "../protocol.ts";
import { gameEvent } from "./events.ts";

/**
 * Answers `ns.prompt` in the player's place: the first rule whose `match` is in the prompt's text, otherwise what
 * dismissing the prompt gives (PromptManager.tsx resolves a dismissed text or select prompt with "", anything else
 * with false). Every prompt and its answer go in the event log.
 */
export function promptAnswerer(rules: PromptRule[] = []): (prompt: PromptRequest) => string | boolean {
  return (prompt) => {
    const rule = rules.find(({ match }) => prompt.text.includes(match));
    const answer = rule ? rule.answer : prompt.kind === "boolean" ? false : "";
    gameEvent({ type: "prompt", ...prompt, answer, answeredBy: rule ? "rule" : "default" });
    return answer;
  };
}
