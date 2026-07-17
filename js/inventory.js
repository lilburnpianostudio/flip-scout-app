// inventory.js — item records, FLIP-#### IDs, promotion from verdicts,
// partner stakes, price tiers (story 3.1 / FR-004, FR-013, FR-014).
// Listings + sale close extend this module in story 3.2; pipeline view in 3.3.

import * as store from './store.js';
import * as outbox from './outbox.js';
import { ulid } from './ulid.js';
import { toast } from './ui.js';
import { CATEGORIES, dollarsToCents, centsToDollars } from './investigate.js';
import * as gh from './githubStore.js';
import { generate, generateTitle, FIELD_SETS } from './copywriter.js';

const $ = (id) => document.getElementById(id);

// Forward-only lifecycle (ADR-010). 'sold' entry happens via sale close (3.2).
export const TRANSITIONS = {
  scouted: ['acquired', 'dead'],
  acquired: ['listed', 'dead'],
  listed: ['sold', 'dead'],
  sold: [],
  dead: [],
};

export function sharesTotal(partners) {
  return (partners || []).reduce((s, p) => s + (Number(p.sharePct) || 0), 0);
}

// Margin is DERIVED, never stored (architecture §5). Integer-cent math.
export function computeMargin(d) {
  if (!d.sale || d.sale.priceCents == null) return null;
  return d.sale.priceCents - (d.costCents || 0) - (d.sale.feesCents || 0);
}

// Per-partner payouts from a margin (FR-013): round(margin × share% / 100).
export function partnerPayouts(marginCents, partners) {
  return (partners || [])
    .filter((p) => p.name && Number(p.sharePct) > 0)
    .map((p) => ({ name: p.name, payoutCents: Math.round(marginCents * Number(p.sharePct) / 100) }));
}

// Payout preview for an UNSOLD item at a hypothetical sale price (FLIP-D10).
export function previewAt(d, priceCents) {
  const margin = priceCents - (d.costCents || 0);
  return { marginCents: margin, payouts: partnerPayouts(margin, d.partners) };
}

const SELL_PLATFORMS = [['fbm', 'FB Marketplace'], ['ebay', 'eBay'], ['offerup', 'OfferUp (existing)']];
const platformLabel = (id) => (SELL_PLATFORMS.find(([v]) => v === id) || [id, id])[1];

let editingId = null; // ulid of item being edited, null = creating

function blankItem() {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    flipId: null,
    idProvisional: true,
    name: '',
    category: 'other',
    status: 'acquired',
    source: '',
    costCents: null,
    acquiredAt: now.slice(0, 10),
    fromVerdict: null,
    listings: [],
    sale: null,
    copyFields: {},
    shotChecks: [],
    partners: [],
    priceQuickCents: null,
    pricePatientCents: null,
    notes: '',
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
  };
}

// ---------- subview plumbing ----------
function sub(name) {
  ['invList', 'invForm', 'invDetail'].forEach((s) => { $(s).hidden = s !== name; });
}

// ---------- pipeline list (story 3.3 / FR-005) ----------
export function flipLabel(d) {
  if (!d.flipId) return '…';
  return d.flipId + (d.idProvisional ? '*' : '');
}

export function daysIn(sinceIso, now = Date.now()) {
  if (!sinceIso) return 0;
  return Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 86400000));
}

// Aggregates, derived on render — never cached (ADR-006).
export function computeTotals(items) {
  let investedCents = 0;
  let realizedCents = 0;
  items.forEach((d) => {
    if (d.status === 'sold') {
      const m = computeMargin(d);
      if (m !== null) realizedCents += m;
    } else if (d.status !== 'dead' && d.costCents != null) {
      investedCents += d.costCents;
    }
  });
  return { investedCents, realizedCents };
}

function itemRow(r, extra) {
  const d = r.data;
  const el = document.createElement('div');
  el.className = 'item-row';
  el.innerHTML = `
    <span class="ir-flip">${flipLabel(d)}</span>
    <span class="ir-name">${esc(d.name)}${(d.partners && d.partners.length) ? ' <span title="partners on this deal">🤝</span>' : ''}</span>
    ${extra || ''}
    ${r.pending ? '<span class="rpend">●</span>' : ''}`;
  el.addEventListener('click', () => openDetail(d.id));
  return el;
}

