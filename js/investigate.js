// investigate.js — Quick Investigation + verdict logging (FR-001, FR-002).
// The garage-sale flow: type it, tap the comps, log buy/pass. Everything reads
// from cache and writes through the outbox; nothing here blocks on the network.

import * as gh from './githubStore.js';
import * as store from './store.js';
import * as outbox from './outbox.js';
import { ulid } from './ulid.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

// Fallbacks so the flow works before config ever syncs (offline first run).
const DEFAULT_PLATFORMS = [
  { id: 'ebay', label: 'eBay SOLD comps', emoji: '🏷️', urlTemplate: 'https://www.ebay.com/sch/i.html?_nkw={q}&LH_Sold=1&LH_Complete=1' },
  { id: 'fbm', label: 'FB Marketplace', emoji: '🛒', urlTemplate: 'https://www.facebook.com/marketplace/search/?query={q}' },
  { id: 'craigslist', label: 'Craigslist (Atlanta)', emoji: '📰', urlTemplate: 'https://atlanta.craigslist.org/search/sss?query={q}' },
  { id: 'offerup', label: 'OfferUp (buy side)', emoji: '🤝', urlTemplate: 'https://offerup.com/search?q={q}' },
];

export const CATEGORIES = [
  ['electronics', 'Electronics'],
  ['musical', 'Musical gear'],
  ['tools', 'Tools & outdoor'],
  ['furniture', 'Furniture & home'],
  ['other', 'Other'],
];

// Pure: template + query → href list (exported for tests).
export function buildLinks(platforms, query) {
  const q = encodeURIComponent(query.trim());
  return platforms.map((p) => ({ ...p, href: p.urlTemplate.replace('{q}', q) }));
}

export const dollarsToCents = (s) => {
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export const centsToDollars = (c) => (c === null || c === undefined) ? '' : (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

let platforms = DEFAULT_PLATFORMS;
let lastSavedVerdictId = null;

async function loadPlatforms() {
  const cached = await store.metaGet('platforms');
  if (cached) platforms = cached;
  // Background refresh; never awaited by the UI flow.
  gh.readFile('config/platforms.json').then((r) => {
    if (r.ok && r.json.platforms) {
      platforms = r.json.platforms;
      store.metaSet('platforms', platforms);
    }
  }).catch(() => {});
}

function renderLinks() {
  const q = $('invName').value.trim();
  if (!q) { toast('Type or dictate the item first'); return; }
  const box = $('invLinks');
  box.innerHTML = '';
  buildLinks(platforms, q).forEach((p) => {
    const a = document.createElement('a');
    a.className = 'linkbtn';
    a.href = p.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = `<span class="le">${p.emoji}</span> ${p.label}`;
    box.appendChild(a);
  });
  $('verdictCard').hidden = false;
  $('acquiredRow').hidden = true;
}

async function saveVerdict(verdict) {
  const itemName = $('invName').value.trim();
  if (!itemName) { toast('Item name first'); return; }
  const maxBuyCents = dollarsToCents($('invMaxBuy').value);
  if (verdict === 'buy' && maxBuyCents === null) { toast('Max-buy price makes a buy verdict useful'); return; }
  const id = ulid();
  const data = {
    id,
    itemName,
    category: $('invCategory').value,
    verdict,
    askingCents: dollarsToCents($('invAsking').value),
    maxBuyCents,
    reason: $('invReason').value.trim(),
    locationNote: $('invWhere').value.trim(),
    createdAt: new Date().toISOString(),
    promotedToItem: null,
  };
  await outbox.enqueueRecord('verdicts', id, data);
  lastSavedVerdictId = id;
  toast(verdict === 'buy' ? 'Buy verdict saved 💪' : 'Pass logged, price book grows');
  if (verdict === 'buy') $('acquiredRow').hidden = false;
  renderRecent();
}

async function renderRecent() {
  const rows = await store.getAll('verdicts');
  rows.sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1));
  const box = $('invRecent');
  box.innerHTML = '';
  rows.slice(0, 5).forEach((r) => {
    const d = r.data;
    const div = document.createElement('div');
    div.className = 'recent-row';
    div.innerHTML = `<b class="${d.verdict === 'buy' ? 'v-buy' : 'v-pass'}">${d.verdict === 'buy' ? 'BUY' : 'PASS'}</b>
      <span class="rn">${d.itemName}</span>
      <span class="rp">${d.maxBuyCents !== null ? 'max ' + centsToDollars(d.maxBuyCents) : ''}</span>
      ${r.pending ? '<span class="rpend">●</span>' : ''}`;
    box.appendChild(div);
  });
}

function clearForm() {
  ['invName', 'invAsking', 'invMaxBuy', 'invReason', 'invWhere'].forEach((i) => { $(i).value = ''; });
  $('invLinks').innerHTML = '';
  $('verdictCard').hidden = true;
  $('acquiredRow').hidden = true;
  $('invName').focus();
}

export function init(showView) {
  loadPlatforms();
  $('btnInvestigate').addEventListener('click', renderLinks);
  $('btnAiPrompt').addEventListener('click', async () => {
    const hint = $('invName').value.trim();
    const prompt = 'I am at a thrift store or garage sale deciding whether to buy this item to resell (photo attached). Tell me: '
      + '1) Exactly what it is: brand, model, and what to look for on the label to confirm. '
      + '2) What it actually sells for USED right now, based on eBay SOLD listings, not asking prices. '
      + '3) Common problems or fakes to check before buying. '
      + '4) My max buy price if I want to at least double my money after fees.'
      + (hint ? ' Item hint: ' + hint + '.' : '');
    try {
      await navigator.clipboard.writeText(prompt);
      toast('Prompt copied: open Claude, add your photo, paste');
    } catch (e) {
      toast('Could not reach the clipboard, try again');
    }
  });
  $('invName').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderLinks(); });
  $('btnVerdictBuy').addEventListener('click', () => saveVerdict('buy'));
  $('btnVerdictPass').addEventListener('click', () => saveVerdict('pass'));
  $('btnNewInv').addEventListener('click', clearForm);
  $('btnAcquired').addEventListener('click', () => {
    sessionStorage.setItem('fs.pendingAcquire', lastSavedVerdictId || '');
    showView('inventory');
    toast('Item records arrive in story 3.1 — verdict is safe in the price book');
  });
  const sel = $('invCategory');
  CATEGORIES.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  });
  renderRecent();
  window.addEventListener('outbox:change', renderRecent);
}
