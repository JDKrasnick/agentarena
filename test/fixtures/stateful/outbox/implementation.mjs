export function createOutbox({
  store,
  send,
  now = Date.now,
  leaseMs = 10,
  baseDelayMs = 2,
  maxDelayMs = 32,
}) {
  return {
    async enqueue(id, payload) {
      return store.transaction((rows) => {
        if (rows.has(id)) return false;
        rows.set(id, {
          id,
          payload,
          status: "pending",
          createdAt: now(),
          nextAt: now(),
          attempt: 0,
        });
        return true;
      });
    },
    async runOne() {
      const record = await store.transaction((rows) => {
        const record = [...rows.values()].find(
          (r) => r.status === "pending" && r.nextAt <= now(),
        );
        if (!record) return null;
        record.status = "sending";
        record.attempt++;
        record.leaseUntil = now() + leaseMs;
        return { ...record };
      });
      if (!record) return false;
      try {
        await send(record.payload, { id: record.id, attempt: record.attempt });
        await store.transaction((rows) => {
          rows.get(record.id).status = "done";
        });
      } catch (error) {
        await store.transaction((rows) => {
          const r = rows.get(record.id);
          r.status = "pending";
          r.nextAt = now() + baseDelayMs;
        });
      }
      return true;
    },
    async stats() {
      return store.transaction((rows) => {
        const counts = { pending: 0, sending: 0, done: 0 };
        for (const record of rows.values()) counts[record.status]++;
        return counts;
      });
    },
  };
}