async function renderList() {
  const rows = await store.getAll('items');
  const box = $('itemRows');
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<p class="hint">Nothing here yet. Already own something you want to flip? Tap <b>＋ New item</b> above and just type it in. (Investigate is only for deciding BEFORE you buy.)</p>';
    $('pipeTotals').hidden = true;
    return;
  }

  const totals = computeTotals(rows.map((r) => r.data));
  $('pipeTotals').hidden = false;
  $('pipeTotals').innerHTML = `
    <div><small>tied up in inventory</small><b>${centsToDollars(totals.investedCents)}</b></div>
    <div><small>realized profit</small><b class="${totals.realizedCents >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(totals.realizedCents)}</b></div>`;

  const bySt = { acquired: [], listed: [], scouted: [], sold: [], dead: [] };
  rows.forEach((r) => (bySt[r.data.status] || bySt.scouted).push(r));
  Object.values(bySt).forEach((g) => g.sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1)));

  [['acquired', 'To list'], ['listed', 'Listed, waiting on a buyer'], ['scouted', 'Scouted']].forEach(([st, label]) => {
    if (!bySt[st].length) return;
    const h = document.createElement('p');
    h.className = 'pipe-group';
    h.textContent = `${label} (${bySt[st].length})`;
    box.appendChild(h);
    bySt[st].forEach((r) => {
      const days = daysIn(r.data.statusChangedAt || r.data.updatedAt || r.data.createdAt);
      box.appendChild(itemRow(r, `<span class="ir-days">${days}d</span>`));
    });
  });

  if (bySt.sold.length || bySt.dead.length) {
    const det = document.createElement('details');
    det.className = 'pipe-history';
    det.innerHTML = `<summary>History: ${bySt.sold.length} sold · ${bySt.dead.length} dead</summary>`;
    bySt.sold.forEach((r) => {
      const m = computeMargin(r.data);
      det.appendChild(itemRow(r, `<span class="ir-days ${m >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(m)}</span>`));
    });
    bySt.dead.forEach((r) => det.appendChild(itemRow(r, '<span class="status-chip st-dead">dead</span>')));
    box.appendChild(det);
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- form (create / edit) ----------
let formPartners = [];

function openForm(prefill) {
  editingId = prefill && prefill.id ? prefill.id : null;
  const d = prefill || blankItem();
  $('itName').value = d.name || '';
  $('itCategory').value = d.category || 'other';
  $('itSource').value = d.source || '';
  $('itCost').value = d.costCents != null ? (d.costCents / 100) : '';
  $('itAcquiredAt').value = d.acquiredAt || new Date().toISOString().slice(0, 10);
  $('itQuick').value = d.priceQuickCents != null ? (d.priceQuickCents / 100) : '';
  $('itPatient').value = d.pricePatientCents != null ? (d.pricePatientCents / 100) : '';
  $('itDesc').value = d.description || '';
  $('itNotes').value = d.notes || '';
  formPartners = (d.partners || []).map((p) => ({ ...p }));
  renderPartners();
  $('invFormTitle').textContent = editingId ? `Edit ${flipLabel(d)}` : 'New item';
  sub('invForm');
}

function renderPartners() {
  const box = $('partnerRows');
  box.innerHTML = '';
  formPartners.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'partner-row';
    row.innerHTML = `
      <input type="text" placeholder="name" value="${esc(p.name)}" data-pf="name" data-i="${i}">
      <input type="text" inputmode="numeric" placeholder="%" value="${p.sharePct || ''}" data-pf="sharePct" data-i="${i}">
      <input type="text" inputmode="decimal" placeholder="$ in" value="${p.investedCents != null ? p.investedCents / 100 : ''}" data-pf="invested" data-i="${i}">
      <button type="button" class="btn btn-ghost btn-small" data-prm="${i}">✕</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.i);
      if (inp.dataset.pf === 'name') formPartners[i].name = inp.value;
      if (inp.dataset.pf === 'sharePct') formPartners[i].sharePct = parseInt(inp.value, 10) || 0;
      if (inp.dataset.pf === 'invested') formPartners[i].investedCents = dollarsToCents(inp.value);
      warnShares();
    });
  });
  box.querySelectorAll('[data-prm]').forEach((b) => {
    b.addEventListener('click', () => { formPartners.splice(Number(b.dataset.prm), 1); renderPartners(); });
  });
  warnShares();
}

function warnShares() {
  const total = sharesTotal(formPartners);
  const w = $('shareWarn');
  w.hidden = total <= 100;
  if (total > 100) w.textContent = `Heads up: shares add to ${total}%. Allowed, but that's more than the margin.`;
}

async function saveForm() {
  const name = $('itName').value.trim();
  if (!name) { toast('Item needs a name'); return; }
  const existing = editingId ? await store.get('items', editingId) : null;
  const d = existing ? { ...existing.data } : blankItem();
  const now = new Date().toISOString();
  d.name = name;
  d.category = $('itCategory').value;
  d.source = $('itSource').value.trim();
  d.costCents = dollarsToCents($('itCost').value);
  d.acquiredAt = $('itAcquiredAt').value || d.acquiredAt;
  d.priceQuickCents = dollarsToCents($('itQuick').value);
  d.pricePatientCents = dollarsToCents($('itPatient').value);
  d.description = $('itDesc').value.trim();
  d.notes = $('itNotes').value.trim();
  d.partners = formPartners.filter((p) => p.name && p.name.trim());
  d.updatedAt = now;

  if (existing) {
    await outbox.enqueueRecord('items', d.id, d);
    toast('Saved');
  } else {
    const pending = sessionStorage.getItem('fs.pendingAcquire');
    if (pending && !d.fromVerdict) d.fromVerdict = pendingVerdictId || null;
    const flip = await outbox.enqueueItemCreate(d.id, d);
    if (d.fromVerdict) {
      const v = await store.get('verdicts', d.fromVerdict);
      if (v) {
        v.data.promotedToItem = d.id;
        await outbox.enqueueRecord('verdicts', d.fromVerdict, v.data);
      }
      sessionStorage.removeItem('fs.pendingAcquire');
      pendingVerdictId = null;
    }
    toast(`${flip}* is born 🎉`);
  }
  renderList();
  sub('invList');
}

// ---------- detail ----------
let detailId = null;

async function openDetail(id) {
  const r = await store.get('items', id);
  if (!r) return;
  detailId = id;
  const d = r.data;
  $('detTitle').textContent = `${flipLabel(d)} · ${d.name}`;
  const rows = [];
  rows.push(['Status', `<span class="status-chip st-${d.status}">${d.status}</span>${d.idProvisional ? ' <small>(number locks at sync)</small>' : ''}`]);
  if (d.costCents != null) rows.push(['Cost', centsToDollars(d.costCents)]);
  if (d.source) rows.push(['From', esc(d.source)]);
  rows.push(['Acquired', d.acquiredAt || '']);
  if (d.priceQuickCents != null) rows.push(['Quick-sale price', centsToDollars(d.priceQuickCents)]);
  if (d.pricePatientCents != null) rows.push(['Patient price', centsToDollars(d.pricePatientCents)]);
  if (d.partners && d.partners.length) {
    rows.push(['Partners', d.partners.map((p) => `${esc(p.name)} ${p.sharePct || 0}%${p.investedCents != null ? ' (' + centsToDollars(p.investedCents) + ' in)' : ''}`).join('<br>')]);
  }
  if (d.listings && d.listings.length) {
    rows.push(['Listed on', d.listings.map((l) => `${platformLabel(l.platform)} · ${centsToDollars(l.priceCents)} · ${l.listedAt || ''}${l.url ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">open</a>` : ''}`).join('<br>')]);
  }
  if (d.sale) {
    rows.push(['Sold', `${platformLabel(d.sale.platform)} · ${centsToDollars(d.sale.priceCents)} · ${d.sale.soldAt || ''}${d.sale.feesCents ? ' · fees ' + centsToDollars(d.sale.feesCents) : ''}`]);
    const m = computeMargin(d);
    rows.push(['Margin', `<b class="${m >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(m)}</b>`]);
    partnerPayouts(m, d.partners).forEach((p) => rows.push(['→ ' + esc(p.name), centsToDollars(p.payoutCents)]));
  } else if (d.partners && d.partners.length && d.status !== 'dead') {
    // Negotiation table (FLIP-D10): what each partner makes at each tier.
    const tiers = [['quick', d.priceQuickCents], ['patient', d.pricePatientCents]].filter(([, c]) => c != null);
    tiers.forEach(([label, cents]) => {
      const pv = previewAt(d, cents);
      const lines = [`margin ${centsToDollars(pv.marginCents)}`]
        .concat(pv.payouts.map((p) => `${esc(p.name)} makes ${centsToDollars(p.payoutCents)}`));
      rows.push([`If sold ${label} (${centsToDollars(cents)})`, lines.join('<br>')]);
    });
  }
  if (d.description) rows.push(['Description', `<span class="copy-text" style="display:block;">${esc(d.description)}</span>`]);
  if (d.notes) rows.push(['Notes', esc(d.notes)]);
  $('detRows').innerHTML = rows.map(([k, v]) => `<div class="det-row"><span>${k}</span><div>${v}</div></div>`).join('');

  $('listingForm').hidden = true;
  $('saleForm').hidden = true;
  $('copySection').hidden = true;
  renderShotlist(d);

  const btns = $('detActions');
  btns.innerHTML = '';
  const addBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    btns.appendChild(b);
  };
  if (d.name) addBtn('📋 Copy title', 'btn-ghost', (e) => copyToClipboard(d.name, e.target));
  if (d.description) addBtn('📋 Copy description', 'btn-ghost', (e) => copyToClipboard(d.description, e.target));
  if (d.status === 'scouted') addBtn('Mark acquired', 'btn-primary', () => advanceStatus(d.id, 'acquired'));
  if (d.status === 'acquired' || d.status === 'listed') {
    addBtn('📝 Listing copy', 'btn-primary', () => openCopySection(d));
    addBtn('＋ Add listing', 'btn-primary', () => openListingForm(d));
  }
  if (d.status === 'listed') addBtn('💰 Sold…', 'btn-buy', () => openSaleForm(d));
  if (d.status !== 'sold' && d.status !== 'dead') addBtn('Mark dead', 'btn-pass', () => advanceStatus(d.id, 'dead'));
  sub('invDetail');
}

// ---------- listing copy (story 4.2 / FR-006, FR-014) ----------
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ✓ paste it in the app');
  } catch (e) {
    // Fallback: selected textarea + one more tap (older Safari states).
    const ta = $('copyFallback');
    ta.hidden = false;
    ta.value = text;
    ta.focus();
    ta.select();
    toast('Clipboard blocked: text is selected below, tap Copy on the keyboard');
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
}

function copyFields(d) {
  const out = { ...(d.copyFields || {}) };
  const set = FIELD_SETS[d.category] || FIELD_SETS.other;
  set.forEach(([key]) => {
    const el = document.getElementById('cf_' + key);
    if (el) out[key] = el.value.trim();
  });
  out.name = d.name;
  out.seed = d.id;
  const tier = $('copyTier').value;
  out.priceCents = tier === 'quick' ? d.priceQuickCents : tier === 'patient' ? d.pricePatientCents : dollarsToCents($('copyCustom').value);
  return out;
}

function openCopySection(d) {
  $('copySection').hidden = false;
  $('listingForm').hidden = true;
  $('saleForm').hidden = true;
  const set = FIELD_SETS[d.category] || FIELD_SETS.other;
  $('copyFieldRows').innerHTML = set.map(([key, label]) =>
    `<label class="field"><span>${label}</span><input type="text" id="cf_${key}" value="${esc((d.copyFields || {})[key] || '')}"></label>`
  ).join('');
  const tierSel = $('copyTier');
  tierSel.innerHTML = [
    d.priceQuickCents != null ? `<option value="quick">Quick ${centsToDollars(d.priceQuickCents)}</option>` : '',
    d.pricePatientCents != null ? `<option value="patient" selected>Patient ${centsToDollars(d.pricePatientCents)}</option>` : '',
    '<option value="custom">Custom price…</option>',
  ].join('');
  $('copyCustom').hidden = tierSel.value !== 'custom';
  $('copyOut').hidden = true;
  $('copyFallback').hidden = true;
}

async function generateCopy() {
  const r = await store.get('items', detailId);
  if (!r) return;
  const d = r.data;
  const f = copyFields(d);
  // Persist the fields so regenerating later is instant (description itself is
  // never stored; regenerate on demand per architecture §5).
  const now = new Date().toISOString();
  d.copyFields = { ...f };
  delete d.copyFields.priceCents;
  delete d.copyFields.seed;
  delete d.copyFields.name;
  d.updatedAt = now;
  await outbox.enqueueRecord('items', detailId, d);

  const platform = $('copyPlatform').value;
  const title = generateTitle(d.category, platform, f);
  const desc = generate(d.category, platform, f);
  $('copyTitleOut').textContent = title;
  $('copyDescOut').textContent = desc;
  $('copyOut').hidden = false;
  $('btnCopyTitle').onclick = (e) => copyToClipboard(title, e.target);
  $('btnCopyDesc').onclick = (e) => copyToClipboard(desc, e.target);
  $('btnSaveDesc').onclick = async () => {
    const rec = await store.get('items', detailId);
    if (!rec) return;
    rec.data.description = desc;
    rec.data.updatedAt = new Date().toISOString();
    await outbox.enqueueRecord('items', detailId, rec.data);
    toast('Saved to the item ✓');
  };
}

// ---------- shot list (FR-007) ----------
const DEFAULT_SHOTS = {
  electronics: ['Front, powered ON', 'Model/serial label', 'All ports up close', 'Included cables laid out', 'Any flaws up close'],
  musical: ['Full front', 'Brand/model badge', 'Keys/strings up close', 'Powered on / in playing position', 'Included stand/pedal/case', 'Any flaws up close'],
  tools: ['Full tool', 'Model plate', 'Running (photo or short video)', 'Blades/bits/accessories', 'Any flaws up close'],
  furniture: ['Full front', 'Each side', 'Surface up close', 'Drawers/doors open', 'Tag/maker mark if any', 'Any flaws up close'],
  other: ['Full front', 'Label/brand', 'Any flaws up close'],
};
let shotlists = DEFAULT_SHOTS;

function loadShotlists() {
  store.metaGet('shotlists').then((c) => { if (c) shotlists = c; });
  gh.readFile('config/shotlists.json').then((r) => {
    if (r.ok && r.json.shotlists) {
      shotlists = r.json.shotlists;
      store.metaSet('shotlists', shotlists);
    }
  }).catch(() => {});
}

function renderShotlist(d) {
  const box = $('shotList');
  if (d.status === 'sold' || d.status === 'dead') { box.innerHTML = ''; return; }
  const shots = shotlists[d.category] || shotlists.other;
  const checked = new Set(d.shotChecks || []);
  box.innerHTML = '<p class="pipe-group">Photo shot list</p>' + shots.map((s) =>
    `<label class="confirm-row shot-row"><input type="checkbox" data-shot="${esc(s)}"${checked.has(s) ? ' checked' : ''}><span>${esc(s)}</span></label>`
  ).join('');
  box.querySelectorAll('input[data-shot]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const r = await store.get('items', d.id);
      if (!r) return;
      const set = new Set(r.data.shotChecks || []);
      if (cb.checked) set.add(cb.dataset.shot); else set.delete(cb.dataset.shot);
      r.data.shotChecks = [...set];
      r.data.updatedAt = new Date().toISOString();
      await outbox.enqueueRecord('items', d.id, r.data);
    });
  });
}

