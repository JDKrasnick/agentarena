export function createStore() {
  let rows = new Map();
  let tail = Promise.resolve();
  let nextFailure;
  return {
    failNext(error = new Error("store unavailable")) {
      nextFailure = error;
    },
    transaction(fn) {
      const result = tail.then(async () => {
        if (nextFailure) {
          const error = nextFailure;
          nextFailure = undefined;
          throw error;
        }
        const draft = structuredClone(rows);
        const result = await fn(draft);
        rows = draft;
        return structuredClone(result);
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}
