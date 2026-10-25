Harden the existing asynchronous LRU cache without changing the exported createCache API.
createCache({load, maxEntries=2, ttlMs=10, now=Date.now}) returns {get, peek, set, invalidate, clear, size}.
The keys are arbitrary strings, including empty and prototype-property names. Values may be anything, including undefined.
get(key) returns a promise. Concurrent misses for a key share one load; a synchronous load throw is a rejection.
Only successfully resolved entries count against maxEntries. Evict least-recently-used settled entries, and make successful get/peek/set accesses most recent. peek never loads.
TTL starts on successful settlement or set, and expires exactly at elapsed >= ttlMs; ttlMs=0 disables caching but still coalesces in-flight requests. peek and size must exclude expired entries; querying size must not change recency.
Failures never cache, and every caller must settle. invalidate(key) and clear() remove settled and in-flight membership immediately but do not cancel existing callers.
An old load resolving/rejecting after invalidate, clear, or set must neither repopulate the cache nor delete/overwrite a newer in-flight or settled value. A new get after invalidation starts a new load.
set(key,value) overrides current membership, including in-flight membership; existing old callers still receive the result of their own load. set has the same TTL/eviction policy as loaded values.
Validate options eagerly: load and now functions, maxEntries positive safe integer, ttlMs finite nonnegative number. Invalid keys throw TypeError on synchronous methods and reject get without invoking load.
Preserve the dependency-free ESM API and add deterministic regression tests. No real sleeps, networking, or external packages are needed; use injected time and deferred promises.
