// inventory.js — item records, FLIP-#### IDs, promotion from verdicts,
// partner stakes, price tiers (story 3.1 / FR-004, FR-013, FR-014).
// Listings + sale close extend this module in story 3.2; pipeline view in 3.3.

import * as store from './store.js';
import * as outbox from './outbox.js';
import { ulid } from './ulid.js';
import { toast } from './ui.js';
import { CATEGORIES, dollarsToCents, centsToDollars } from './investigate.js';

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

// ---------- list ----------
export function flipLabel(d) {
  if (!d.flipId) return '…';
  return d.flipId + (d.idProvisional ? '*' : '');
}

async function renderList() {
  const rows = await store.getAll('items');
  rows.sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1));
  const box = $('itemRows');
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<p class="hint">No items yet. Log a buy verdict and tap Acquired, or add one here.</p>';
    return;
  }
  rows.forEach((r) => {
    const d = r.data;
    const el = document.createElement('div');
    el.className = 'item-row';
    el.innerHTML = `
      <span class="ir-flip">${flipLabel(d)}</span>
      <span class="ir-name">${esc(d.name)}${(d.partners && d.partners.length) ? ' <span title="partners on this deal">🤝</span>' : ''}</span>
      <span class="status-chip st-${d.status}">${d.status}</span>
      ${r.pending ? '<span class="rpend">●</span>' : ''}`;
    el.addEventListener('click', () => openDetail(d.id));
    box.appendChild(el);
  });
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
  if (d.notes) rows.push(['Notes', esc(d.notes)]);
  $('detRows').innerHTML = rows.map(([k, v]) => `<div class="det-row"><span>${k}</span><div>${v}</div></div>`).join('');

  $('listingForm').hidden = true;
  $('saleForm').hidden = true;

  const btns = $('detActions');
  btns.innerHTML = '';
  const addBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    btns.appendChild(b);
  };
  if (d.status === 'scouted') addBtn('Mark acquired', 'btn-primary', () => advanceStatus(d.id, 'acquired'));
  if (d.status === 'acquired' || d.status === 'listed') addBtn('＋ Add listing', 'btn-primary', () => openListingForm(d));
  if (d.status === 'listed') addBtn('💰 Sold…', 'btn-buy', () => openSaleForm(d));
  if (d.status !== 'sold' && d.status !== 'dead') addBtn('Mark dead', 'btn-pass', () => advanceStatus(d.id, 'dead'));
  sub('invDetail');
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
