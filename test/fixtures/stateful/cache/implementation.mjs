export function createCache({
  load,
  maxEntries = 2,
  ttlMs = 10,
  now = Date.now,
}) {
  const entries = new Map();
  const pending = new Map();
  const peek = (key) => {
    const hit = entries.get(key);
    if (!hit || now() > hit.expires) return undefined;
    return hit.value;
  };
  const set = (key, value) => {
    entries.delete(key);
    entries.set(key, { value, expires: now() + ttlMs });
    while (entries.size > maxEntries)
      entries.delete(entries.keys().next().value);
  };
  return {
    async get(key) {
      const hit = peek(key);
      if (hit !== undefined) return hit;
      if (pending.has(key)) return pending.get(key);
      const request = Promise.resolve()
        .then(() => load(key))
        .then((value) => {
          set(key, value);
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
    peek,
    set,
    invalidate(key) {
      entries.delete(key);
      pending.delete(key);
    },
    clear() {
      entries.clear();
      pending.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