// ---------- listing entry (FR-004/FR-014: tier-tap price defaults) ----------
function tierButtons(d, priceInputId) {
  const box = document.createElement('div');
  box.className = 'tier-row';
  [['Quick', d.priceQuickCents], ['Patient', d.pricePatientCents]].forEach(([label, cents]) => {
    if (cents == null) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-small';
    b.textContent = `${label} ${centsToDollars(cents)}`;
    b.addEventListener('click', () => { $(priceInputId).value = (cents / 100); });
    box.appendChild(b);
  });
  return box;
}

function openListingForm(d) {
  $('listingForm').hidden = false;
  $('saleForm').hidden = true;
  $('liPlatform').innerHTML = SELL_PLATFORMS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('liPrice').value = '';
  $('liDate').value = new Date().toISOString().slice(0, 10);
  $('liUrl').value = '';
  const tb = $('liTiers');
  tb.innerHTML = '';
  tb.appendChild(tierButtons(d, 'liPrice'));
}

async function saveListing() {
  const r = await store.get('items', detailId);
  if (!r) return;
  const priceCents = dollarsToCents($('liPrice').value);
  if (priceCents == null) { toast('Listing needs a price (tap a tier)'); return; }
  const now = new Date().toISOString();
  r.data.listings = r.data.listings || [];
  r.data.listings.push({
    platform: $('liPlatform').value,
    priceCents,
    listedAt: $('liDate').value || now.slice(0, 10),
    url: $('liUrl').value.trim() || undefined,
  });
  if (r.data.status === 'acquired') {
    r.data.status = 'listed';
    r.data.statusChangedAt = now;
  }
  r.data.updatedAt = now;
  await outbox.enqueueRecord('items', detailId, r.data);
  toast('Listed ✓');
  openDetail(detailId);
  renderList();
}

