import type { PromptRequest, PromptRule } from "../protocol.ts";
import { gameEvent } from "./events.ts";

/** Whether a player could give this answer to this prompt (PromptManager.tsx: Yes/No, a text box, a choice). */
function fits(answer: string | boolean, { kind, choices }: PromptRequest): boolean {
  if (kind === "boolean") return typeof answer === "boolean";
  if (kind === "select") return typeof answer === "string" && choices.includes(answer);
  return typeof answer === "string";
}

/**
 * Answers `ns.prompt` in the player's place. The first rule whose `match` is in the prompt's text gives the answer.
 * With no matching rule there is no answer: the prompt stays open, as it would with nobody at the screen. Every prompt
 * goes in the event log. A rule whose answer no player could give (a word for a yes/no prompt, an option that isn't
 * offered) fails the `ns.prompt` call, so a mistaken rule is found rather than handing scripts an impossible value.
 */
export function promptAnswerer(rules: PromptRule[] = []): (prompt: PromptRequest) => string | boolean | undefined {
  return (prompt) => {
    const rule = rules.find(({ match }) => prompt.text.includes(match));
    if (rule && !fits(rule.answer, prompt)) {
      throw new TypeError(
        `Prompt rule ${JSON.stringify(rule.match)} answers ${JSON.stringify(rule.answer)}, which a player couldn't ` +
          `give to this ${prompt.kind} prompt${prompt.kind === "select" ? ` (choices: ${prompt.choices.join(", ")})` : ""}`,
      );
    }
    gameEvent({ type: "prompt", ...prompt, answer: rule?.answer ?? null, answeredBy: rule ? "rule" : "nobody" });
    return rule?.answer;
  };
}
