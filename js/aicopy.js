// aicopy.js — the AI step, by copy and paste (v26, FLIP-D32).
// Pure: no DOM, no storage, no network. tests/aicopy.test.mjs proves it with
// nothing but node.
//
// This app has no server and its code is public, so it cannot hold an AI key.
// Instead it writes the question, Ben pastes it into the Claude app with the
// photos, and pastes the answer back. The answer is JSON in one fixed shape,
// so one paste fills every marketplace and all four prices.
//
// The AI is not trusted with the rules. Everything it returns passes through
// parseAnswer(), which is where an 80-character eBay title, a negative price
// or a floor above the ask gets caught. If a key ever goes on the phone
// (route B), it produces this same shape and goes through this same door.

import { guard } from './copywriter.js';
import { platformLabel } from './listing.js';

// Only limits that are certain. Guessing at a marketplace's limit and
// truncating good copy to fit a wrong number would be worse than no limit.
export const LIMITS = {
  ebay: { title: 80 },
  depop: { tags: 5, description: 1000 },
};

const HOW = {
  fbm: 'Facebook Marketplace. Local buyers on a phone. Friendly, short, plain. Lead with what it is and the condition. Mention pickup.',
  offerup: 'OfferUp. Local, fast, very short attention. Title under 50 characters if possible. Two or three sentences.',
  craigslist: 'Craigslist. Plain text only, no emoji. Complete details, dimensions, what is included, cash and local pickup.',
  ebay: 'eBay. Title at most 80 characters, keyword-dense: brand, model, key specs, condition. Description factual and complete, with a spec list. Buyers are nationwide and it ships.',
  vinted: 'Vinted. Clothing and accessories buyers. Brand, size, condition, material, measurements. Warm and brief.',
  depop: 'Depop. Younger fashion buyers. No separate title is shown, so the first line of the description is the hook. Up to 5 hashtags in "tags", without the # sign.',
};

const dollars = (c) => (c == null ? null : c / 100);

// ---------- the question ----------
// `platforms` is the list of ids to write for; the caller decides which
// marketplaces fit the item.
export function buildPrompt(d, platforms, comps) {
  const f = d.copyFields || {};
  const facts = [
    ['Item', d.name],
    ['Category', d.category],
    ['Brand', f.brand], ['Model', f.model], ['Condition', f.condition],
    ['Working status', f.worksStatus], ['Included', f.accessories],
    ['Dimensions', f.dimensions], ['Size', f.size], ['Material', f.material],
    ['Flaws to disclose', f.quirks],
    ['My current description', d.description],
  ].filter(([, v]) => v && String(v).trim());

  const priv = [
    ['What I paid', d.costCents != null ? '$' + dollars(d.costCents) : null],
    ['Private notes', d.notes],
    ['Prices I already have in mind',
      [['ask', d.priceAskCents], ['fair', d.pricePatientCents], ['quick', d.priceQuickCents], ['floor', d.priceFloorCents]]
        .filter(([, c]) => c != null).map(([k, c]) => `${k} $${dollars(c)}`).join(', ')],
    ['Comparable sales I found', comps],
  ].filter(([, v]) => v && String(v).trim());

  const shape = {
    prices: {
      ask: 0, fair: 0, quick: 0, floor: 0, rangeLow: 0, rangeHigh: 0,
      basis: 'one sentence: what these numbers are based on',
      comps: [{ source: 'where', price: 0, note: 'condition or date' }],
    },
    platforms: Object.fromEntries(platforms.map((p) => [p, { title: '', description: '', category: '', tags: [], ask: 0 }])),
  };

  return [
    'I resell used items locally and online. Photos of this item are attached. Write my listings and price it.',
    '',
    'WHAT I KNOW ABOUT IT',
    ...facts.map(([k, v]) => `- ${k}: ${String(v).trim()}`),
    '',
    'PRIVATE, for your judgment only. Never repeat any of this in a listing:',
    ...(priv.length ? priv.map(([k, v]) => `- ${k}: ${String(v).trim()}`) : ['- (nothing)']),
    '',
    'PRICING',
    '- Base prices on what this actually SELLS for used, not on asking prices. Search for recent sold listings if you can, and list the ones you used in "comps".',
    '- ask = a higher opening price with room to come down. fair = what it should realistically sell for. quick = sells this week. floor = the lowest I should accept.',
    '- rangeLow and rangeHigh = the realistic selling range.',
    '- If you could not find real sold prices, say so in "basis". Do not invent comps.',
    '- "ask" inside each platform is the price to list at THERE. It can differ: a platform that charges a fee or ships can carry a higher ask than a local pickup.',
    '',
    'LISTINGS, one per platform:',
    ...platforms.map((p) => `- ${p}: ${HOW[p] || platformLabel(p)}`),
    '',
    'RULES',
    '- Only say what the photos and my notes support. Do not invent specs, accessories or history.',
    '- Disclose every flaw I listed. Plainly, once.',
    '- No em dashes. No ALL CAPS sentences. No "L@@K", no "rare" unless it is.',
    '- Do not mention what I paid, where I got it, or anything marked private.',
    '- Prices are plain numbers in US dollars, no $ sign, no ranges.',
    '',
    'Answer with ONLY this JSON, filled in, and nothing before or after it:',
    JSON.stringify(shape, null, 1),
  ].join('\n');
}