// ---------- sale close (FR-004/FR-005) ----------
function openSaleForm(d) {
  $('saleForm').hidden = false;
  $('listingForm').hidden = true;
  const last = (d.listings && d.listings.length) ? d.listings[d.listings.length - 1].platform : 'fbm';
  $('saPlatform').innerHTML = SELL_PLATFORMS.map(([v, l]) => `<option value="${v}"${v === last ? ' selected' : ''}>${l}</option>`).join('');
  $('saPrice').value = '';
  $('saFees').value = '';
  $('saDate').value = new Date().toISOString().slice(0, 10);
  const tb = $('saTiers');
  tb.innerHTML = '';
  tb.appendChild(tierButtons(d, 'saPrice'));
}

async function saveSale() {
  const r = await store.get('items', detailId);
  if (!r) return;
  const priceCents = dollarsToCents($('saPrice').value);
  if (priceCents == null) { toast('What did it sell for?'); return; }
  const now = new Date().toISOString();
  r.data.sale = {
    platform: $('saPlatform').value,
    priceCents,
    soldAt: $('saDate').value || now.slice(0, 10),
    feesCents: dollarsToCents($('saFees').value) || 0,
  };
  r.data.status = 'sold';
  r.data.statusChangedAt = now;
  r.data.updatedAt = now;
  await outbox.enqueueRecord('items', detailId, r.data);
  const m = computeMargin(r.data);
  toast(`Sold! Margin ${centsToDollars(m)} 🎉`);
  openDetail(detailId);
  renderList();
}

