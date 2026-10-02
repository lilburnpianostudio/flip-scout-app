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
import {
  sharesTotal, investedTotal, benInvested, computeMargin, settle,
  freezeSale, frozenPayouts, frozenMargin, needsFreeze, computePartnerLedger,
  paymentsTotal, isBuy, partnerKey,
  partnerItemLedger, buildPayout, formatReceipt,
} from './settlement.js';

const $ = (id) => document.getElementById(id);

// Forward-only lifecycle (ADR-010). 'sold' entry happens via sale close (3.2).
export const TRANSITIONS = {
  scouted: ['acquired', 'dead'],
  acquired: ['listed', 'sold', 'dead'], // sold direct: FLIP-D25
  listed: ['sold', 'dead'],
  sold: [],
  dead: [],
};

// The money math lives in settlement.js — pure, DOM-free, fixture-tested
// (tests/settlement.test.mjs). Re-exported so the old call sites keep working.
export { sharesTotal, computeMargin, computePartnerLedger };

// Payout preview for an UNSOLD item at a hypothetical sale price (FLIP-D10).
// Runs the same settlement as a real close, so the negotiation table promises
// exactly what the girls will actually be handed — capital back included.
export function previewAt(d, priceCents) {
  return settle(d.costCents || 0, priceCents, d.partners);
}

// Platforms, posted-on state, album names and the take-down rule live in
// listing.js: pure, and tested install-free (tests/listing.test.mjs).
import {
  SELL_PLATFORMS, platformLabel, isListedOn, askingCents, albumName,
  everythingText, closeSoldListing, pendingTakedowns, markTakenDown,
  priceLadder, ladderProblems, platformsFor, sellUrl, copyFor, askOn, platformText,
} from './listing.js';
// Offers, pending sales, status per marketplace (v27). Pure, tested in
// tests/pipeline.test.mjs.
import {
  openOffers, bestOffer, addOffer, closeOffer, closeOffersOnSale, offerVerdict,
  setPending, isPending, platformStatus, STATUS_LABEL, attention,
  DEFAULT_REPRICE, repriceAdvice, applyReduce, markRefreshed, snoozeReprice,
} from './pipeline.js';
// The AI step, by copy and paste (v26). Pure, tested in tests/aicopy.test.mjs.
import { buildPrompt, parseAnswer, applyAnswer } from './aicopy.js';
// What each marketplace keeps (v25). Pure, tested in tests/fees.test.mjs.
import { DEFAULT_FEES, mergeFees, feeFor, expectedNet, feeClassOf } from './fees.js';

// How the item came in (FLIP-D21). Only 'bought' cost money Ben chose to spend;
// the other three are $0 by definition, which is what makes a $0 cost readable
// as "free on purpose" instead of "nobody filled this in."
export const ACQUISITIONS = [
  ['bought', 'Bought it'],
  ['gifted', 'Gifted to us'],
  ['owned', 'Already had it'],
  ['found', 'Found it free'],
];
const acquisitionLabel = (id) => (ACQUISITIONS.find(([v]) => v === id) || [id, id])[1];

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
    acquisition: 'bought',
    source: '',
    costCents: null,
    acquiredAt: now.slice(0, 10),
    fromVerdict: null,
    listings: [],
    sale: null,
    copyFields: {},
    shotChecks: [],
    partners: [],
    payments: [],   // append-only settlement record (FLIP-D18)
    priceAskCents: null,     // opening ask (v25)
    priceQuickCents: null,
    pricePatientCents: null, // the FAIR price; the field name predates the label
    priceFloorCents: null,   // lowest acceptable, private (v25)
    notes: '',
    photoAlbum: '', // iPhone Photos album NAME only; blank = albumName() default
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
  };
}

// ---------- subview plumbing ----------
function sub(name) {
  ['invList', 'invForm', 'invDetail', 'invSettle'].forEach((s) => { $(s).hidden = s !== name; });
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
      const m = frozenMargin(d);
      if (m !== null) realizedCents += m;
    } else if (d.status !== 'dead' && d.costCents != null) {
      investedCents += d.costCents;
    }
  });
  return { investedCents, realizedCents };
}

