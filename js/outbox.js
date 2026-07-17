// outbox.js — durable write queue + flush + FLIP-#### counter CAS (ADR-004/005/006).
// Every write in the app goes: mirror first (instant UI), outbox second, then
// background flush to the private repo. Idempotent under retry: one file per
// record at a deterministic ULID path; the counter is the single CAS exception.

import * as store from './store.js';
import * as gh from './githubStore.js';

const COUNTER_PATH = 'data/counter.json';
let flushing = null; // single-flight guard

function emit() {
  store.outboxCount().then((n) => {
    window.dispatchEvent(new CustomEvent('outbox:change', { detail: { pending: n } }));
  });
}

export function pendingCount() {
  return store.outboxCount();
}

// ---- enqueue ----

// Generic record write (verdicts, item updates). collection: 'verdicts'|'items'.
export async function enqueueRecord(collection, id, data) {
  await store.upsertLocal(collection, id, data, { pending: true });
  await store.outboxAdd({ type: 'record', collection, id, path: `data/${collection}/${id}.json` });
  emit();
  scheduleFlush();
}

// Item CREATE with provisional FLIP-#### (ADR-005): number = last synced
// counter + count of pending creates ahead of this one.
export async function enqueueItemCreate(id, data) {
  const base = (await store.metaGet('counter')) || { nextFlip: 1, sha: null };
  const ops = await store.outboxAll();
  const pendingCreates = ops.filter((o) => o.type === 'itemCreate').length;
  const n = base.nextFlip + pendingCreates;
  data.flipId = 'FLIP-' + String(n).padStart(4, '0');
  data.idProvisional = true;
  await store.upsertLocal('items', id, data, { pending: true });
  await store.outboxAdd({ type: 'itemCreate', collection: 'items', id, path: `data/items/${id}.json` });
  emit();
  scheduleFlush();
  return data.flipId;
}

// ---- renumber (pure logic, exported for tests) ----
// Given fresh counter value and pending create ops in FIFO order, returns
// [{id, flipId}] with final sequential numbers.
export function renumber(freshNext, createOpsInOrder) {
  return createOpsInOrder.map((op, i) => ({
    id: op.id,
    flipId: 'FLIP-' + String(freshNext + i).padStart(4, '0'),
  }));
}

// ---- flush ----

export function scheduleFlush() {
  if (navigator.onLine) flush().catch(() => {});
}

export async function flush() {
  if (flushing) return flushing;
  flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  if (!navigator.onLine || !gh.hasToken()) return { done: false, reason: 'offline' };
  let ops = await store.outboxAll();
  if (!ops.length) { emit(); return { done: true, flushed: 0 }; }
  ops.sort((a, b) => a.seq - b.seq);

  // Phase 1: commit the counter for any pending item creates (CAS loop, ADR-005).
  const creates = ops.filter((o) => o.type === 'itemCreate');
  if (creates.length) {
    const committed = await commitCounter(creates);
    if (!committed) { setError('counter'); return { done: false, reason: 'counter' }; }
    // Numbers are final now: clear provisional flags locally before upload.
    for (const op of creates) {
      const rec = await store.get('items', op.id);
      if (rec && rec.data.idProvisional) {
        rec.data.idProvisional = false;
        await store.upsertLocal('items', op.id, rec.data, { pending: true, sha: rec.sha });
      }
    }
  }

  // Phase 2: upload records FIFO, last-write-wins per file.
  let flushed = 0;
  for (const op of ops) {
    const rec = await store.get(op.collection, op.id);
    if (!rec) { await store.outboxDelete(op.seq); continue; }
    let r = await gh.writeFile(op.path, rec.data, rec.sha || undefined);
    if (!r.ok && r.kind === 'conflict') {
      // File exists or sha stale: fetch current sha, overwrite (single user, LWW).
      const cur = await gh.readFile(op.path);
      if (cur.ok) r = await gh.writeFile(op.path, rec.data, cur.sha);
    }
    if (!r.ok) {
      if (r.kind === 'offline') { emit(); return { done: false, reason: 'offline', flushed }; }
      setError(r.kind);
      emit();
      return { done: false, reason: r.kind, flushed };
    }
    await store.markSynced(op.collection, op.id, r.data && r.data.content ? r.data.content.sha : null);
    await store.outboxDelete(op.seq);
    flushed++;
  }
  clearError();
  emit();
  return { done: true, flushed };
}

// CAS loop: PUT counter with known sha; on conflict re-read, renumber pending
// provisional items, retry. Max 5 attempts.
async function commitCounter(creates) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let cached = (await store.metaGet('counter')) || { nextFlip: 1, sha: null };
    if (attempt > 0 || cached.sha === null) {
      const cur = await gh.readFile(COUNTER_PATH);
      if (cur.ok) {
        const fresh = { nextFlip: cur.json.nextFlip, sha: cur.sha };
        if (fresh.nextFlip !== cached.nextFlip) {
          const renums = renumber(fresh.nextFlip, creates);
          for (const rn of renums) {
            const rec = await store.get('items', rn.id);
            if (rec) {
              rec.data.flipId = rn.flipId;
              await store.upsertLocal('items', rn.id, rec.data, { pending: true, sha: rec.sha });
            }
          }
        }
        cached = fresh;
        await store.metaSet('counter', cached);
      } else if (cur.kind === 'notfound') {
        cached = { nextFlip: 1, sha: null }; // first ever sync; counter seeded at repo init
      } else {
        return false;
      }
    }
    const newVal = { nextFlip: cached.nextFlip + creates.length };
    const r = await gh.writeFile(COUNTER_PATH, newVal, cached.sha || undefined);
    if (r.ok) {
      await store.metaSet('counter', { nextFlip: newVal.nextFlip, sha: r.data.content.sha });
      return true;
    }
    if (r.kind !== 'conflict') return false;
    // conflict → loop re-reads and renumbers
  }
  return false;
}

// ---- hydration: repo → mirror (reads only ever come from the mirror) ----
export async function hydrate() {
  if (!navigator.onLine || !gh.hasToken()) return { done: false };
  const t = await gh.listTree('data/');
  if (!t.ok) return { done: false };
  for (const f of t.files) {
    const m = f.path.match(/^data\/(verdicts|items)\/(.+)\.json$/);
    if (m) {
      const [, collection, id] = m;
      const existing = await store.get(collection, id);
      if (existing && (existing.sha === f.sha || existing.pending)) continue; // pending local wins
      const r = await gh.readFile(f.path);
      if (r.ok) await store.upsertLocal(collection, id, r.json, { pending: false, sha: f.sha });
    } else if (f.path === COUNTER_PATH) {
      const cached = (await store.metaGet('counter')) || {};
      if (cached.sha !== f.sha) {
        const r = await gh.readFile(COUNTER_PATH);
        if (r.ok) await store.metaSet('counter', { nextFlip: r.json.nextFlip, sha: r.sha });
      }
    }
  }
  return { done: true };
}

// Full sync = push queue, then pull changes.
export async function sync() {
  const f = await flush();
  await hydrate();
  emit();
  return f;
}

// ---- error state for the pill ----
let lastError = null;
function setError(kind) { lastError = kind; window.dispatchEvent(new CustomEvent('outbox:error', { detail: { kind } })); }
function clearError() {
  if (lastError) { lastError = null; window.dispatchEvent(new CustomEvent('outbox:error', { detail: { kind: null } })); }
}
export function getError() { return lastError; }