async function advanceStatus(id, next) {
  if (next === 'dead' && !confirm('Mark dead? It keeps its FLIP number and history, but leaves the active pipeline.')) return;
  const r = await store.get('items', id);
  if (!r) return;
  const now = new Date().toISOString();
  r.data.status = next;
  r.data.updatedAt = now;
  r.data.statusChangedAt = now;
  await outbox.enqueueRecord('items', id, r.data);
  toast('Now ' + next);
  openDetail(id);
  renderList();
}

// ---------- promotion from a buy verdict (story 2.1 handoff) ----------
let pendingVerdictId = null;

async function checkPendingAcquire() {
  const vid = sessionStorage.getItem('fs.pendingAcquire');
  if (!vid) return;
  const v = await store.get('verdicts', vid);
  if (!v) { sessionStorage.removeItem('fs.pendingAcquire'); return; }
  pendingVerdictId = vid;
  const d = blankItem();
  d.name = v.data.itemName;
  d.category = v.data.category || 'other';
  d.costCents = v.data.askingCents != null ? v.data.askingCents : v.data.maxBuyCents;
  d.fromVerdict = vid;
  d.id = null; // force create path
  openForm(d);
  toast('Pre-filled from your buy verdict; fix the cost to what you actually paid');
}

// ---------- init ----------
export function init() {
  const sel = $('itCategory');
  CATEGORIES.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  });
  $('btnNewItem').addEventListener('click', () => openForm(null));
  $('btnAddPartner').addEventListener('click', () => { formPartners.push({ name: '', sharePct: 0, investedCents: null }); renderPartners(); });
  $('btnItemSave').addEventListener('click', saveForm);
  $('btnItemCancel').addEventListener('click', () => sub('invList'));
  $('btnLiSave').addEventListener('click', saveListing);
  $('btnLiCancel').addEventListener('click', () => { $('listingForm').hidden = true; });
  $('btnSaSave').addEventListener('click', saveSale);
  $('btnSaCancel').addEventListener('click', () => { $('saleForm').hidden = true; });
  $('btnGenerate').addEventListener('click', generateCopy);
  $('btnCopyClose').addEventListener('click', () => { $('copySection').hidden = true; });
  $('copyTier').addEventListener('input', () => { $('copyCustom').hidden = $('copyTier').value !== 'custom'; });
  $('copyPlatform').addEventListener('input', () => { if (!$('copyOut').hidden) generateCopy(); });
  loadShotlists();
  $('btnDetBack').addEventListener('click', () => { sub('invList'); renderList(); });
  $('btnDetEdit').addEventListener('click', async () => {
    const r = await store.get('items', detailId);
    if (r) openForm({ ...r.data });
  });
  window.addEventListener('view:show', (e) => {
    if (e.detail.view === 'inventory') { renderList(); checkPendingAcquire(); }
  });
  window.addEventListener('outbox:change', () => {
    if (!$('view-inventory').hidden && !$('invList').hidden) renderList();
  });
  renderList();
}