// ---------- freeze backfill (FLIP-D18) ----------
// Sales closed before the freeze shipped carry no payouts[]. Settle them once
// from their partners[] as they stand today and write it in, so from here on
// the record cannot drift. Runs once per session; a no-op on a repo with no
// pre-freeze sales, which is the case if this ships before the first sale.
let backfilled = false;
async function backfillFrozenSales() {
  if (backfilled) return;
  backfilled = true;
  try {
    const rows = await store.getAll('items');
    const stale = rows.filter((r) => needsFreeze(r.data));
    for (const r of stale) {
      freezeSale(r.data);
      r.data.updatedAt = new Date().toISOString();
      await outbox.enqueueRecord('items', r.data.id, r.data);
    }
    if (stale.length) toast(`Locked in payouts on ${stale.length} past sale${stale.length === 1 ? '' : 's'}`);
  } catch (e) {
    backfilled = false; // let a later render retry
  }
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
  // Partner tab = earned minus paid (FLIP-D18). Settled partners drop off the
  // line entirely rather than sitting at $0 forever.
  const ledger = computePartnerLedger(rows.map((r) => r.data));
  const open = Object.values(ledger).filter((p) => p.owedCents !== 0);
  // Each name is a button into the settle-up screen. The balance was never the
  // useful part on its own — paying it is.
  const owedLine = open.length
    ? `<div class="owed-line">Partner tab: ${open.map((p) => `<button type="button" class="owed-chip" data-settle="${esc(p.name)}"><b>${esc(p.name)}</b> ${centsToDollars(p.owedCents)}</button>`).join(' ')}<small>tap a name to settle up</small></div>`
    : '';
  $('pipeTotals').innerHTML = `
    <div><small>tied up in inventory</small><b>${centsToDollars(totals.investedCents)}</b></div>
    <div><small>realized profit</small><b class="${totals.realizedCents >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(totals.realizedCents)}</b></div>
    ${owedLine}`;
  $('pipeTotals').querySelectorAll('[data-settle]').forEach((b) => {
    b.addEventListener('click', () => openSettle(b.dataset.settle));
  });

  const bySt = { acquired: [], listed: [], scouted: [], sold: [], dead: [] };
  rows.forEach((r) => (bySt[r.data.status] || bySt.scouted).push(r));
  Object.values(bySt).forEach((g) => g.sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1)));

  // Sold but still up somewhere: top of the list, above everything, until
  // clear. This is the reminder that stops the same item selling twice.
  const takedowns = bySt.sold.filter((r) => pendingTakedowns(r.data).length);
  if (takedowns.length) {
    const h = document.createElement('p');
    h.className = 'pipe-group';
    h.textContent = `⚠ Sold, take these down (${takedowns.length})`;
    box.appendChild(h);
    takedowns.forEach((r) => {
      const n = pendingTakedowns(r.data).length;
      box.appendChild(itemRow(r, `<span class="td-badge">${n} still up</span>`));
    });
  }

  // Unsold items, grouped by what they need from Ben, most urgent first
  // (v27). The old grouping was by status, which answered "where is it in the
  // lifecycle" when the question at the top of the day is "what do I do".
  const selling = bySt.acquired.concat(bySt.listed);
  const byNeed = { offer: [], pending: [], reprice: [], ready: [], live: [], unlisted: [] };
  const now = Date.now();
  selling.forEach((r) => {
    const need = attention(r.data) || 'unlisted';
    // Live and gone stale is its own group (v28): it needs a decision, where
    // plain "live" only needs patience.
    byNeed[need === 'live' && repriceAdvice(r.data, now, repriceCfg) ? 'reprice' : need].push(r);
  });
  const days = (r) => daysIn(r.data.statusChangedAt || r.data.updatedAt || r.data.createdAt);
  const group = (label, list, badge) => {
    if (!list.length) return;
    const h = document.createElement('p');
    h.className = 'pipe-group';
    h.textContent = `${label} (${list.length})`;
    box.appendChild(h);
    list.forEach((r) => box.appendChild(itemRow(r, badge(r))));
  };
  group('💬 Offers waiting', byNeed.offer, (r) => {
    const o = bestOffer(r.data);
    // Short on purpose: a long badge squeezes the item's name off the row.
    return `<span class="of-badge" title="on ${esc(platformLabel(o.platform))}">${centsToDollars(o.amountCents).replace(/\.00$/, '')} offer</span>`;
  });
  group('🤝 Sale pending', byNeed.pending, (r) => `<span class="ir-days">${days(r)}d</span>`);
  group('⏳ Needs repricing', byNeed.reprice, (r) => {
    const a = repriceAdvice(r.data, now, repriceCfg);
    // Short on purpose, like the offer badge: the name matters more than the
    // day count, and the item itself says the rest.
    const what = a.action === 'reduce' ? `↓ ${centsToDollars(a.toCents).replace(/\.00$/, '')}` : a.action === 'refresh' ? 'refresh' : 'recheck';
    return `<span class="rp-badge" title="${a.days} days up">${what}</span>`;
  });
  group('Ready to post', byNeed.ready, (r) => `<span class="ir-days">${days(r)}d</span>`);
  group('Live, waiting on a buyer', byNeed.live, (r) => {
    const n = (r.data.listings || []).filter((l) => !l.removedAt).length;
    return `<span class="ir-days">${n} place${n === 1 ? '' : 's'} · ${days(r)}d</span>`;
  });
  group('Not listed yet', byNeed.unlisted, (r) => `<span class="ir-days">${days(r)}d</span>`);
  group('Scouted', bySt.scouted, (r) => `<span class="ir-days">${days(r)}d</span>`);

  if (bySt.sold.length || bySt.dead.length) {
    const det = document.createElement('details');
    det.className = 'pipe-history';
    det.innerHTML = `<summary>History: ${bySt.sold.length} sold · ${bySt.dead.length} dead</summary>`;
    bySt.sold.forEach((r) => {
      const m = frozenMargin(r.data);
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

// The partner roster, loaded from config/partners.json in the PRIVATE repo and
// cached for offline (same pattern as shotlists). It is deliberately not in this
// file: flip-scout-app is public and these are family names, one of them a kid's.
// An empty roster is a valid state — the name box just falls back to free text.
let partnerRoster = [];

function loadPartners() {
  store.metaGet('partners').then((c) => { if (c && !partnerRoster.length) partnerRoster = c; });
  gh.readFile('config/partners.json').then((r) => {
    if (r.ok && Array.isArray(r.json.partners)) {
      partnerRoster = r.json.partners.filter((p) => p && p.name);
      store.metaSet('partners', partnerRoster);
    }
  }).catch(() => {});
}

// Trim-insensitive on purpose: at least one live record stores a partner name
// with a trailing space, and that should show as the roster entry picked rather
// than as a stranger. Saving trims, so the stray space heals on the next save.
const rosterHas = (name) => partnerRoster.some((r) => r.name === partnerKey(name));

function openForm(prefill) {
  editingId = prefill && prefill.id ? prefill.id : null;
  const d = prefill || blankItem();
  $('itName').value = d.name || '';
  $('itCategory').value = d.category || 'other';
  $('itAcquisition').value = d.acquisition || 'bought';
  $('itSource').value = d.source || '';
  $('itCost').value = d.costCents != null ? (d.costCents / 100) : '';
  syncCostToAcquisition();
  $('itAcquiredAt').value = d.acquiredAt || new Date().toISOString().slice(0, 10);
  $('itAsk').value = d.priceAskCents != null ? (d.priceAskCents / 100) : '';
  $('itQuick').value = d.priceQuickCents != null ? (d.priceQuickCents / 100) : '';
  $('itPatient').value = d.pricePatientCents != null ? (d.pricePatientCents / 100) : '';
  $('itFloor').value = d.priceFloorCents != null ? (d.priceFloorCents / 100) : '';
  warnPrices();
  $('itDesc').value = d.description || '';
  $('itNotes').value = d.notes || '';
  $('itAlbum').value = d.photoAlbum || '';
  $('itAlbum').placeholder = d.flipId ? albumName({ ...d, photoAlbum: '' }) : 'FLIP number + name';
  formPartners = (d.partners || []).map((p) => ({ ...p }));
  renderPartners();
  $('invFormTitle').textContent = editingId ? `Edit ${flipLabel(d)}` : 'New item';
  sub('invForm');
}

// A non-bought item cost nothing by definition, so the cost box goes to $0 and
// locks. That is the whole point of the field: an editable blank reads as
// "unfilled", a locked $0 reads as "free, and I meant it."
function syncCostToAcquisition() {
  const bought = $('itAcquisition').value === 'bought';
  const cost = $('itCost');
  cost.disabled = !bought;
  cost.placeholder = bought ? '$' : 'free';
  if (!bought) cost.value = '0';
  warnPartners();
}

// Prices that contradict each other get said out loud, not blocked: Ben may
// know something the form does not.
function formPrices() {
  return {
    priceAskCents: dollarsToCents($('itAsk').value),
    pricePatientCents: dollarsToCents($('itPatient').value),
    priceQuickCents: dollarsToCents($('itQuick').value),
    priceFloorCents: dollarsToCents($('itFloor').value),
    costCents: $('itAcquisition').value === 'bought' ? dollarsToCents($('itCost').value) : 0,
  };
}

function warnPrices() {
  const w = $('priceWarn');
  const msgs = ladderProblems(formPrices());
  w.hidden = !msgs.length;
  w.innerHTML = msgs.map((m) => `Heads up: ${esc(m)}`).join('<br>');
}

function renderPartners() {
  const box = $('partnerRows');
  box.innerHTML = '';
  formPartners.forEach((p, i) => {
    // Free text only when there is no roster to pick from, or when this partner
    // is a one-off who is not on it. Someone new at a garage sale must never be
    // blocked by a list that has not been edited yet.
    const custom = p.other || (!!p.name && partnerRoster.length > 0 && !rosterHas(p.name));
    const nameCell = partnerRoster.length
      ? `<select data-pf="pick" data-i="${i}">
           <option value=""${!p.name && !custom ? ' selected' : ''}>who?</option>
           ${partnerRoster.map((r) => `<option value="${esc(r.name)}"${r.name === partnerKey(p.name) ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
           <option value="__other"${custom ? ' selected' : ''}>Other…</option>
         </select>`
      : `<input type="text" placeholder="name" value="${esc(p.name)}" data-pf="name" data-i="${i}">`;

    const row = document.createElement('div');
    row.className = 'partner-row';
    row.innerHTML = `
      ${nameCell}
      <input type="text" inputmode="numeric" placeholder="%" value="${p.sharePct || ''}" data-pf="sharePct" data-i="${i}">
      <input type="text" inputmode="decimal" placeholder="$ of cost" value="${p.investedCents != null ? p.investedCents / 100 : ''}" data-pf="invested" data-i="${i}">
      <button type="button" class="btn btn-ghost btn-small" data-prm="${i}">✕</button>`;
    box.appendChild(row);

    if (custom && partnerRoster.length) {
      const extra = document.createElement('div');
      extra.className = 'partner-custom';
      extra.innerHTML = `<input type="text" placeholder="name (not on the list)" value="${esc(p.name)}" data-pf="name" data-i="${i}">`;
      box.appendChild(extra);
    }
  });

  box.querySelectorAll('select[data-pf=pick]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.i);
      const p = formPartners[i];
      if (sel.value === '__other') {
        p.other = true;
        p.name = '';
      } else {
        p.other = false;
        p.name = sel.value;
        // Prefill the share the first time a roster name is picked. Never
        // overwrite a number Ben already typed — the default is a shortcut,
        // not a rule.
        const r = partnerRoster.find((x) => x.name === sel.value);
        if (r && r.defaultShare != null && !p.sharePct) p.sharePct = Number(r.defaultShare) || 0;
      }
      renderPartners();
    });
  });

  box.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.i);
      if (inp.dataset.pf === 'name') formPartners[i].name = inp.value;
      if (inp.dataset.pf === 'sharePct') formPartners[i].sharePct = parseInt(inp.value, 10) || 0;
      if (inp.dataset.pf === 'invested') formPartners[i].investedCents = dollarsToCents(inp.value);
      warnPartners();
    });
  });
  box.querySelectorAll('[data-prm]').forEach((b) => {
    b.addEventListener('click', () => { formPartners.splice(Number(b.dataset.prm), 1); renderPartners(); });
  });
  warnPartners();
}

function warnPartners() {
  const w = $('shareWarn');
  const msgs = [];
  const total = sharesTotal(formPartners);
  if (total > 100) msgs.push(`Shares add to ${total}%. Allowed, but that's more than the margin.`);
  // investedCents is a PORTION of the cost, not money on top of it (FLIP-D19),
  // so the partners' cash can never add up to more than what the item cost.
  const cost = dollarsToCents($('itCost').value);
  const inv = investedTotal(formPartners);
  if (cost != null && inv > cost) {
    msgs.push(`Partners put in ${(inv / 100).toFixed(2)} but the item cost ${(cost / 100).toFixed(2)}. Their "$ in" is their share of the cost, not extra money.`);
  }
  w.hidden = !msgs.length;
  w.innerHTML = msgs.map((m) => `Heads up: ${esc(m)}`).join('<br>');
}

async function saveForm() {
  const name = $('itName').value.trim();
  if (!name) { toast('Item needs a name'); return; }
  const existing = editingId ? await store.get('items', editingId) : null;
  const d = existing ? { ...existing.data } : blankItem();
  const now = new Date().toISOString();
  d.name = name;
  d.category = $('itCategory').value;
  d.acquisition = $('itAcquisition').value || 'bought';
  d.source = $('itSource').value.trim();
  // Trust the field, not the disabled input: a non-bought item is $0, full stop.
  d.costCents = d.acquisition === 'bought' ? dollarsToCents($('itCost').value) : 0;
  d.acquiredAt = $('itAcquiredAt').value || d.acquiredAt;
  d.priceAskCents = dollarsToCents($('itAsk').value);
  d.priceQuickCents = dollarsToCents($('itQuick').value);
  d.pricePatientCents = dollarsToCents($('itPatient').value);
  d.priceFloorCents = dollarsToCents($('itFloor').value);
  d.description = $('itDesc').value.trim();
  d.notes = $('itNotes').value.trim();
  d.photoAlbum = $('itAlbum').value.trim();
  // Trim on the way in as well as on the way out: the name is the ledger key,
  // and a stray trailing space would split one partner into two balances.
  // `other` is a form-only flag for "typing a name not on the roster" and must
  // never reach the record — a stray key on a partner row is a stray key in the
  // ledger forever.
  d.partners = formPartners
    .filter((p) => p.name && p.name.trim())
    .map(({ other, ...rest }) => ({ ...rest, name: rest.name.trim() }));
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
  // Only worth a row when it was NOT a buy — "Bought it" is the unremarkable
  // default and does not need saying on every item.
  if (!isBuy(d)) rows.push(['How I got it', esc(acquisitionLabel(d.acquisition))]);
  if (d.source) rows.push(['From', esc(d.source)]);
  rows.push(['Acquired', d.acquiredAt || '']);
  // One row for all four prices: they only mean something next to each other.
  const ladder = priceLadder(d);
  if (ladder.length) {
    rows.push(['Prices', ladder.map((t) => `${t.label} <b>${centsToDollars(t.cents)}</b>`).join(' · ')
      + (d.priceFloorCents != null ? '<br><small>the floor is private and never goes in a listing</small>' : '')]);
  }
  if (d.pricing && (d.pricing.rangeLowCents != null || d.pricing.basis)) {
    const pr = d.pricing;
    const range = pr.rangeLowCents != null && pr.rangeHighCents != null
      ? `${centsToDollars(pr.rangeLowCents)} to ${centsToDollars(pr.rangeHighCents)}` : '';
    const comps = (pr.comps || []).map((c) => `${esc(c.source)} ${centsToDollars(c.priceCents)}${c.note ? ' <small>' + esc(c.note) + '</small>' : ''}`).join('<br>');
    rows.push(['Likely sells for', `${range ? '<b>' + range + '</b>' : ''}${pr.basis ? `<br><small>${esc(pr.basis)}</small>` : ''}${comps ? '<br>' + comps : '<br><small>no sold comps given: an estimate, not a fact</small>'}`]);
  }
  if (d.partners && d.partners.length) {
    rows.push(['Partners', d.partners.map((p) => `${esc(p.name)} ${p.sharePct || 0}%${p.investedCents ? ' (' + centsToDollars(p.investedCents) + ' of the cost)' : ''}`).join('<br>')]);
    const mine = benInvested(d.costCents || 0, d.partners);
    if (investedTotal(d.partners) > 0) rows.push(['My money in', centsToDollars(mine)]);
  }
  if (d.listings && d.listings.length) {
    rows.push(['Listed on', d.listings.map((l) => {
      const line = `${platformLabel(l.platform)} · ${l.priceCents != null ? centsToDollars(l.priceCents) : ''} · ${l.listedAt || ''}${l.url ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">open</a>` : ''}`;
      return l.removedAt ? `<span class="li-down">${line}</span> <small>down ${esc(l.removedAt)}${l.removedWhy ? ', ' + esc(l.removedWhy) : ''}</small>` : line;
    }).join('<br>')]);
  }
  if (d.status !== 'dead') rows.push(['Photos album', `${esc(albumName(d))}${d.photoAlbum ? '' : ' <small>(suggested)</small>'}`]);
  if (d.sale) {
    rows.push(['Sold', `${platformLabel(d.sale.platform)} · ${centsToDollars(d.sale.priceCents)} · ${d.sale.soldAt || ''}${d.sale.feesCents ? ' · fees ' + centsToDollars(d.sale.feesCents) : ''}${d.sale.shippingCents ? ' · shipping ' + centsToDollars(d.sale.shippingCents) : ''}`]);
    const m = frozenMargin(d);
    rows.push(['Margin', `<b class="${m >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(m)}</b>`]);
    // Payouts of record, frozen at close (FLIP-D18). Capital return is shown
    // apart from profit so "your $20 back plus $25" is never one mystery number.
    frozenPayouts(d).forEach((p) => {
      const paid = paymentsTotal(d.payments, p.name);
      const parts = [];
      if (p.capitalCents) parts.push(`${centsToDollars(p.capitalCents)} of it is her money back`);
      if (p.capitalCents && p.profitCents) parts.push(`${centsToDollars(p.profitCents)} profit`);
      if (paid) parts.push(`${centsToDollars(paid)} paid`);
      rows.push(['→ ' + esc(p.name), `<b>${centsToDollars(p.payoutCents)}</b>${parts.length ? `<br><small>${parts.join(' · ')}</small>` : ''}`]);
    });
  } else if (d.partners && d.partners.length && d.status !== 'dead') {
    // Negotiation table (FLIP-D10): what each partner walks away with at each
    // tier — the same settlement that will run at close, not a rosier version.
    const tiers = priceLadder(d).filter((t) => t.id !== 'floor').map((t) => [t.label.toLowerCase(), t.cents]);
    tiers.forEach(([label, cents]) => {
      const pv = previewAt(d, cents);
      const lines = [`margin ${centsToDollars(pv.marginCents)}`]
        .concat(pv.payouts.map((p) => `${esc(p.name)} walks with ${centsToDollars(p.payoutCents)}`));
      rows.push([`If sold ${label} (${centsToDollars(cents)})`, lines.join('<br>')]);
    });
  }
  if (d.description) rows.push(['Description', `<span class="copy-text" style="display:block;">${esc(d.description)}</span>`]);
  if (d.notes) rows.push(['Notes', esc(d.notes)]);
  $('detRows').innerHTML = rows.map(([k, v]) => `<div class="det-row"><span>${k}</span><div>${v}</div></div>`).join('');

  $('listingForm').hidden = true;
  $('saleForm').hidden = true;
  $('copySection').hidden = true;
  $('aiSection').hidden = true;
  $('offerForm').hidden = true;
  renderTakedowns(d);
  renderOffers(d);
  renderReprice(d);
  renderNet(d);
  renderPostedOn(d);
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
  const selling = d.status === 'acquired' || d.status === 'listed';
  if (selling && d.name) addBtn('📋 Copy everything', 'btn-primary', (e) => copyToClipboard(everythingText(d), e.target));
  if (d.name) addBtn('📋 Copy title', 'btn-ghost', (e) => copyToClipboard(d.name, e.target));
  const ask = askingCents(d);
  if (selling && ask != null) addBtn('📋 Copy price', 'btn-ghost', (e) => copyToClipboard(String(ask % 100 === 0 ? ask / 100 : (ask / 100).toFixed(2)), e.target));
  if (d.description) addBtn('📋 Copy description', 'btn-ghost', (e) => copyToClipboard(d.description, e.target));
  if (selling) addBtn('🖼️ Copy album name', 'btn-ghost', (e) => copyToClipboard(albumName(d), e.target));
  if (d.status === 'scouted') addBtn('Mark acquired', 'btn-primary', () => advanceStatus(d.id, 'acquired'));
  if (d.status === 'acquired' || d.status === 'listed') {
    addBtn('🤖 AI listings', 'btn-primary', () => openAiSection(d));
    addBtn('📝 Listing copy', 'btn-ghost', () => openCopySection(d));
    addBtn('＋ Add listing', 'btn-ghost', () => openListingForm(d));
  }
  // Sellable straight from `acquired` (FLIP-D25). The forward-only lifecycle
  // assumed acquired -> listed -> sold, but things sell off a listing that was
  // never logged, or by word of mouth. FLIP-0001 really sold for $140 while the
  // app offered no way to say so, which is how the first real sale in this
  // tracker's life went unrecorded for days.
  if (d.status === 'acquired' || d.status === 'listed') addBtn('💬 Log an offer', 'btn-ghost', () => openOfferForm(d));
  if (d.status === 'acquired' || d.status === 'listed') addBtn('💰 Sold…', 'btn-buy', () => openSaleForm(d));
  if (d.status !== 'sold' && d.status !== 'dead') addBtn('Mark dead', 'btn-pass', () => advanceStatus(d.id, 'dead'));
  sub('invDetail');
}

// ---------- listing copy (story 4.2 / FR-006, FR-014) ----------
// fallbackId names the textarea to fall back into: it has to be one that is
// actually on screen, or the "text is selected below" message points at nothing.
async function copyToClipboard(text, btn, fallbackId = 'copyFallback') {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ✓ paste it in the app');
  } catch (e) {
    // Fallback: selected textarea + one more tap (older Safari states).
    const ta = $(fallbackId);
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
  const picked = priceLadder(d).find((t) => t.id === tier);
  out.priceCents = picked ? picked.cents : dollarsToCents($('copyCustom').value);
  return out;
}

function openCopySection(d) {
  $('copySection').hidden = false;
  $('listingForm').hidden = true;
  $('saleForm').hidden = true;
  $('aiSection').hidden = true;
  $('copyPlatform').innerHTML = platformsFor(d).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const set = FIELD_SETS[d.category] || FIELD_SETS.other;
  $('copyFieldRows').innerHTML = set.map(([key, label]) =>
    `<label class="field"><span>${label}</span><input type="text" id="cf_${key}" value="${esc((d.copyFields || {})[key] || '')}"></label>`
  ).join('');
  const tierSel = $('copyTier');
  // The floor is never offered: it must not end up in a listing by accident.
  const shown = priceLadder(d).filter((t) => t.id !== 'floor');
  tierSel.innerHTML = shown.map((t, i) =>
    `<option value="${t.id}"${i === 0 ? ' selected' : ''}>${t.label} ${centsToDollars(t.cents)}</option>`).join('')
    + '<option value="custom">Custom price…</option>';
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

// ---------- what you would keep (v25, FLIP-D31) ----------
// The fee table lives in config/fees.json in the private repo, cached for
// offline like the shot lists. The copy baked into fees.js is the fallback.
let feeTable = DEFAULT_FEES;
// How long before a quiet listing is called stale. Lives beside the fee table
// in config/fees.json as { "reprice": { "staleDays": 14, "refreshDays": 30 } }.
let repriceCfg = DEFAULT_REPRICE;

function useFeeConfig(c) {
  if (c && c.platforms) feeTable = mergeFees(c);
  if (c && c.reprice) repriceCfg = { ...DEFAULT_REPRICE, ...c.reprice };
}

function loadFees() {
  store.metaGet('fees').then((c) => useFeeConfig(c));
  gh.readFile('config/fees.json').then((r) => {
    if (r.ok && r.json && (r.json.platforms || r.json.reprice)) {
      useFeeConfig(r.json);
      store.metaSet('fees', r.json);
    }
  }).catch(() => {});
}

// One line per marketplace at the price Ben is asking: what the marketplace
// takes and what is left after the item's own cost. A porch pickup and an eBay
// sale at the same price are not the same money, and until v25 nothing said so.
function renderNet(d) {
  const box = $('netBox');
  const selling = d.status === 'acquired' || d.status === 'listed';
  const ask = askingCents(d);
  if (!selling || ask == null) { box.innerHTML = ''; return; }
  const feeClass = feeClassOf(d);
  // Each marketplace at ITS price: an eBay ask written higher to cover the fee
  // is the number that matters there, not the porch-pickup one.
  const lines = platformsFor(d).map(([id, label]) => {
    const n = expectedNet(id, askOn(d, id), { costCents: d.costCents, feeClass }, feeTable);
    if (!n) return '';
    const how = n.mode === 'local' ? 'pickup' : 'shipped';
    const fee = n.feeCents ? `fee ${centsToDollars(n.feeCents)}` : 'no fee';
    const profit = n.profitCents == null ? '' : ` · <b class="${n.profitCents >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(n.profitCents)} profit</b>`;
    return `<div class="net-row"><span>${esc(label)} <small>${how}</small></span><div><small>at ${centsToDollars(n.priceCents)}</small> keep <b>${centsToDollars(n.netCents)}</b> <small>${fee}</small>${profit}</div></div>`;
  }).join('');
  box.innerHTML = `<div class="net-box"><p class="pipe-group">What you would keep, marketplace by marketplace</p>${lines}
    <p class="posted-hint">Estimates. Shipped sales also cost postage. Fee rates checked ${esc(feeTable.checkedOn || '')}.</p></div>`;
}

// ---------- posted on: one tap per marketplace (v24, FLIP-D30) ----------
// Before v24 the only way to record a listing was a form (platform, price,
// date, URL), and in two months not one listing was ever recorded, including
// on both items that sold. A record that costs a form does not get kept. So a
// tap marks it posted at the asking price, today, and the full form stays for
// when a URL is worth saving.
function renderPostedOn(d) {
  const box = $('postedOn');
  if (d.status !== 'acquired' && d.status !== 'listed') { box.innerHTML = ''; return; }
  // One row per marketplace that fits the item (v26): copy that marketplace's
  // text, open its new-listing page, then tap its name once it is up. Three
  // taps, and the third is the record.
  box.innerHTML = `<div class="posted-on"><p class="pipe-group">Post it: copy, open, then tap the name once it is up</p>
    ${platformsFor(d).map(([v, l]) => {
      const on = isListedOn(d, v);
      const ask = askOn(d, v);
      const url = sellUrl(v);
      return `<div class="plat-row">
        <button type="button" class="posted-chip${on ? ' on' : ''}" data-post="${v}">${on ? '✓ ' : ''}${l}</button>
        <span class="plat-ask">${ask != null ? centsToDollars(ask) : ''}${copyFor(d, v) ? ' <small title="written for this marketplace">✍️</small>' : ''}</span>
        <button type="button" class="btn btn-ghost btn-small" data-pcopy="${v}">Copy</button>
        ${url ? `<a class="btn btn-ghost btn-small" data-popen="${v}" href="${esc(url)}" target="_blank" rel="noopener">Open</a>` : ''}
      </div>${platSub(d, v)}`;
    }).join('')}
    <p class="posted-hint">✍️ = written for that marketplace. Tap a name again to mark it taken down.</p>
    <textarea id="postFallback" hidden rows="4"></textarea></div>`;
  box.querySelectorAll('[data-post]').forEach((b) => {
    b.addEventListener('click', () => togglePosted(d.id, b.dataset.post));
  });
  box.querySelectorAll('[data-pcopy]').forEach((b) => {
    b.addEventListener('click', (e) => copyToClipboard(platformText(d, b.dataset.pcopy), e.target, 'postFallback'));
  });
  box.querySelectorAll('[data-pend]').forEach((b) => {
    b.addEventListener('click', () => togglePending(d.id, b.dataset.pend));
  });
}

// The line under a marketplace row: where it stands there, and for a listing
// that is up, a way to say a buyer is on the way.
function platSub(d, platform) {
  const st = platformStatus(d, platform);
  if (st === 'not-prepared') return '';
  const live = (d.listings || []).filter((l) => !l.removedAt && l.platform === platform);
  const since = live.length && live[live.length - 1].listedAt ? ` since ${esc(live[live.length - 1].listedAt)}` : '';
  const toggle = live.length
    ? ` · <button type="button" class="linkish" data-pend="${platform}">${st === 'pending' ? 'not pending after all' : 'mark sale pending'}</button>`
    : '';
  return `<div class="plat-sub st-${st}">${esc(STATUS_LABEL[st])}${live.length ? since : ''}${toggle}</div>`;
}

async function togglePending(id, platform) {
  const r = await store.get('items', id);
  if (!r) return;
  const on = !isPending(r.data, platform);
  setPending(r.data, platform, on);
  r.data.updatedAt = new Date().toISOString();
  await outbox.enqueueRecord('items', id, r.data);
  toast(on ? `Sale pending on ${platformLabel(platform)}` : `Back to live on ${platformLabel(platform)}`);
  openDetail(id);
  renderList();
}

// ---------- repricing advice (v28, FLIP-D34) ----------
// The app cannot change a price on a marketplace, and must not pretend to.
// It says what to do, Ben does it there, and one tap here records that he did
// so the clock restarts and the list stops asking.
function renderReprice(d) {
  const box = $('repriceBox');
  const a = repriceAdvice(d, Date.now(), repriceCfg);
  if (!a) { box.innerHTML = ''; return; }
  const where = (d.listings || []).filter((l) => !l.removedAt).map((l) => platformLabel(l.platform));
  const names = esc([...new Set(where)].join(', '));
  const primary = a.action === 'reduce'
    ? `<button type="button" class="btn btn-primary btn-small" data-rp="reduce">I dropped it to ${centsToDollars(a.toCents).replace(/\.00$/, '')}</button>`
    : '<button type="button" class="btn btn-primary btn-small" data-rp="refresh">I refreshed it</button>';
  box.innerHTML = `<div class="reprice"><b>⏳ ${a.action === 'reduce' ? 'Time to drop the price' : a.action === 'refresh' ? 'Time to refresh it' : 'Check what it is worth'}</b>
    <p>${esc(a.text)}</p>
    <p class="posted-hint">${a.action === 'reduce' ? `Change the price on ${names} first, then tap.` : `It is up on ${names}.`}</p>
    <div class="reprice-btns">${primary}<button type="button" class="btn btn-ghost btn-small" data-rp="keep">Keep the price</button></div></div>`;
  box.querySelectorAll('[data-rp]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await store.get('items', d.id);
      if (!r) return;
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const what = b.dataset.rp;
      if (what === 'reduce') applyReduce(r.data, a.toCents, today);
      else if (what === 'refresh') markRefreshed(r.data, today);
      else snoozeReprice(r.data, today);
      r.data.updatedAt = now;
      await outbox.enqueueRecord('items', d.id, r.data);
      toast(what === 'reduce' ? `Recorded at ${centsToDollars(a.toCents)}` : what === 'refresh' ? 'Recorded: refreshed today' : 'Keeping the price. I will ask again in two weeks.');
      openDetail(d.id);
      renderList();
    });
  });
}

// ---------- offers (v27, FLIP-D33) ----------
// An offer used to live in a marketplace inbox and in Ben's head. Logged here
// it is weighed against the floor before he answers, and it puts the item at
// the top of the list until he does.
function offerLine(d, o) {
  const v = offerVerdict(d, o.amountCents);
  const n = expectedNet(o.platform, o.amountCents, { costCents: d.costCents, feeClass: feeClassOf(d) }, feeTable);
  const keep = n ? ` You would keep ${centsToDollars(n.netCents)}${n.profitCents != null ? `, ${centsToDollars(n.profitCents)} profit` : ''}.` : '';
  return { v, text: `${v.text}${keep}` };
}

function renderOffers(d) {
  const box = $('offersBox');
  const open = openOffers(d);
  const selling = d.status === 'acquired' || d.status === 'listed';
  if (!selling || !open.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="offers"><b>💬 Offer${open.length === 1 ? '' : 's'} waiting on you</b>${open.map((o) => {
    const { v, text } = offerLine(d, o);
    return `<div class="offer-row lv-${v.level}">
      <div><b>${centsToDollars(o.amountCents)}</b> on ${esc(platformLabel(o.platform))} <small>${esc((o.at || '').slice(0, 10))}</small>
        ${o.note ? `<br><small>${esc(o.note)}</small>` : ''}<br><span class="offer-verdict">${esc(text)}</span></div>
      <div class="offer-btns">
        <button type="button" class="btn btn-buy btn-small" data-oacc="${esc(o.id)}">Accept</button>
        <button type="button" class="btn btn-ghost btn-small" data-odec="${esc(o.id)}">Decline</button>
      </div></div>`;
  }).join('')}</div>`;
  const decide = async (oid, outcome) => {
    const r = await store.get('items', d.id);
    if (!r) return;
    const now = new Date().toISOString();
    closeOffer(r.data, oid, outcome, now.slice(0, 10));
    r.data.updatedAt = now;
    await outbox.enqueueRecord('items', d.id, r.data);
    toast(outcome === 'accepted' ? 'Accepted: marked sale pending' : 'Declined, and kept on the record');
    openDetail(d.id);
    renderList();
  };
  box.querySelectorAll('[data-oacc]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.oacc, 'accepted')));
  box.querySelectorAll('[data-odec]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.odec, 'declined')));
}

let offerItem = null;

function openOfferForm(d) {
  offerItem = d;
  $('offerForm').hidden = false;
  $('saleForm').hidden = true;
  $('listingForm').hidden = true;
  $('aiSection').hidden = true;
  $('copySection').hidden = true;
  // Where it is up comes first: that is where an offer comes from.
  const live = platformsFor(d).filter(([v]) => isListedOn(d, v));
  const rest = platformsFor(d).filter(([v]) => !isListedOn(d, v));
  $('ofPlatform').innerHTML = live.concat(rest).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('ofAmount').value = '';
  $('ofNote').value = '';
  $('ofVerdict').hidden = true;
}

function renderOfferVerdict() {
  const out = $('ofVerdict');
  const cents = dollarsToCents($('ofAmount').value);
  if (!offerItem || cents == null) { out.hidden = true; return; }
  const { v, text } = offerLine(offerItem, { platform: $('ofPlatform').value, amountCents: cents });
  out.hidden = false;
  out.className = `sale-net lv-${v.level}`;
  out.textContent = text;
}

async function saveOffer() {
  const cents = dollarsToCents($('ofAmount').value);
  if (cents == null || cents <= 0) { toast('How much did they offer?'); return; }
  const r = await store.get('items', detailId);
  if (!r) return;
  const now = new Date().toISOString();
  addOffer(r.data, { platform: $('ofPlatform').value, amountCents: cents, note: $('ofNote').value, at: now });
  r.data.updatedAt = now;
  await outbox.enqueueRecord('items', detailId, r.data);
  toast('Offer logged');
  openDetail(detailId);
  renderList();
}

// ---------- AI listings: carry the question out, bring the answer back (v26) ----------
let aiItemId = null;

function openAiSection(d) {
  aiItemId = d.id;
  $('aiSection').hidden = false;
  $('copySection').hidden = true;
  $('listingForm').hidden = true;
  $('saleForm').hidden = true;
  $('aiComps').value = '';
  $('aiAnswer').value = '';
  $('aiResult').innerHTML = '';
  $('aiFallback').hidden = true;
  // Only worth asking when there is something to replace.
  $('aiReplaceRow').hidden = priceLadder(d).length === 0;
  $('aiReplace').checked = false;
}

async function copyAiQuestion(e) {
  const r = await store.get('items', aiItemId);
  if (!r) return;
  const ids = platformsFor(r.data).map(([v]) => v);
  await copyToClipboard(buildPrompt(r.data, ids, $('aiComps').value.trim()), e.target, 'aiFallback');
}

async function applyAiAnswer() {
  const r = await store.get('items', aiItemId);
  if (!r) return;
  const out = $('aiResult');
  const text = $('aiAnswer').value;
  if (!text.trim()) { out.innerHTML = '<p class="err">Paste the answer from Claude into the box first.</p>'; return; }
  const ids = platformsFor(r.data).map(([v]) => v);
  const parsed = parseAnswer(text, ids);
  if (!parsed.ok) { out.innerHTML = `<p class="err">${esc(parsed.error)}</p>`; return; }
  const now = new Date().toISOString();
  applyAnswer(r.data, parsed, now, { replacePrices: $('aiReplace').checked });
  r.data.updatedAt = now;
  await outbox.enqueueRecord('items', aiItemId, r.data);
  const done = Object.keys(parsed.platformCopy).map(platformLabel);
  await openDetail(aiItemId);
  renderList();
  // openDetail closes every subform; put the result back where he is looking.
  $('aiSection').hidden = false;
  $('aiReplaceRow').hidden = priceLadder(r.data).length === 0;
  $('aiAnswer').value = '';
  $('aiResult').innerHTML = `<p class="ai-ok">✓ Written for ${esc(done.join(', ')) || 'no marketplaces'}. Scroll up to <b>Post it</b>.</p>`
    + (parsed.notes.length ? `<ul class="ai-notes">${parsed.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '');
  toast(`Listings written for ${done.length} marketplace${done.length === 1 ? '' : 's'} ✓`);
}

async function togglePosted(id, platform) {
  const r = await store.get('items', id);
  if (!r) return;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  if (isListedOn(r.data, platform)) {
    if (!confirm(`Took it down from ${platformLabel(platform)}?`)) return;
    markTakenDown(r.data, platform, today);
    toast(`Down from ${platformLabel(platform)}`);
  } else {
    r.data.listings = r.data.listings || [];
    r.data.listings.push({ platform, priceCents: askOn(r.data, platform), listedAt: today });
    if (r.data.status === 'acquired') {
      r.data.status = 'listed';
      r.data.statusChangedAt = now;
    }
    toast(`Posted on ${platformLabel(platform)} ✓`);
  }
  r.data.updatedAt = now;
  await outbox.enqueueRecord('items', id, r.data);
  openDetail(id);
  renderList();
}

// ---------- take-down checklist (v24, FLIP-D30) ----------
// The double-sale guard. Shows on a sold item while any other marketplace
// still has it up, and the item stays at the top of the list until it is clear.
function renderTakedowns(d) {
  const box = $('takedownBox');
  const todo = pendingTakedowns(d);
  if (!todo.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="takedown"><b>⚠ Sold. Take it down from:</b>${todo.map((l) =>
    `<label class="confirm-row"><input type="checkbox" data-down="${esc(l.platform)}"><span>${esc(platformLabel(l.platform))}</span>${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">open</a>` : ''}</label>`).join('')}
    <p class="posted-hint">Tick each one once it is gone.</p></div>`;
  box.querySelectorAll('[data-down]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      if (!cb.checked) return;
      const r = await store.get('items', d.id);
      if (!r) return;
      markTakenDown(r.data, cb.dataset.down, new Date().toISOString().slice(0, 10));
      r.data.updatedAt = new Date().toISOString();
      await outbox.enqueueRecord('items', d.id, r.data);
      toast(`Down from ${platformLabel(cb.dataset.down)} ✓`);
      openDetail(d.id);
      renderList();
    });
  });
}

// ---------- shot list (FR-007) ----------
const DEFAULT_SHOTS = {
  electronics: ['Front, powered ON', 'Model/serial label', 'All ports up close', 'Included cables laid out', 'Any flaws up close'],
  musical: ['Full front', 'Brand/model badge', 'Keys/strings up close', 'Powered on / in playing position', 'Included stand/pedal/case', 'Any flaws up close'],
  tools: ['Full tool', 'Model plate', 'Running (photo or short video)', 'Blades/bits/accessories', 'Any flaws up close'],
  furniture: ['Full front', 'Each side', 'Surface up close', 'Drawers/doors open', 'Tag/maker mark if any', 'Any flaws up close'],
  clothing: ['Full front, laid flat or on a hanger', 'Full back', 'Brand and size tag', 'Fabric tag', 'Measurements with a tape', 'Any flaws up close'],
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
  const shots = shotlists[d.category] || DEFAULT_SHOTS[d.category] || shotlists.other;
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
// withFloor: a sale can close at the floor, but a LISTING must never be priced
// at it, so the listing form leaves that button out.
function tierButtons(d, priceInputId, withFloor = false) {
  const box = document.createElement('div');
  box.className = 'tier-row';
  priceLadder(d).filter((t) => withFloor || t.id !== 'floor').forEach(({ label, cents }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-small';
    b.textContent = `${label} ${centsToDollars(cents)}`;
    b.addEventListener('click', () => {
      $(priceInputId).value = (cents / 100);
      $(priceInputId).dispatchEvent(new window.Event('input'));
    });
    box.appendChild(b);
  });
  return box;
}

function openListingForm(d) {
  $('listingForm').hidden = false;
  $('saleForm').hidden = true;
  $('aiSection').hidden = true;
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
  $('aiSection').hidden = true;
  $('offerForm').hidden = true;
  const last = (d.listings && d.listings.length) ? d.listings[d.listings.length - 1].platform : 'fbm';
  $('saPlatform').innerHTML = SELL_PLATFORMS.map(([v, l]) => `<option value="${v}"${v === last ? ' selected' : ''}>${l}</option>`).join('');
  // An accepted offer is almost always the sale: start the form from it.
  const acc = (d.offers || []).filter((o) => o.outcome === 'accepted').pop();
  if (acc) $('saPlatform').value = acc.platform;
  $('saPrice').value = acc ? (acc.amountCents / 100) : '';
  $('saFees').value = '';
  $('saShip').value = '';
  $('saDate').value = new Date().toISOString().slice(0, 10);
  const tb = $('saTiers');
  tb.innerHTML = '';
  tb.appendChild(tierButtons(d, 'saPrice', true));
  saleItem = d;
  renderSaleNet();
}

// The sale form says what Ben keeps BEFORE he saves, because the save freezes
// the partner payouts and there is no undo (FLIP-D26).
let saleItem = null;

export function saleNumbers(d, priceCents, feesCents, shippingCents) {
  const proceeds = priceCents - (feesCents || 0) - (shippingCents || 0);
  return { proceedsCents: proceeds, profitCents: proceeds - (d.costCents || 0) };
}

function renderSaleNet() {
  const d = saleItem;
  const out = $('saNet');
  const hint = $('saFeeHint');
  if (!d) { out.hidden = true; hint.hidden = true; return; }
  const price = dollarsToCents($('saPrice').value);
  if (price == null) { out.hidden = true; hint.hidden = true; return; }
  const fees = dollarsToCents($('saFees').value) || 0;
  const ship = dollarsToCents($('saShip').value) || 0;
  const n = saleNumbers(d, price, fees, ship);
  out.hidden = false;
  out.innerHTML = `You keep <b>${centsToDollars(n.proceedsCents)}</b> · profit <b class="${n.profitCents >= 0 ? 'v-buy' : 'v-loss'}">${centsToDollars(n.profitCents)}</b>`;

  // Offer the fee the table expects when the box is still empty. Never typed
  // in for him: a cash sale agreed through eBay messages has no fee at all.
  const platform = $('saPlatform').value;
  const est = feeFor(platform, price, { mode: 'shipped', feeClass: feeClassOf(d) }, feeTable);
  if ($('saFees').value.trim() === '' && est) {
    hint.hidden = false;
    hint.innerHTML = `If it went through ${esc(platformLabel(platform))} checkout, the fee is about <button type="button" class="btn btn-ghost btn-small" id="btnUseFee">${centsToDollars(est)}, use it</button>`;
    $('btnUseFee').addEventListener('click', () => {
      $('saFees').value = (est / 100).toFixed(2);
      renderSaleNet();
    });
  } else {
    hint.hidden = true;
  }
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
    shippingCents: dollarsToCents($('saShip').value) || 0,
  };
  // FREEZE POINT (FLIP-D18). Settle now and write the numbers onto the sale.
  // Everything downstream reads these, so editing shares later cannot rewrite
  // a payout that has already been agreed to or handed over.
  freezeSale(r.data);
  closeSoldListing(r.data, r.data.sale.soldAt);
  closeOffersOnSale(r.data, r.data.sale.soldAt);
  r.data.status = 'sold';
  r.data.statusChangedAt = now;
  r.data.updatedAt = now;
  await outbox.enqueueRecord('items', detailId, r.data);
  const m = r.data.sale.marginCents;
  toast(`Sold! Margin ${centsToDollars(m)} 🎉`);
  openDetail(detailId);
  renderList();
}

// ---------- settle up (Stage 2, FLIP-D18 / FLIP-D22) ----------
// Recording the payout is the half of "owed" that Stage 1 could not do: the
// math knew what she was owed, but there was no way to say you had paid her,
// so the balance could only ever grow.

let settleName = null;
let settleRows = [];
let settleChecked = new Set();

async function loadSettleRows() {
  const rows = await store.getAll('items');
  settleRows = partnerItemLedger(rows.map((r) => r.data), settleName);
  // Default to paying everything outstanding — settling one item out of three
  // is the exception, not the normal case.
  settleChecked = new Set(settleRows.filter((r) => r.owedCents > 0).map((r) => r.itemId));
  renderSettleRows();
}

async function openSettle(name) {
  settleName = partnerKey(name);
  $('settleTitle').textContent = `Settle up with ${settleName}`;
  $('seDate').value = new Date().toISOString().slice(0, 10);
  $('settleReceipt').hidden = true;
  $('settleFallback').hidden = true;
  await loadSettleRows();
  sub('invSettle');
}

function renderSettleRows() {
  const box = $('settleRows');
  const payable = settleRows.filter((r) => r.owedCents > 0);
  $('settlePayWrap').hidden = !payable.length;

  if (!settleRows.length) {
    box.innerHTML = `<p class="hint">Nothing on the books for ${esc(settleName)} yet. Her share appears here once an item she is in on actually sells.</p>`;
    return;
  }

  box.innerHTML = settleRows.map((r) => {
    const head = `${esc(r.flipId || '')} ${esc(r.itemName)}`.trim();
    if (r.owedCents <= 0) {
      // Kept on screen rather than hidden: "I already paid you for that one" is
      // the most useful thing this list can tell either of them.
      return `<div class="settle-row settled"><span class="sr-main">${head}<br><small>${r.paidCents ? centsToDollars(r.paidCents) + ' paid' : 'nothing owed'}</small></span><b>✓</b></div>`;
    }
    const bits = [];
    if (r.capitalCents) bits.push(`${centsToDollars(r.capitalCents)} of it is her money back`);
    if (r.profitCents) bits.push(`${centsToDollars(r.profitCents)} profit`);
    if (r.paidCents > 0) bits.push(`${centsToDollars(r.paidCents)} already paid`);
    return `<label class="settle-row">
      <input type="checkbox" data-settle-item="${esc(r.itemId)}"${settleChecked.has(r.itemId) ? ' checked' : ''}>
      <span class="sr-main">${head}<br><small>${bits.join(' · ')}</small></span>
      <b>${centsToDollars(r.owedCents)}</b></label>`;
  }).join('');

  box.querySelectorAll('input[data-settle-item]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) settleChecked.add(cb.dataset.settleItem);
      else settleChecked.delete(cb.dataset.settleItem);
      updateSettleTotal();
    });
  });
  updateSettleTotal();
}

function chosenRows() {
  return settleRows.filter((r) => settleChecked.has(r.itemId) && r.owedCents > 0);
}

function updateSettleTotal() {
  const total = chosenRows().reduce((s, r) => s + r.owedCents, 0);
  const btn = $('btnSettlePay');
  btn.textContent = total ? `Mark ${centsToDollars(total)} paid` : 'Mark paid';
  btn.disabled = !total;
}

async function doSettle() {
  const chosen = chosenRows();
  if (!chosen.length) { toast('Tick at least one item'); return; }
  const total = chosen.reduce((s, r) => s + r.owedCents, 0);
  const sel = $('seMethod');
  const methodLabel = sel.options[sel.selectedIndex].text;

  // Payments are append-only by design, so there is no un-tap. Ask first.
  if (!confirm(`Mark ${centsToDollars(total)} paid to ${settleName}? This goes into the ledger as a payment — the way to undo it later is a matching reversal, not a delete.`)) return;

  const payout = buildPayout(settleName, chosen, {
    payoutId: ulid(),
    paidAt: $('seDate').value || new Date().toISOString().slice(0, 10),
    method: sel.value,
    methodLabel,
    nextId: ulid,
  });

  for (const p of payout.payments) {
    const r = await store.get('items', p.itemId);
    if (!r) continue;
    r.data.payments = (r.data.payments || []).concat([p.payment]);
    r.data.updatedAt = new Date().toISOString();
    await outbox.enqueueRecord('items', p.itemId, r.data);
  }

  const text = formatReceipt(payout);
  await loadSettleRows();
  $('settleReceiptOut').textContent = text;
  $('settleReceipt').hidden = false;
  $('btnCopyReceipt').onclick = (e) => copyToClipboard(text, e.target, 'settleFallback');
  toast(`Paid ${centsToDollars(total)} ✓`);
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
  // Research-tab handoff (v17): open a new item with the researched name.
  const preName = sessionStorage.getItem('fs.prefillName');
  if (preName) {
    sessionStorage.removeItem('fs.prefillName');
    const d = blankItem();
    d.name = preName;
    d.category = 'other';
    d.id = null; // force create path
    openForm(d);
    return;
  }
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
  const acq = $('itAcquisition');
  ACQUISITIONS.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    acq.appendChild(o);
  });
  acq.addEventListener('input', syncCostToAcquisition);
  $('btnNewItem').addEventListener('click', () => openForm(null));
  $('btnAddPartner').addEventListener('click', () => { formPartners.push({ name: '', sharePct: 0, investedCents: null }); renderPartners(); });
  $('itCost').addEventListener('input', warnPartners);
  ['itAsk', 'itPatient', 'itQuick', 'itFloor', 'itCost'].forEach((id) => $(id).addEventListener('input', warnPrices));
  acq.addEventListener('input', warnPrices);
  ['saPrice', 'saFees', 'saShip', 'saPlatform'].forEach((id) => $(id).addEventListener('input', renderSaleNet));
  $('btnItemSave').addEventListener('click', saveForm);
  $('btnItemCancel').addEventListener('click', () => sub('invList'));
  $('btnLiSave').addEventListener('click', saveListing);
  $('btnLiCancel').addEventListener('click', () => { $('listingForm').hidden = true; });
  $('btnSaSave').addEventListener('click', saveSale);
  $('btnSaCancel').addEventListener('click', () => { $('saleForm').hidden = true; });
  $('btnSettlePay').addEventListener('click', doSettle);
  $('btnSettleBack').addEventListener('click', () => { sub('invList'); renderList(); });
  $('btnSettleDone').addEventListener('click', () => { sub('invList'); renderList(); });
  $('btnGenerate').addEventListener('click', generateCopy);
  $('btnCopyClose').addEventListener('click', () => { $('copySection').hidden = true; });
  $('btnOfSave').addEventListener('click', saveOffer);
  $('btnOfCancel').addEventListener('click', () => { $('offerForm').hidden = true; });
  ['ofAmount', 'ofPlatform'].forEach((id) => $(id).addEventListener('input', renderOfferVerdict));
  $('btnAiCopy').addEventListener('click', copyAiQuestion);
  $('btnAiApply').addEventListener('click', applyAiAnswer);
  $('btnAiClose').addEventListener('click', () => { $('aiSection').hidden = true; });
  $('copyTier').addEventListener('input', () => { $('copyCustom').hidden = $('copyTier').value !== 'custom'; });
  $('copyPlatform').addEventListener('input', () => { if (!$('copyOut').hidden) generateCopy(); });
  loadShotlists();
  loadPartners();
  loadFees();
  $('btnDetBack').addEventListener('click', () => { sub('invList'); renderList(); });
  $('btnDetBackTop').addEventListener('click', () => { sub('invList'); renderList(); });
  $('btnDetEdit').addEventListener('click', async () => {
    const r = await store.get('items', detailId);
    if (r) openForm({ ...r.data });
  });
  window.addEventListener('view:show', (e) => {
    if (e.detail.view === 'inventory') { backfillFrozenSales().then(renderList); checkPendingAcquire(); }
  });
  window.addEventListener('outbox:change', () => {
    if (!$('view-inventory').hidden && !$('invList').hidden) renderList();
  });
  backfillFrozenSales().then(renderList);
}
