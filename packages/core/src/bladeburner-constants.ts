/**
 * Bladeburner's constants (`vendor/bitburner-src/src/Bladeburner/data/Constants.ts`, v3.0.1) and the chaos's factor, apart
 * from ./bladeburner-actions.ts so ./bladeburner-drift.ts reads them with no import cycle (#418's review).
 */

/** The game's constants (`data/Constants.ts`). */
export const BLADEBURNER_CONSTANTS = {
  staminaGainPerSecond: 0.0085,
  baseStaminaLoss: 0.285,
  maxStaminaToGainFactor: 70_000,
  difficultyToTimeFactor: 10,
  diffMultExponentialFactor: 0.28,
  diffMultLinearFactor: 650,
  effAgiLinearFactor: 10e3,
  effDexLinearFactor: 10e3,
  effAgiExponentialFactor: 0.04,
  effDexExponentialFactor: 0.035,
  populationThreshold: 1e9,
  populationExponent: 0.7,
  chaosThreshold: 50,
  actionCountGrowthPeriod: 480,
  contractSuccessesPerLevel: 3,
  operationSuccessesPerLevel: 2.5,
  contractBaseMoneyGain: 250e3,
  hrcStaminaGainPercent: 1,
  /** A tick takes at most this many seconds' stored cycles (`Bladeburner.ts:1379`): bonus time's speed. */
  maxSecondsPerTick: 5,
} as const;

/** The chaos's factor on difficulty: √(1 + chaos − 50) over 50, else 1 (`Actions/Action.ts:94-103`). */
export function chaosDifficultyFactor(chaos: number): number {
  const { chaosThreshold } = BLADEBURNER_CONSTANTS;
  return chaos > chaosThreshold ? (1 + (chaos - chaosThreshold)) ** 0.5 : 1;
}
