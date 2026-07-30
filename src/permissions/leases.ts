import type { CapabilityDecision } from "../core/types.js";

export interface CapabilityLease {
  capabilityId: string;
  scopes: string[];
  expiresAt: string;
  status: "active" | "expired";
}

export class LeaseRegistry {
  private readonly leases = new Map<string, CapabilityLease>();

  issue(capability: CapabilityDecision, expiresAt: Date): CapabilityLease {
    if (capability.status !== "approved") {
      throw new Error(
        `Cannot issue a lease for ${capability.id}: ${capability.status}`,
      );
    }
    const lease: CapabilityLease = {
      capabilityId: capability.id,
      scopes: capability.scopes,
      expiresAt: expiresAt.toISOString(),
      status: "active",
    };
    this.leases.set(capability.id, lease);
    return lease;
  }

  get(capabilityId: string, now = new Date()): CapabilityLease | undefined {
    const lease = this.leases.get(capabilityId);
    if (!lease) return undefined;
    if (Date.parse(lease.expiresAt) <= now.getTime()) lease.status = "expired";
    return lease;
  }

  expireAll(): void {
    for (const lease of this.leases.values()) lease.status = "expired";
  }
}
