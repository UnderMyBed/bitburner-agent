// Every faction: generated from the pinned game (v3.0.1) by
// packages/sim/scripts/generate-game-data.ts (#193). Don't edit it; rerun that. packages/sim/test/game-data.test.ts
// checks it against the engine.
import type { FactionData } from "./factions.ts";

/** Every faction, by name, in the game's order (`Faction/Enums.ts`). */
export const FACTIONS: Record<string, FactionData> = {
  Illuminati: {
    enemies: [],
    inviteRequirements: [
      {
        type: "numAugmentations",
        numAugmentations: 30,
      },
      {
        type: "money",
        money: 150000000000,
      },
      {
        type: "skills",
        skills: {
          hacking: 1500,
        },
      },
      {
        type: "skills",
        skills: {
          strength: 1200,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 1200,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 1200,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 1200,
        },
      },
    ],
    workTypes: ["hacking", "field"],
    keepOnInstall: false,
  },
  Daedalus: {
    enemies: [],
    inviteRequirements: [
      {
        type: "numAugmentations",
        numAugmentations: 30,
      },
      {
        type: "money",
        money: 100000000000,
      },
      {
        type: "someCondition",
        conditions: [
          {
            type: "skills",
            skills: {
              hacking: 2500,
            },
          },
          {
            type: "skills",
            skills: {
              strength: 1500,
              defense: 1500,
              dexterity: 1500,
              agility: 1500,
            },
          },
        ],
      },
    ],
    workTypes: ["hacking", "field"],
    keepOnInstall: false,
  },
  "The Covenant": {
    enemies: [],
    inviteRequirements: [
      {
        type: "numAugmentations",
        numAugmentations: 20,
      },
      {
        type: "money",
        money: 75000000000,
      },
      {
        type: "skills",
        skills: {
          hacking: 850,
        },
      },
      {
        type: "skills",
        skills: {
          strength: 850,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 850,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 850,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 850,
        },
      },
    ],
    workTypes: ["hacking", "field"],
    keepOnInstall: false,
  },
  ECorp: {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "ECorp",
      },
      {
        type: "companyReputation",
        company: "ECorp",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  MegaCorp: {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "MegaCorp",
      },
      {
        type: "companyReputation",
        company: "MegaCorp",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "Bachman & Associates": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "Bachman & Associates",
      },
      {
        type: "companyReputation",
        company: "Bachman & Associates",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "Blade Industries": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "Blade Industries",
      },
      {
        type: "companyReputation",
        company: "Blade Industries",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  NWO: {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "NWO",
      },
      {
        type: "companyReputation",
        company: "NWO",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "Clarke Incorporated": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "Clarke Incorporated",
      },
      {
        type: "companyReputation",
        company: "Clarke Incorporated",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "OmniTek Incorporated": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "OmniTek Incorporated",
      },
      {
        type: "companyReputation",
        company: "OmniTek Incorporated",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "Four Sigma": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "Four Sigma",
      },
      {
        type: "companyReputation",
        company: "Four Sigma",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "KuaiGong International": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "KuaiGong International",
      },
      {
        type: "companyReputation",
        company: "KuaiGong International",
        reputation: 400000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: true,
  },
  "Fulcrum Secret Technologies": {
    enemies: [],
    inviteRequirements: [
      {
        type: "employedBy",
        company: "Fulcrum Technologies",
      },
      {
        type: "companyReputation",
        company: "Fulcrum Technologies",
        reputation: 400000,
      },
      {
        type: "backdoorInstalled",
        server: "fulcrumassets",
      },
    ],
    workTypes: ["hacking", "security"],
    keepOnInstall: true,
  },
  BitRunners: {
    enemies: [],
    inviteRequirements: [
      {
        type: "backdoorInstalled",
        server: "run4theh111z",
      },
    ],
    workTypes: ["hacking"],
    keepOnInstall: false,
  },
  "The Black Hand": {
    enemies: [],
    inviteRequirements: [
      {
        type: "backdoorInstalled",
        server: "I.I.I.I",
      },
    ],
    workTypes: ["hacking", "field"],
    keepOnInstall: false,
  },
  NiteSec: {
    enemies: [],
    inviteRequirements: [
      {
        type: "backdoorInstalled",
        server: "avmnite-02h",
      },
    ],
    workTypes: ["hacking"],
    keepOnInstall: false,
  },
  Aevum: {
    enemies: ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
    inviteRequirements: [
      {
        type: "city",
        city: "Aevum",
      },
      {
        type: "money",
        money: 40000000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  Chongqing: {
    enemies: ["Sector-12", "Aevum", "Volhaven"],
    inviteRequirements: [
      {
        type: "city",
        city: "Chongqing",
      },
      {
        type: "money",
        money: 20000000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  Ishima: {
    enemies: ["Sector-12", "Aevum", "Volhaven"],
    inviteRequirements: [
      {
        type: "city",
        city: "Ishima",
      },
      {
        type: "money",
        money: 30000000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  "New Tokyo": {
    enemies: ["Sector-12", "Aevum", "Volhaven"],
    inviteRequirements: [
      {
        type: "city",
        city: "New Tokyo",
      },
      {
        type: "money",
        money: 20000000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  "Sector-12": {
    enemies: ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
    inviteRequirements: [
      {
        type: "city",
        city: "Sector-12",
      },
      {
        type: "money",
        money: 15000000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  Volhaven: {
    enemies: ["Chongqing", "Sector-12", "New Tokyo", "Aevum", "Ishima"],
    inviteRequirements: [
      {
        type: "city",
        city: "Volhaven",
      },
      {
        type: "money",
        money: 50000000,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  "Speakers for the Dead": {
    enemies: [],
    inviteRequirements: [
      {
        type: "not",
        condition: {
          type: "employedBy",
          company: "Central Intelligence Agency",
        },
      },
      {
        type: "not",
        condition: {
          type: "employedBy",
          company: "National Security Agency",
        },
      },
      {
        type: "skills",
        skills: {
          hacking: 100,
        },
      },
      {
        type: "skills",
        skills: {
          strength: 300,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 300,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 300,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 300,
        },
      },
      {
        type: "numPeopleKilled",
        numPeopleKilled: 30,
      },
      {
        type: "karma",
        karma: -45,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  "The Dark Army": {
    enemies: [],
    inviteRequirements: [
      {
        type: "city",
        city: "Chongqing",
      },
      {
        type: "not",
        condition: {
          type: "employedBy",
          company: "Central Intelligence Agency",
        },
      },
      {
        type: "not",
        condition: {
          type: "employedBy",
          company: "National Security Agency",
        },
      },
      {
        type: "skills",
        skills: {
          hacking: 300,
        },
      },
      {
        type: "skills",
        skills: {
          strength: 300,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 300,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 300,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 300,
        },
      },
      {
        type: "numPeopleKilled",
        numPeopleKilled: 5,
      },
      {
        type: "karma",
        karma: -45,
      },
    ],
    workTypes: ["hacking", "field"],
    keepOnInstall: false,
  },
  "The Syndicate": {
    enemies: [],
    inviteRequirements: [
      {
        type: "someCondition",
        conditions: [
          {
            type: "city",
            city: "Aevum",
          },
          {
            type: "city",
            city: "Sector-12",
          },
        ],
      },
      {
        type: "not",
        condition: {
          type: "employedBy",
          company: "Central Intelligence Agency",
        },
      },
      {
        type: "not",
        condition: {
          type: "employedBy",
          company: "National Security Agency",
        },
      },
      {
        type: "money",
        money: 10000000,
      },
      {
        type: "skills",
        skills: {
          hacking: 200,
        },
      },
      {
        type: "skills",
        skills: {
          strength: 200,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 200,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 200,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 200,
        },
      },
      {
        type: "karma",
        karma: -90,
      },
    ],
    workTypes: ["hacking", "field", "security"],
    keepOnInstall: false,
  },
  Silhouette: {
    enemies: [],
    inviteRequirements: [
      {
        type: "someCondition",
        conditions: [
          {
            type: "jobTitle",
            jobTitle: "Chief Technology Officer",
          },
          {
            type: "jobTitle",
            jobTitle: "Chief Financial Officer",
          },
          {
            type: "jobTitle",
            jobTitle: "Chief Executive Officer",
          },
        ],
      },
      {
        type: "money",
        money: 15000000,
      },
      {
        type: "karma",
        karma: -22,
      },
    ],
    workTypes: ["hacking", "field"],
    keepOnInstall: false,
  },
  Tetrads: {
    enemies: [],
    inviteRequirements: [
      {
        type: "someCondition",
        conditions: [
          {
            type: "city",
            city: "Chongqing",
          },
          {
            type: "city",
            city: "New Tokyo",
          },
          {
            type: "city",
            city: "Ishima",
          },
        ],
      },
      {
        type: "skills",
        skills: {
          strength: 75,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 75,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 75,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 75,
        },
      },
      {
        type: "karma",
        karma: -18,
      },
    ],
    workTypes: ["field", "security"],
    keepOnInstall: false,
  },
  "Slum Snakes": {
    enemies: [],
    inviteRequirements: [
      {
        type: "skills",
        skills: {
          strength: 30,
        },
      },
      {
        type: "skills",
        skills: {
          defense: 30,
        },
      },
      {
        type: "skills",
        skills: {
          dexterity: 30,
        },
      },
      {
        type: "skills",
        skills: {
          agility: 30,
        },
      },
      {
        type: "money",
        money: 1000000,
      },
      {
        type: "karma",
        karma: -9,
      },
    ],
    workTypes: ["field", "security"],
    keepOnInstall: false,
  },
  Netburners: {
    enemies: [],
    inviteRequirements: [
      {
        type: "skills",
        skills: {
          hacking: 80,
        },
      },
      {
        type: "hacknetRAM",
        hacknetRAM: 8,
      },
      {
        type: "hacknetCores",
        hacknetCores: 4,
      },
      {
        type: "hacknetLevels",
        hacknetLevels: 100,
      },
    ],
    workTypes: ["hacking"],
    keepOnInstall: false,
  },
  "Tian Di Hui": {
    enemies: [],
    inviteRequirements: [
      {
        type: "someCondition",
        conditions: [
          {
            type: "city",
            city: "Chongqing",
          },
          {
            type: "city",
            city: "New Tokyo",
          },
          {
            type: "city",
            city: "Ishima",
          },
        ],
      },
      {
        type: "skills",
        skills: {
          hacking: 50,
        },
      },
      {
        type: "money",
        money: 1000000,
      },
    ],
    workTypes: ["hacking", "security"],
    keepOnInstall: false,
  },
  CyberSec: {
    enemies: [],
    inviteRequirements: [
      {
        type: "backdoorInstalled",
        server: "CSEC",
      },
    ],
    workTypes: ["hacking"],
    keepOnInstall: false,
  },
  Bladeburners: {
    enemies: [],
    inviteRequirements: [
      {
        type: "someCondition",
        conditions: [
          {
            type: "someCondition",
            conditions: [
              {
                type: "bitNodeN",
                bitNodeN: 6,
              },
              {
                type: "sourceFile",
                sourceFile: 6,
              },
            ],
          },
          {
            type: "someCondition",
            conditions: [
              {
                type: "bitNodeN",
                bitNodeN: 7,
              },
              {
                type: "sourceFile",
                sourceFile: 7,
              },
            ],
          },
        ],
      },
      {
        type: "bladeburnerRank",
        bladeburnerRank: 25,
      },
    ],
    workTypes: [],
    keepOnInstall: false,
  },
  "Church of the Machine God": {
    enemies: [],
    inviteRequirements: [
      {
        type: "someCondition",
        conditions: [
          {
            type: "bitNodeN",
            bitNodeN: 13,
          },
          {
            type: "sourceFile",
            sourceFile: 13,
          },
        ],
      },
      {
        type: "numAugmentations",
        numAugmentations: 0,
      },
      {
        type: "location",
        location: "Church of the Machine God",
      },
    ],
    workTypes: [],
    keepOnInstall: true,
  },
  "Shadows of Anarchy": {
    enemies: [],
    inviteRequirements: [
      {
        type: "numInfiltrations",
        numInfiltrations: 1,
      },
    ],
    workTypes: [],
    keepOnInstall: true,
  },
};
