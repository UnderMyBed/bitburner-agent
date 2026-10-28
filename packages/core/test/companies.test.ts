// The game's companies and jobs (#153), checked against the pinned game's source: the names, the job fields, each
// field's positions in order, the button texts that apply for them, the part-time fields, and promotions (#155).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  COMPANY_NAMES,
  holdsJobInField,
  JOB_FIELDS,
  jobTitles,
  laterJobs,
  PART_TIME_JOB_FIELDS,
  promotionBetween,
} from "../src/companies.ts";

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

test("PART_TIME_JOB_FIELDS are the job fields (`JobTracks`) whose positions are all part-time", () => {
  const jobNames = gameEnum("Work/Enums.ts", "JobName");
  const partTimeTitles = gameSource("Company/data/CompanyPositionsMetadata.ts")
    .split("[JobName.")
    .filter((position) => /isPartTime: true/.test(position))
    .map((position) => jobNames[position.slice(0, position.indexOf("]"))]);
  expect(partTimeTitles.length).toBeGreaterThan(0);
  const partTimeFields = Object.entries(JOB_FIELDS)
    .filter(([, jobs]) => jobs.every((job) => partTimeTitles.includes(job.title)))
    .map(([field]) => field);
  expect(partTimeFields).toEqual(PART_TIME_JOB_FIELDS);
});

test("jobTitles and holdsJobInField: a title of the field, at that company only", () => {
  expect(jobTitles("IT")).toEqual(["IT Intern", "IT Analyst", "IT Manager", "Systems Administrator"]);
  expect(jobTitles("constructor")).toEqual([]);
  const jobs = { "Noodle Bar": "Waiter", MegaCorp: "IT Analyst" };
  expect(holdsJobInField(jobs, "Noodle Bar", "Waiter")).toBe(true);
  expect(holdsJobInField(jobs, "MegaCorp", "IT")).toBe(true);
  // Another field at the same company, the same field elsewhere, no job, a key from the prototype.
  expect(holdsJobInField(jobs, "MegaCorp", "Software")).toBe(false);
  expect(holdsJobInField(jobs, "ECorp", "IT")).toBe(false);
  expect(holdsJobInField({}, "Noodle Bar", "Waiter")).toBe(false);
  expect(holdsJobInField(jobs, "constructor", "Waiter")).toBe(false);
});

test("laterJobs (#155): the game's `nextPosition` within the field; three tracks' last leads out of it", () => {
  const jobNames = gameEnum("Work/Enums.ts", "JobName");
  const metadata = gameSource("Company/data/CompanyPositionsMetadata.ts");
  const outOfTheField: string[] = [];
  for (const [field, jobs] of Object.entries(JOB_FIELDS)) {
    for (const { title } of jobs) {
      const jobKey = Object.keys(jobNames).find((key) => jobNames[key] === title) as string;
      const position = new RegExp(`\\[JobName\\.${jobKey}\\]: \\{([^}]*)\\}`, "s").exec(metadata)?.[1] ?? "";
      const nextKey = /nextPosition: JobName\.(\w+)/.exec(position)?.[1];
      const next = nextKey === undefined ? undefined : jobNames[nextKey];
      if (next !== undefined && !jobTitles(field).includes(next)) outOfTheField.push(`${title} → ${next}`);
      else expect(laterJobs(field, title)[0]?.title, title).toBe(next);
    }
  }
  // The game's climb goes on from these into Software's Head of Engineering; a promotion here stays in the field.
  expect(outOfTheField).toEqual([
    "Systems Administrator → Head of Engineering",
    "Security Engineer → Head of Engineering",
    "Network Administrator → Head of Engineering",
  ]);
  expect(laterJobs("IT", "Systems Administrator")).toEqual([]);
  expect(laterJobs("IT", "IT Analyst").map((job) => job.title)).toEqual(["IT Manager", "Systems Administrator"]);
  // Not one of the field's titles, none held, no such field: nothing.
  expect(laterJobs("IT", "Junior Software Engineer")).toEqual([]);
  expect(laterJobs("IT", undefined)).toEqual([]);
  expect(laterJobs("constructor", "IT Intern")).toEqual([]);
});

test("promotionBetween (#155): a later title of the field at that company; not a hire, a step down, or another field", () => {
  const before = { "Noodle Bar": "Waiter", "Carmichael Security": "IT Intern" };
  const promoted = { ...before, "Carmichael Security": "IT Manager" };
  expect(promotionBetween(before, promoted, "Carmichael Security", "IT")).toEqual({
    from: "IT Intern",
    to: "IT Manager",
  });
  expect(promotionBetween(before, before, "Carmichael Security", "IT")).toBeNull();
  expect(promotionBetween(promoted, before, "Carmichael Security", "IT")).toBeNull();
  expect(promotionBetween({}, before, "Carmichael Security", "IT")).toBeNull();
  expect(promotionBetween(before, promoted, "Carmichael Security", "Software")).toBeNull();
  expect(promotionBetween(before, promoted, "Noodle Bar", "Waiter")).toBeNull();
  // The consultants' two titles share one button text, and are still told apart.
  const consultant = { "Omega Software": "Software Consultant" };
  const senior = { "Omega Software": "Senior Software Consultant" };
  expect(promotionBetween(consultant, senior, "Omega Software", "Software Consultant")).toEqual({
    from: "Software Consultant",
    to: "Senior Software Consultant",
  });
});
