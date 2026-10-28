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

/** Home worker: converges the player's work on company work through the game's page (#153), focus included. */
export const COMPANY_WORK_WORKER_NAME = "company-work.js";
