/**
 * The game's companies and jobs (#153): the company names (`Company/Enums.ts`, `CompanyName`), and each job field's
 * positions in order, with the text of the button that applies for each (`Company/data/JobTracks.ts`,
 * `CompanyPositionsMetadata.ts`: "Apply for <job> Job" unless the position says otherwise). Shared by the in-game code
 * and the brain; plain literals, as in factions.ts.
 */

/** Every company, by the name the game uses. */
export const COMPANY_NAMES = [
  "ECorp",
  "MegaCorp",
  "Bachman & Associates",
  "Blade Industries",
  "NWO",
  "Clarke Incorporated",
  "OmniTek Incorporated",
  "Four Sigma",
  "KuaiGong International",
  "Fulcrum Technologies",
  "Storm Technologies",
  "DefComm",
  "Helios Labs",
  "VitaLife",
  "Icarus Microsystems",
  "Universal Energy",
  "Galactic Cybersystems",
  "AeroCorp",
  "Omnia Cybersystems",
  "Solaris Space Systems",
  "DeltaOne",
  "Global Pharmaceuticals",
  "Nova Medical",
  "Central Intelligence Agency",
  "National Security Agency",
  "Watchdog Security",
  "LexoCorp",
  "Rho Construction",
  "Alpha Enterprises",
  "Aevum Police Headquarters",
  "SysCore Securities",
  "CompuTek",
  "NetLink Technologies",
  "Carmichael Security",
  "FoodNStuff",
  "Joe's Guns",
  "Omega Software",
  "Noodle Bar",
];

/** A job: its title, and the company page's button that applies for it. */
export interface Job {
  title: string;
  applyText: string;
}

/** Each job field's positions, from the first: a company's page offers the next one the player qualifies for. */
export const JOB_FIELDS: Record<string, Job[]> = {
  Software: [
    { title: "Software Engineering Intern", applyText: "Apply for Software Engineering Intern Job" },
    { title: "Junior Software Engineer", applyText: "Apply for Junior Software Engineer Job" },
    { title: "Senior Software Engineer", applyText: "Apply for Senior Software Engineer Job" },
    { title: "Lead Software Developer", applyText: "Apply for Lead Software Developer Job" },
    { title: "Head of Software", applyText: "Apply for Head of Software Job" },
    { title: "Head of Engineering", applyText: "Apply for Head of Engineering Job" },
    { title: "Vice President of Technology", applyText: "Apply for Vice President of Technology Job" },
    { title: "Chief Technology Officer", applyText: "Apply for Chief Technology Officer Job" },
  ],
  "Software Consultant": [
    { title: "Software Consultant", applyText: "Pitch a Software Consulting contract" },
    { title: "Senior Software Consultant", applyText: "Pitch a Software Consulting contract" },
  ],
  IT: [
    { title: "IT Intern", applyText: "Apply for IT Intern Job" },
    { title: "IT Analyst", applyText: "Apply for IT Analyst Job" },
    { title: "IT Manager", applyText: "Apply for IT Manager Job" },
    { title: "Systems Administrator", applyText: "Apply for Systems Administrator Job" },
  ],
  "Security Engineer": [{ title: "Security Engineer", applyText: "Apply for Security Engineer Job" }],
  "Network Engineer": [
    { title: "Network Engineer", applyText: "Apply for Network Engineer Job" },
    { title: "Network Administrator", applyText: "Apply for Network Administrator Job" },
  ],
  Business: [
    { title: "Business Intern", applyText: "Apply for Business Intern Job" },
    { title: "Business Analyst", applyText: "Apply for Business Analyst Job" },
    { title: "Business Manager", applyText: "Apply for Business Manager Job" },
    { title: "Operations Manager", applyText: "Apply for Operations Manager Job" },
    { title: "Chief Financial Officer", applyText: "Apply for Chief Financial Officer Job" },
    { title: "Chief Executive Officer", applyText: "Apply for Chief Executive Officer Job" },
  ],
  "Business Consultant": [
    { title: "Business Consultant", applyText: "Pitch a Business Consulting contract" },
    { title: "Senior Business Consultant", applyText: "Pitch a Business Consulting contract" },
  ],
  Security: [
    { title: "Security Guard", applyText: "Apply for Security Guard Job" },
    { title: "Security Officer", applyText: "Apply for Security Officer Job" },
    { title: "Security Supervisor", applyText: "Apply for Security Supervisor Job" },
    { title: "Head of Security", applyText: "Apply for Head of Security Job" },
  ],
  Agent: [
    { title: "Field Agent", applyText: "Apply for Field Agent Job" },
    { title: "Secret Agent", applyText: "Apply for Secret Agent Job" },
    { title: "Special Operative", applyText: "Apply for Special Operative Job" },
  ],
  Employee: [{ title: "Employee", applyText: "Apply to be an Employee" }],
  "Part-time Employee": [{ title: "Part-time Employee", applyText: "Apply to be a Part-time Employee" }],
  Waiter: [{ title: "Waiter", applyText: "Apply to be a Waiter" }],
  "Part-time Waiter": [{ title: "Part-time Waiter", applyText: "Apply to be a Part-time Waiter" }],
};

/** The job titles of a job field, from the first; none for a field the game doesn't have. */
export function jobTitles(field: string): string[] {
  return ((Object.hasOwn(JOB_FIELDS, field) ? JOB_FIELDS[field] : undefined) ?? []).map((job) => job.title);
}

/**
 * Whether `jobs` (`getPlayer().jobs`: the title held at each company) holds a job in `field` at `company`. Titles are
 * unique across fields, so the title says the field.
 */
export function holdsJobInField(jobs: Record<string, string | undefined>, company: string, field: string): boolean {
  const title = Object.hasOwn(jobs, company) ? jobs[company] : undefined;
  return title !== undefined && jobTitles(field).includes(title);
}

/**
 * The jobs of `field` after `title`, in order: what a promotion in the field can bring (#155). Each position's
 * `nextPosition` is the next of its track (`Company/data/CompanyPositionsMetadata.ts`), but for the last of IT,
 * Security Engineer and Network Engineer, whose next is Software's Head of Engineering: the game's climb
 * (`applyForJob`) leaves the field there, and a promotion in the field doesn't. None where `title` isn't one of the
 * field's, or is its last.
 */
export function laterJobs(field: string, title: string | undefined): Job[] {
  const jobs = (Object.hasOwn(JOB_FIELDS, field) ? JOB_FIELDS[field] : undefined) ?? [];
  const held = jobs.findIndex((job) => job.title === title);
  return held === -1 ? [] : jobs.slice(held + 1);
}

/** A promotion (#155): the title held before, and the later title of the same field after. */
export interface Promotion {
  from: string;
  to: string;
}

/**
 * The promotion between two of `getPlayer().jobs` (the title held at each company), at `company` in `field`: a title
 * of the field before, and a later one after. Null for none: no change, a hire (no title before), or another field.
 */
export function promotionBetween(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
  company: string,
  field: string,
): Promotion | null {
  const from = Object.hasOwn(before, company) ? before[company] : undefined;
  const to = Object.hasOwn(after, company) ? after[company] : undefined;
  if (from === undefined || to === undefined) return null;
  return laterJobs(field, from).some((job) => job.title === to) ? { from, to } : null;
}

/** The part-time fields: the game gives them full gains unfocused (`Work/CompanyWork.tsx:36`), so focus buys nothing. */
export const PART_TIME_JOB_FIELDS = ["Part-time Employee", "Part-time Waiter"];
