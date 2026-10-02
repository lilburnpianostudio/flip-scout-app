// pipeline.js — where each item stands, and what needs Ben next (v27, FLIP-D33).
// Pure: no DOM, no storage, no network. tests/pipeline.test.mjs proves it with
// nothing but node.
//
// Before v27 a listing was either up or down, and an offer lived in Ben's
// head or in a marketplace inbox. So the list could not answer the only
// question it is opened for: what do I have to do today?
//
// Stored: offers[] (append-only, like payments) and listing.status
// ('pending' or absent). Everything else here is derived on render, never
// cached, so it cannot drift from the record.

import { activeListings, copyFor, pendingTakedowns, priceLadder } from './listing.js';

const money = (c) => '$' + (c % 100 === 0 ? (c / 100) : (c / 100).toFixed(2));

// ---------- offers ----------

export const isOpen = (o) => !o.outcome || o.outcome === 'open';

export function openOffers(d) {
  return (d.offers || []).filter(isOpen);
}

// The highest open offer: the one worth answering first.
export function bestOffer(d) {
  return openOffers(d).reduce((best, o) => (!best || o.amountCents > best.amountCents ? o : best), null);
}

// Offers are appended and closed, never edited or deleted, so "what did they
// offer, and what did I say" always has an answer. Ids are sequential and
// therefore stable.
export function addOffer(d, { platform, amountCents, note, at }) {
  d.offers = d.offers || [];
  const o = { id: 'o' + (d.offers.length + 1), platform, amountCents, note: (note || '').trim(), at, outcome: 'open' };
  d.offers.push(o);
  return o;
}

// outcome: 'accepted' | 'declined' | 'expired'
// Accepting an offer marks the listing it came in on as pending: a buyer is
// on the way, and the other marketplaces should not take a second one.
export function closeOffer(d, id, outcome, when) {
  const o = (d.offers || []).find((x) => x.id === id);
  if (!o || !isOpen(o)) return d;
  o.outcome = outcome;
  o.closedAt = when;
  if (outcome === 'accepted') setPending(d, o.platform, true);
  return d;
}

// A sale ends every open offer. They were not declined; the item is gone.
export function closeOffersOnSale(d, when) {
  (d.offers || []).forEach((o) => {
    if (isOpen(o)) { o.outcome = 'expired'; o.closedAt = when; }
  });
  return d;
}

// How an offer compares with the prices on the item, in words.
//   level: 'take' | 'fair' | 'low' | 'below-floor' | 'unknown'
export function offerVerdict(d, amountCents) {
  const tier = (id) => (priceLadder(d).find((t) => t.id === id) || {}).cents;
  const ask = tier('ask');
  const fair = tier('fair');
  const quick = tier('quick');
  const floor = tier('floor');
  if (floor != null && amountCents < floor) return { level: 'below-floor', text: `Below your floor (${money(floor)}).` };
  if (ask != null && amountCents >= ask) return { level: 'take', text: 'Your full asking price.' };
  if (fair != null && amountCents >= fair) return { level: 'take', text: `At or above your fair price (${money(fair)}).` };
  if (quick != null && amountCents >= quick) return { level: 'fair', text: `Between your quick price (${money(quick)}) and your fair price.` };
  if (floor != null) return { level: 'low', text: `Above your floor (${money(floor)}), below your quick price.` };
  if (quick != null || fair != null || ask != null) return { level: 'low', text: 'Below every price on this item. No floor is set.' };
  return { level: 'unknown', text: 'No prices on this item to compare it with.' };
}

// ---------- pending ----------

export function setPending(d, platform, on) {
  activeListings(d).forEach((l) => {
    if (l.platform !== platform) return;
    if (on) l.status = 'pending'; else delete l.status;
  });
  return d;
}

export const isPending = (d, platform) =>
  activeListings(d).some((l) => l.platform === platform && l.status === 'pending');

// ---------- status per marketplace ----------
// 'sold' | 'pending' | 'offer' | 'live' | 'removed' | 'ready' | 'not-prepared'
export function platformStatus(d, platform) {
  if (d.status === 'sold' && d.sale && d.sale.platform === platform) return 'sold';
  const live = activeListings(d).filter((l) => l.platform === platform);
  if (live.length) {
    if (live.some((l) => l.status === 'pending')) return 'pending';
    if (openOffers(d).some((o) => o.platform === platform)) return 'offer';
    return 'live';
  }
  if ((d.listings || []).some((l) => l.platform === platform && l.removedAt)) return 'removed';
  return copyFor(d, platform) ? 'ready' : 'not-prepared';
}

export const STATUS_LABEL = {
  sold: 'sold here', pending: 'sale pending', offer: 'offer waiting', live: 'live',
  removed: 'taken down', ready: 'ready to post', 'not-prepared': 'not written yet',
};

// ---------- what the item needs ----------
// The group an unsold item belongs in on the list, most urgent first:
//   'takedown'  sold, still up somewhere else
//   'offer'     someone is waiting on an answer
//   'pending'   a buyer is on the way
//   'live'      up, waiting on a buyer
//   'ready'     copy is written, nothing is posted
//   'unlisted'  nothing written, nothing posted
// null for scouted, dead, and sold-and-clear items: the list handles those.
export function attention(d) {
  if (d.status === 'sold') return pendingTakedowns(d).length ? 'takedown' : null;
  if (d.status !== 'acquired' && d.status !== 'listed') return null;
  if (openOffers(d).length) return 'offer';
  const live = activeListings(d);
  if (live.some((l) => l.status === 'pending')) return 'pending';
  if (live.length) return 'live';
  const written = Object.keys(d.platformCopy || {}).some((p) => copyFor(d, p));
  return written ? 'ready' : 'unlisted';
}
