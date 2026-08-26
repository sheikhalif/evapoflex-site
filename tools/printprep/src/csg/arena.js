/**
 * Lifetime management for manifold WASM objects.
 *
 * Manifold objects live in the WASM heap and are not garbage collected. Every
 * operation that returns a Manifold - including transforms, which look free -
 * allocates a new one, so a hundred-boolean build leaks a hundred objects
 * unless each is deleted. Doing that by hand at every call site is how this
 * project would die: one missed delete in one branch and a long session ends in
 * an out-of-memory crash halfway through a split.
 *
 * So it is structural instead. Objects enter a scope when they are created and
 * the whole scope is released at once; anything that must outlive the scope is
 * explicitly promoted with retain(). The only discipline required at a call site
 * is "wrap the job in a scope", which is done once per RPC handler.
 */

const EMPTY = 0;
let nextId = 1;

const live = new Map();      // id -> {obj, kind}
const scopes = [];           // stack of Set<id>

export function beginScope() { scopes.push(new Set()); }

/** Register a freshly created WASM object and return its handle id. */
export function track(obj, kind = 'manifold') {
  const id = nextId++;
  live.set(id, { obj, kind });
  if (scopes.length) scopes[scopes.length - 1].add(id);
  return id;
}

/** Move a handle out of the current scope so it survives endScope(). */
export function retain(id) {
  if (!scopes.length) return id;
  scopes[scopes.length - 1].delete(id);
  if (scopes.length > 1) scopes[scopes.length - 2].add(id);
  return id;
}

export function endScope() {
  const s = scopes.pop();
  if (!s) return;
  for (const id of s) release(id);
}

export function release(id) {
  const e = live.get(id);
  if (!e) return;
  live.delete(id);
  for (const s of scopes) s.delete(id);
  try { e.obj.delete(); } catch { /* already gone */ }
}

/** Resolve a handle. Throws loudly rather than returning a dangling object. */
export function M(id) {
  const e = live.get(id);
  if (!e) { const err = new Error(`dead manifold handle ${id}`); err.code = 'dead_handle'; throw err; }
  return e.obj;
}

export function has(id) { return live.has(id); }

export function stats() {
  const byKind = {};
  for (const [, e] of live) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { liveHandles: live.size, openScopes: scopes.length, byKind };
}

/**
 * Run a job inside a scope. Whatever the job returns is scanned for handle ids
 * under a `keep` key and those are promoted; everything else the job allocated
 * dies with the scope.
 */
export async function inScope(fn) {
  beginScope();
  try {
    const out = await fn();
    if (out && out.__keep) for (const id of out.__keep) retain(id);
    return out;
  } finally {
    endScope();
  }
}
