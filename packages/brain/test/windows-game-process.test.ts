// The Windows game process (#94): the commands the supervisor runs, and reading tasklist's answer. With a fake command
// runner: no test ever starts or stops a real process.
import { expect, test } from "vitest";
import { tasklistShowsImage, WindowsGameProcess } from "../src/windows-game-process.ts";

function processWith(output = "") {
  const commands: string[][] = [];
  const gameProcess = new WindowsGameProcess({
    steamAppId: 1812820,
    gameExecutable: "bitburner.exe",
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      return output;
    },
  });
  return { gameProcess, commands };
}

test.each([
  ["found", '"bitburner.exe","12345","Console","1","250,000 K"\r\n', true],
  [
    "found, in another case, among others",
    '"System","4","Services","0","100 K"\r\n"Bitburner.EXE","9","Console","1","1 K"\r\n',
    true,
  ],
  ["the No tasks message", "INFO: No tasks are running which match the specified criteria.\r\n", false],
  ["nothing at all", "", false],
  ["a different program whose name contains it", '"notbitburner.exe","1","Console","1","1 K"\r\n', false],
])("tasklist's CSV: %s", (_description, output, expected) => {
  expect(tasklistShowsImage(output, "bitburner.exe")).toBe(expected);
});

test("isRunning asks tasklist for the game's image, as CSV without a header", async () => {
  const { gameProcess, commands } = processWith('"bitburner.exe","12345","Console","1","250,000 K"');
  expect(await gameProcess.isRunning()).toBe(true);
  expect(commands).toEqual([["tasklist", "/FI", "IMAGENAME eq bitburner.exe", "/FO", "CSV", "/NH"]]);
});

test("launch starts the game through Steam, as a player does; kill ends it and its children", async () => {
  const { gameProcess, commands } = processWith();
  await gameProcess.launch();
  await gameProcess.kill();
  expect(commands).toEqual([
    ["cmd", "/c", "start", "", "steam://rungameid/1812820"],
    ["taskkill", "/IM", "bitburner.exe", "/T", "/F"],
  ]);
});
