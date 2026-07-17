// investigate.js — the Research tab (slimmed v17, FLIP-D17).
// Ben's real workflow: AI identifies, eBay SOLD verifies, then straight into
// Inventory. No verdict diary, no price book (Ben: "it's an inventory and
// profit tracker"). Verdict/pricebook code retired 2026-07-17; git history
// has it if the need ever returns.

import * as gh from './githubStore.js';
import * as store from './store.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

// Fallbacks so links work before config ever syncs (offline first run).
const DEFAULT_PLATFORMS = [
  { id: 'ebay', label: 'eBay SOLD comps', emoji: '🏷️', urlTemplate: 'https://www.ebay.com/sch/i.html?_nkw={q}&LH_Sold=1&LH_Complete=1' },
  { id: 'google', label: 'Google it', emoji: '🔎', urlTemplate: 'https://www.google.com/search?q={q}' },
  { id: 'fbm', label: 'FB Marketplace', emoji: '🛒', urlTemplate: 'https://www.facebook.com/marketplace/search/?query={q}' },
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

async function loadPlatforms() {
  const cached = await store.metaGet('platforms');
  if (cached) platforms = cached;
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
}

export function init(showView) {
  loadPlatforms();
  $('btnInvestigate').addEventListener('click', renderLinks);
  $('invName').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderLinks(); });

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

  // The bridge Ben actually uses: research done → new item, name pre-filled.
  $('btnResearchAdd').addEventListener('click', () => {
    const name = $('invName').value.trim();
    if (name) sessionStorage.setItem('fs.prefillName', name);
    showView('inventory');
  });
}
