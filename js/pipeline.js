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

// ---------- repricing (v28, FLIP-D34) ----------
// The list has always shown how many days an item has sat. Nothing acted on
// it, so a listing could sit at its opening ask for two months. This says
// what to do about it, and stays quiet when there is nothing to do.

export const DEFAULT_REPRICE = { staleDays: 14, refreshDays: 30 };

const DAY = 86400000;
const dayOf = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime() : NaN);
const daysBetween = (fromIso, now) => {
  const t = dayOf(fromIso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
};

// How long the item has been up AT ITS CURRENT PRICE AND PHOTOS. The clock
// starts at the oldest live listing and restarts when Ben reprices, refreshes,
// or says "keep it", so advice he has already answered does not come back the
// next morning.
export function daysLive(d, now) {
  const live = activeListings(d);
  if (!live.length) return null;
  const starts = live.map((l) => [l.listedAt, l.repricedAt, l.refreshedAt].filter(Boolean).sort().pop())
    .filter(Boolean).sort();
  if (!starts.length) return null;
  let from = starts[0];
  if (d.repriceSnoozedAt && d.repriceSnoozedAt > from) from = d.repriceSnoozedAt;
  return daysBetween(from, now);
}

// The price buyers are looking at: the lowest live one. A padded eBay ask is
// not the number a local buyer is passing on.
export function livePrice(d) {
  const ps = activeListings(d).map((l) => l.priceCents).filter((c) => c != null);
  return ps.length ? Math.min(...ps) : null;
}

// The next rung down. The floor is never a listing price, so it is never a
// target: reaching it means the valuation is wrong, not that the price should
// be the floor.
export function nextTierDown(d, fromCents) {
  if (fromCents == null) return null;
  return priceLadder(d).filter((t) => t.id !== 'floor' && t.cents < fromCents)
    .sort((a, b) => b.cents - a.cents)[0] || null;
}

// repriceAdvice(d, now, cfg) -> null, or
//   { action: 'reduce' | 'refresh' | 'revalue', days, text, toCents?, tierLabel? }
// null means leave it alone: not up, an offer is open, a sale is pending,
// someone offered recently, or it simply has not been long enough.
export function repriceAdvice(d, now, cfg = DEFAULT_REPRICE) {
  const stale = Number(cfg && cfg.staleDays) > 0 ? Number(cfg.staleDays) : DEFAULT_REPRICE.staleDays;
  const refresh = Number(cfg && cfg.refreshDays) > 0 ? Number(cfg.refreshDays) : DEFAULT_REPRICE.refreshDays;
  if (d.status !== 'acquired' && d.status !== 'listed') return null;
  const live = activeListings(d);
  if (!live.length || openOffers(d).length || live.some((l) => l.status === 'pending')) return null;
  const days = daysLive(d, now);
  if (days == null) return null;

  // Offers are the market talking. Two or more, every one under the floor,
  // says the floor is wrong, and no number of days makes that less true.
  const floor = d.priceFloorCents;
  const past = (d.offers || []).filter((o) => !isOpen(o) && o.outcome !== 'accepted');
  if (floor != null && past.length >= 2 && past.every((o) => o.amountCents < floor)) {
    const best = Math.max(...past.map((o) => o.amountCents));
    return { action: 'revalue', days,
      text: `${past.length} offers, every one under your floor (${money(floor)}). The best was ${money(best)}. The market may be telling you what it is worth: check sold prices again.` };
  }

  if (days < stale) return null;
  // Any offer in the last stretch is interest. Leave the price alone.
  const recent = (d.offers || []).some((o) => { const n = daysBetween(o.at, now); return n != null && n < stale; });
  if (recent) return null;

  const at = livePrice(d);
  const next = nextTierDown(d, at);
  if (next) {
    return { action: 'reduce', days, toCents: next.cents, tierLabel: next.label,
      text: `Up ${days} days at ${money(at)} with no offers. Drop it to your ${next.label.toLowerCase()} price, ${money(next.cents)}${days >= refresh ? ', and repost it so it shows as new' : ''}.` };
  }
  if (days >= refresh) {
    return { action: 'revalue', days,
      text: `Up ${days} days${at != null ? ' at ' + money(at) : ''}, already at your lowest listed price, with no offers. It is probably still priced too high: check sold prices again.` };
  }
  return { action: 'refresh', days,
    text: `Up ${days} days${at != null ? ' at ' + money(at) : ''} with no offers, and already at your lowest listed price. Refresh it: a better first photo, then repost.` };
}

// Ben changed the price on the marketplaces; record it. Every live listing
// comes down by the same amount, so a marketplace that was priced higher to
// cover its fee stays higher by the same margin.
export function applyReduce(d, toCents, today) {
  const at = livePrice(d);
  if (at == null || toCents == null || toCents >= at) return d;
  const delta = at - toCents;
  activeListings(d).forEach((l) => {
    if (l.priceCents != null) l.priceCents = Math.max(0, l.priceCents - delta);
    l.repricedAt = today;
  });
  return d;
}

export function markRefreshed(d, today) {
  activeListings(d).forEach((l) => { l.refreshedAt = today; });
  return d;
}

// "Keep the price": his call, and the advice goes quiet for a full stretch.
export function snoozeReprice(d, today) {
  d.repriceSnoozedAt = today;
  return d;
}
