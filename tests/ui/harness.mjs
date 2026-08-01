// harness.mjs — boots the real app against a real DOM built from the real
// index.html, so tests can assert what is ON SCREEN rather than what a function
// returns.
//
// Why this exists: FLIP-0001 genuinely sold for $140 and sat unrecorded for
// days because the "Sold…" button was gated to `listed` items and the item was
// `acquired`. Every money fixture was green the whole time — the math was
// perfect, the button just was not there. Pure fixtures cannot catch that
// class of bug by construction. This can.
//
// Kept apart from tests/settlement.test.mjs on purpose: that one stays
// framework-free and install-free (`node tests/settlement.test.mjs`, no npm).
// This one costs `npm i` and lives behind it.
//
// KNOWN BLIND SPOT — do not trust this harness for CSS.
// jsdom resolves `[hidden]` with UA priority, so `getComputedStyle(el).display`
// returns 'none' for a hidden element even when an author rule like
// `.fb-overlay { display: flex }` would keep it visible in a real browser. That
// exact bug shipped in v23 and this harness passed 29 assertions over the top of
// it, because `el.hidden` reads the property and the property was correct.
// The pixels were not. Guarded statically in tests/shell-manifest.test.mjs, but
// the real lesson stands: this proves wiring and data, never appearance. Look at
// the app in a browser before shipping.

import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');

export const appModule = (f) => pathToFileURL(path.join(APP, 'js', f)).href;
export const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// Everything confirm() was asked, so a test can prove the destructive prompt
// fired and read what it said.
export const confirms = [];

export async function boot(items = []) {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.location = window.location;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.confirm = (msg) => { confirms.push(msg); return true; };
  // No network in tests. githubStore's callers all tolerate a rejected fetch.
  globalThis.fetch = () => Promise.reject(new Error('no network in tests'));
  window.navigator.clipboard = { writeText: async () => {} };

  // Signed in, so boot() shows the shell rather than the sign-in screen.
  localStorage.setItem('fs.token', 'test-token');
  localStorage.setItem('fs.owner', 'test-owner');
  localStorage.setItem('fs.repo', 'test-repo');
  localStorage.setItem('fs.lastView', 'inventory');

  const store = await import(appModule('store.js'));
  for (const d of items) await store.upsertLocal('items', d.id, d, { pending: false });

  await import(appModule('ui.js'));   // boots the app
  await tick(300);

  const $ = (id) => window.document.getElementById(id);
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));

  // Open an item's detail view the way Ben does: by tapping its row.
  const openItem = async (flipId) => {
    const row = [...$('itemRows').querySelectorAll('.item-row')]
      .find((r) => r.querySelector('.ir-flip')?.textContent.trim() === flipId);
    if (!row) throw new Error(`no row on screen for ${flipId}`);
    click(row);
    await tick(200);
  };

  // The labels of every action button currently offered on the open item.
  const actionLabels = () => [...$('detActions').querySelectorAll('button')].map((b) => b.textContent);

  return { window, store, $, click, change, openItem, actionLabels };
}

// ---------- assertions ----------
let pass = 0;
const fails = [];

export function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     expected ${e}\n     got      ${a}`);
}

export function report(what) {
  if (fails.length) {
    console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
    fails.forEach((f) => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`✓ ${pass} ${what}`);
  process.exit(0);
}

// ---------- item builders ----------
export function anItem(over = {}) {
  return {
    id: 'x', flipId: 'FLIP-0000', name: 'An item', status: 'acquired',
    category: 'musical', costCents: 5000, acquisition: 'bought',
    partners: [], payments: [], listings: [], shotChecks: [], copyFields: {},
    sale: null, priceQuickCents: 6000, pricePatientCents: 9000,
    createdAt: '2026-07-01T00:00:00Z', statusChangedAt: '2026-07-01T00:00:00Z',
    ...over,
  };
}

export function aSale(priceCents, soldAt = '2026-08-05', feesCents = 0) {
  return { platform: 'fbm', priceCents, feesCents, soldAt };
}
