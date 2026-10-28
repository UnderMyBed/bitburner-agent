// A stand-in for the game's page in jsdom (#167, #177): elements with React's props on them, as the game renders them,
// for the page timers' tests. E2 drives the real page (packages/e2/test/effectors.e2.test.ts).

/** What `run` prints once the script has started (`Terminal/commands/runScript.ts:79-83`). */
export const STARTED: string = "Running script with 1 thread, pid 1 and args: [].";
/** Longer than the timer's poll (100 ms): the input renders a typed line only after it. */
export const RENDER_MS = 250;
/** Every click the stand-ins record, in order. */
export const clicks: string[] = [];

export const withProps = <T extends Element>(element: T, props: Record<string, unknown>): T =>
  Object.assign(element, { __reactProps$test: props });
export const element = (tag: string, fields: Record<string, unknown> = {}) =>
  Object.assign(document.createElement(tag), fields);

/**
 * The Terminal: its output and its controlled input, as `Terminal/ui/TerminalInput.tsx` renders it. Typing sets the
 * line, which the input renders `RENDER_MS` later, with its `value` prop and new handlers; Enter runs the line its last
 * render saw: the echo, then what `answer` prints for it, rendered `RENDER_MS` later too. `earlier` lines are in the
 * output already. `renderMs` sets how long a render takes; `onRun` sees each line run at once, as the game's commands
 * act (a `backdoor` disables the input).
 */
export function terminal({
  answer = (_line: string) => STARTED,
  typed = "",
  enterDoesNothing = false,
  neverRenders = false,
  disabled = false,
  earlier = [] as string[],
  renderMs = RENDER_MS,
  onRun = (_line: string, _input: HTMLInputElement) => {},
} = {}) {
  const output = element("ul", { id: "terminal" });
  for (const line of ["Bitburner v3.0.1 (1da7316)", ...earlier]) output.append(element("li", { textContent: line }));
  const input = element("input", { id: "terminal-input", value: typed, disabled }) as unknown as HTMLInputElement;
  const ran: string[] = [];
  const render = (line: string) => {
    input.value = line;
    withProps(input, {
      value: line,
      onChange: (event: { target: { value: string } }) => {
        if (!neverRenders) setTimeout(() => render(event.target.value), renderMs);
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key !== "Enter" || enterDoesNothing) return;
        ran.push(line);
        onRun(line, input);
        // The output renders a moment later, as the game's does: what's there before is what a look sees first.
        setTimeout(() => {
          output.append(element("li", { textContent: `[home /]> ${line}` }));
          if (line !== "") output.append(element("li", { textContent: answer(line) }));
        }, renderMs);
        render("");
      },
    });
  };
  render(typed);
  document.body.append(output, input);
  return { input, ran };
}

/** The sidebar's Options, which opens the Options page with its "Force kill all active scripts". */
export function optionsInSidebar({ withForceKill = true } = {}) {
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
