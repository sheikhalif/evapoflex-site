/**
 * Promise-based RPC over postMessage, with progress and cancellation.
 *
 * Envelope: {rid, type, payload} out, {rid, ok, result|error} back, plus
 * {rid, progress:{stage, frac, note}} in between. One shape for both workers so
 * the calling code does not care which side of the wire a job runs on.
 */

export function makeClient(worker, { onLog } = {}) {
  const pending = new Map();
  let nextRid = 1;

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.log) { onLog?.(m.log); return; }
    const entry = pending.get(m.rid);
    if (!entry) return;
    if (m.progress) { entry.onProgress?.(m.progress); return; }
    pending.delete(m.rid);
    if (m.ok) entry.resolve(m.result);
    else {
      const err = new Error(m.error?.message || 'worker failed');
      err.code = m.error?.code;
      err.workerStack = m.error?.stack;
      entry.reject(err);
    }
  };
  worker.onerror = (e) => {
    // A module-level throw in the worker never reaches onmessage, so every
    // outstanding call would hang forever. Fail them all loudly instead.
    const err = new Error('worker crashed: ' + (e.message || 'unknown'));
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
  };

  function call(type, payload, { transfer = [], onProgress } = {}) {
    const rid = nextRid++;
    return Object.assign(new Promise((resolve, reject) => {
      pending.set(rid, { resolve, reject, onProgress });
      worker.postMessage({ rid, type, payload }, transfer);
    }), { rid, cancel: () => worker.postMessage({ rid, type: '__cancel' }) });
  }

  return { call, worker, terminate: () => worker.terminate(), get inflight() { return pending.size; } };
}

/**
 * Worker side. Handlers are `async (payload, ctx) => result`, where ctx carries
 * `progress(stage, frac, note)`, `cancelled()` and `transfer(list)` for
 * zero-copy returns.
 */
export function serve(handlers) {
  const cancelled = new Set();
  self.onmessage = async (e) => {
    const { rid, type, payload } = e.data;
    if (type === '__cancel') { cancelled.add(rid); return; }
    const fn = handlers[type];
    if (!fn) {
      self.postMessage({ rid, ok: false, error: { code: 'no_handler', message: `no handler for ${type}` } });
      return;
    }
    let transfer = [];
    const ctx = {
      progress: (stage, frac, note) => self.postMessage({ rid, progress: { stage, frac, note } }),
      cancelled: () => cancelled.has(rid),
      transfer: (list) => { transfer = list; },
      log: (msg) => self.postMessage({ log: msg }),
    };
    try {
      const result = await fn(payload, ctx);
      self.postMessage({ rid, ok: true, result }, transfer);
    } catch (err) {
      self.postMessage({ rid, ok: false, error: { code: err.code || 'error', message: String(err && err.message || err), stack: err && err.stack } });
    } finally {
      cancelled.delete(rid);
    }
  };
}

/**
 * Chunked loop helper. Long passes must yield or the worker cannot see a cancel
 * message and cannot report progress. Yields roughly every 16 ms.
 */
export async function chunked(total, step, ctx, stage) {
  let i = 0, t = performance.now();
  while (i < total) {
    i = step(i);
    if (performance.now() - t > 16) {
      if (ctx?.cancelled()) { const e = new Error('cancelled'); e.code = 'cancelled'; throw e; }
      ctx?.progress(stage, i / total);
      await new Promise((r) => setTimeout(r, 0));
      t = performance.now();
    }
  }
}
