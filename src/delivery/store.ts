import type { ArtifactStore } from "../artifacts/store.js";
import { resolveLedgerHead } from "../review/store.js";
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
  return resolveLedgerHead(values, "Delivery");
}

export async function readDeliveryResult(
  store: ArtifactStore,
): Promise<DeliveryResult | undefined> {
  return store.readOptionalJson("delivery/status.json", DeliveryResultSchema);
}