// ---------- the answer ----------

// Claude wraps JSON in a code fence about half the time and sometimes adds a
// sentence first. Take the outermost { ... } and ignore the rest.
export function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* fall through */ }
  // Phones turn straight quotes curly. Undo that and try once more.
  try {
    return JSON.parse(s.slice(a, b + 1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  } catch (e) { return null; }
}

// A price from the AI: a number of dollars, or a string like "$1,250".
// Anything that is not a positive amount is null, never 0.
export function toCents(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function clipTitle(t, max) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim();
}

const clean = (s) => guard(String(s == null ? '' : s)).split('\n').map((l) => guard(l)).join('\n').trim();

// parseAnswer(text, platforms) ->
//   { ok, error?, prices, platformCopy, notes[] }
// `notes` are things that were fixed or look wrong, in words Ben can read.
// ok:false means nothing usable came back and nothing should be saved.
export function parseAnswer(text, platforms) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'That does not look like the answer. Copy everything from the first { to the last } and paste again.' };
  }
  const notes = [];
  const want = platforms || Object.keys(raw.platforms || {});

  // ---- prices
  const p = raw.prices || {};
  const prices = {
    askCents: toCents(p.ask), fairCents: toCents(p.fair), quickCents: toCents(p.quick), floorCents: toCents(p.floor),
    rangeLowCents: toCents(p.rangeLow), rangeHighCents: toCents(p.rangeHigh),
    basis: clean(p.basis).slice(0, 400),
    comps: (Array.isArray(p.comps) ? p.comps : []).slice(0, 8).map((c) => ({
      source: clean(c && c.source).slice(0, 80),
      priceCents: toCents(c && c.price),
      note: clean(c && c.note).slice(0, 160),
    })).filter((c) => c.priceCents != null),
  };
  const order = [['ask', prices.askCents], ['fair', prices.fairCents], ['quick', prices.quickCents], ['floor', prices.floorCents]]
    .filter(([, c]) => c != null);
  for (let i = 0; i < order.length - 1; i++) {
    if (order[i][1] < order[i + 1][1]) notes.push(`Its ${order[i + 1][0]} price is higher than its ${order[i][0]} price. Check the numbers before you use them.`);
  }
  if (!order.length) notes.push('It gave no prices.');
  if (order.length && !prices.comps.length) notes.push('It listed no sold comps, so treat the prices as a guess.');

  // ---- listings
  const platformCopy = {};
  const src = raw.platforms && typeof raw.platforms === 'object' ? raw.platforms : {};
  want.forEach((id) => {
    const c = src[id];
    if (!c || typeof c !== 'object') { notes.push(`Nothing came back for ${platformLabel(id)}.`); return; }
    const lim = LIMITS[id] || {};
    let title = clean(c.title).replace(/\n+/g, ' ');
    let description = clean(c.description);
    if (!title && !description) { notes.push(`${platformLabel(id)} came back empty.`); return; }
    if (lim.title && title.length > lim.title) {
      notes.push(`${platformLabel(id)} title was ${title.length} characters; trimmed to ${lim.title}.`);
      title = clipTitle(title, lim.title);
    }
    if (lim.description && description.length > lim.description) {
      notes.push(`${platformLabel(id)} description is ${description.length} characters; the limit is ${lim.description}. Shorten it before posting.`);
    }
    let tags = (Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(/[,\s]+/))
      .map((t) => clean(t).replace(/^#+/, '').trim()).filter(Boolean);
    tags = [...new Set(tags)];
    if (lim.tags && tags.length > lim.tags) tags = tags.slice(0, lim.tags);
    platformCopy[id] = {
      title, description,
      category: clean(c.category).slice(0, 120),
      tags: tags.slice(0, 20),
      askCents: toCents(c.ask),
    };
  });

  if (!Object.keys(platformCopy).length && !order.length) {
    return { ok: false, error: 'The answer had no listings and no prices in it. Ask again and paste the whole reply.' };
  }
  return { ok: true, prices, platformCopy, notes };
}

// Write a parsed answer onto the item.
//   opts.replacePrices  false = only fill price boxes that are still blank
// A price Ben typed himself is never overwritten unless he says so.
export function applyAnswer(d, parsed, when, opts = {}) {
  const replace = !!opts.replacePrices;
  const set = (field, cents) => {
    if (cents == null) return;
    if (replace || d[field] == null) d[field] = cents;
  };
  set('priceAskCents', parsed.prices.askCents);
  set('pricePatientCents', parsed.prices.fairCents);
  set('priceQuickCents', parsed.prices.quickCents);
  set('priceFloorCents', parsed.prices.floorCents);
  d.pricing = {
    rangeLowCents: parsed.prices.rangeLowCents,
    rangeHighCents: parsed.prices.rangeHighCents,
    basis: parsed.prices.basis,
    comps: parsed.prices.comps,
    suggested: {
      askCents: parsed.prices.askCents, fairCents: parsed.prices.fairCents,
      quickCents: parsed.prices.quickCents, floorCents: parsed.prices.floorCents,
    },
    generatedAt: when,
  };
  d.platformCopy = { ...(d.platformCopy || {}), ...parsed.platformCopy };
  Object.keys(parsed.platformCopy).forEach((id) => { d.platformCopy[id].generatedAt = when; });
  return d;
}
