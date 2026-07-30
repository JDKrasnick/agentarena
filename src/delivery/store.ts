import type { ArtifactStore } from "../artifacts/store.js";
import {
  DeliveryDecisionSchema,
  DeliveryResultSchema,
  type DeliveryDecision,
  type DeliveryResult,
} from "./types.js";

export async function readCurrentDeliveryDecision(
  store: ArtifactStore,
): Promise<DeliveryDecision | undefined> {
  const values = await store.listValidatedArtifacts(
    "delivery/decisions",
    DeliveryDecisionSchema,
  );
  return values
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt))
    .at(-1);
}

export async function readDeliveryResult(
  store: ArtifactStore,
): Promise<DeliveryResult | undefined> {
  return store.readOptionalJson("delivery/status.json", DeliveryResultSchema);
}
