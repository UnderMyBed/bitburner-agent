// The game's companies and jobs (#153), checked against the pinned game's source: the names, the job fields, each
// field's positions in order, and the button texts that apply for them.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { COMPANY_NAMES, JOB_FIELDS } from "../src/companies.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** `enumName`'s members in `file`, by key: { software0: "Software Engineering Intern", … }. */
function gameEnum(file: string, enumName: string): Record<string, string> {
  const source = gameSource(file);
  const start = source.indexOf(`export enum ${enumName}`);
  const body = source.slice(start, source.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/^\s+(\w+) = "([^"]+)",/gm)].map((match) => [match[1], match[2]]));
}

test("COMPANY_NAMES are the game's, exactly", () => {
  expect(COMPANY_NAMES).toEqual(Object.values(gameEnum("Company/Enums.ts", "CompanyName")));
});

test("JOB_FIELDS: the game's fields, each with its positions in order (`JobTracks`) and their apply texts", () => {
  const jobNames = gameEnum("Work/Enums.ts", "JobName");
  const fields = gameEnum("Work/Enums.ts", "JobField");
  expect(Object.keys(JOB_FIELDS)).toEqual(Object.values(fields));
  const tracks = gameSource("Company/data/JobTracks.ts");
  const metadata = gameSource("Company/data/CompanyPositionsMetadata.ts");
  for (const [fieldKey, field] of Object.entries(fields)) {
    const track = new RegExp(`\\[JobField\\.${fieldKey}\\]: \\[([^\\]]+)\\]`).exec(tracks)?.[1] ?? "";
    const jobKeys = [...track.matchAll(/JobName\.(\w+)/g)].map((match) => match[1] as string);
    const expected = jobKeys.map((jobKey) => {
      const title = jobNames[jobKey] as string;
      // A position's own text, if it has one; `${JobName.x}` in it is that job's title.
      const own = new RegExp(`\\[JobName\\.${jobKey}\\]: \\{[^}]*?applyText: \`([^\`]+)\``, "s").exec(metadata)?.[1];
      const applyText = own?.replace(/\$\{JobName\.(\w+)\}/g, (_text, key: string) => jobNames[key] as string);
      return { title, applyText: applyText ?? `Apply for ${title} Job` };
    });
    expect(JOB_FIELDS[field], field).toEqual(expected);
  }
});
