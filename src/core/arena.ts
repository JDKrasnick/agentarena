import {
  RoundEngine,
  type ArenaDependencies,
  type FightOutcome,
} from "./round-engine.js";
import type { FightConfig } from "./types.js";

export type { ArenaDependencies, FightOutcome } from "./round-engine.js";

/** Run-level entry point. Operational phases belong to RoundEngine. */
export class Arena {
  private readonly roundEngine: RoundEngine;

  constructor(dependencies: ArenaDependencies) {
    this.roundEngine = new RoundEngine(dependencies);
  }

  fight(
    config: FightConfig,
    externalSignal?: AbortSignal,
  ): Promise<FightOutcome> {
    return this.roundEngine.fight(config, externalSignal);
  }
}
