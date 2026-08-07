import type { RoundResult, RoundSnapshot } from "../contracts/round.js";

/**
 * Executes one transactional arena round.
 *
 * Implementations return typed terminal outcomes for expected execution
 * failures. They throw only for invalid configuration, invalid contracts, or
 * violated programming invariants.
 */
export interface RoundEngine {
  run(snapshot: RoundSnapshot): Promise<RoundResult>;
}
