// listing.js — pure helpers for posting one item to several marketplaces
// (FLIP-D30, 2026-09-22). No DOM, no storage, no network: same record in, same
// answer out, so tests/listing.test.mjs proves it with nothing but node.
//
// The problem this answers: the same item goes up on FB, OfferUp, Craigslist
// and eBay, and when it sells on one the others must come down, or it sells
// twice. Photos stay in an iPhone Photos album named after the FLIP number;
// the record holds the album NAME, never the pictures.

export const SELL_PLATFORMS = [
  ['fbm', 'FB Marketplace'],
  ['offerup', 'OfferUp'],
  ['craigslist', 'Craigslist'],
  ['ebay', 'eBay'],
  ['vinted', 'Vinted'],
  ['depop', 'Depop'],
];

// Vinted and Depop are for clothing and accessories (v26, FLIP-D32). A table
// saw does not belong on either, and two chips that are always wrong teach
// Ben to ignore the row. So they are offered when the item is clothing, or
// when the item already has a listing or copy there, and not otherwise.
const CLOTHING_ONLY = ['vinted', 'depop'];

export function platformsFor(d) {
  const used = new Set([
    ...(d.listings || []).map((l) => l.platform),
    ...Object.keys(d.platformCopy || {}),
  ]);
  return SELL_PLATFORMS.filter(([id]) =>
    !CLOTHING_ONLY.includes(id) || d.category === 'clothing' || used.has(id));
}

// Where each marketplace's "new listing" form lives. No API posts for an
// individual seller on five of the six, and their terms forbid driving the
// form, so the app copies the text and opens the page. No city, no ZIP: this
// repo is public. Craigslist picks the nearest site on its own.
const SELL_URLS = {
  fbm: 'https://www.facebook.com/marketplace/create/item',
  offerup: 'https://offerup.com/post',
  craigslist: 'https://post.craigslist.org/',
  ebay: 'https://www.ebay.com/sl/sell',
  vinted: 'https://www.vinted.com/items/new',
  depop: 'https://www.depop.com/products/create/',
};
export const sellUrl = (id) => SELL_URLS[id] || null;

export const platformLabel = (id) => (SELL_PLATFORMS.find(([v]) => v === id) || [id, id])[1];

const money = (c) => '$' + (c % 100 === 0 ? (c / 100) : (c / 100).toFixed(2));

// A listing is live until it has a removedAt. Records written before v24 have
// no such field, and every one of them is still live by that rule.
export function activeListings(d) {
  return (d.listings || []).filter((l) => !l.removedAt);
}

export function isListedOn(d, platform) {
  return activeListings(d).some((l) => l.platform === platform);
}

// What to ask. The newest live listing wins, because that is the number
// buyers are actually looking at; then the opening ask (v25), then the fair
// price, then the quick one. Items from before v25 have no opening ask and
// fall through to the fair price, which is what they always asked.
export function askingCents(d) {
  const live = activeListings(d);
  if (live.length && live[live.length - 1].priceCents != null) return live[live.length - 1].priceCents;
  if (d.priceAskCents != null) return d.priceAskCents;
  if (d.pricePatientCents != null) return d.pricePatientCents;
  if (d.priceQuickCents != null) return d.priceQuickCents;
  return null;
}

// The four prices on an item, highest to lowest (v25, FLIP-D31):
//   ask    the opening price, with room to come down
//   fair   what it should actually sell for (pricePatientCents since v1)
//   quick  move it this week
//   floor  the least Ben will take; never shown in a listing
// Any of them may be blank. This is the one place that knows their order.
export const PRICE_TIERS = [
  ['ask', 'priceAskCents', 'Ask'],
  ['fair', 'pricePatientCents', 'Fair'],
  ['quick', 'priceQuickCents', 'Quick'],
  ['floor', 'priceFloorCents', 'Floor'],
];

export function priceLadder(d) {
  return PRICE_TIERS
    .map(([id, field, label]) => ({ id, field, label, cents: d[field] }))
    .filter((t) => t.cents != null);
}

// Prices that contradict each other. A floor above the asking price means
// every offer the listing can attract is one Ben has already refused.
export function ladderProblems(d) {
  const l = priceLadder(d);
  const out = [];
  for (let i = 0; i < l.length - 1; i++) {
    if (l[i].cents < l[i + 1].cents) out.push(`${l[i + 1].label} (${money(l[i + 1].cents)}) is higher than ${l[i].label} (${money(l[i].cents)})`);
  }
  const floor = d.priceFloorCents;
  if (floor != null && d.costCents != null && d.costCents > 0 && floor < d.costCents) {
    out.push(`Floor (${money(floor)}) is below what you paid (${money(d.costCents)})`);
  }
  return out;
}

// The Photos album name. Typed once when the album is made, found by scrolling
// Albums later, so it must start with the FLIP number and stay short enough to
// read in the iOS picker. Ben can override it on the item.
export function albumName(d) {
  if (d.photoAlbum && d.photoAlbum.trim()) return d.photoAlbum.trim();
  const words = String(d.name || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  const id = d.flipId || 'FLIP-new';
  return words ? `${id} ${words}` : id;
}

// Everything a marketplace form wants, in the order the forms ask for it:
// title, price, description. One paste, then fix the field boundaries.
export function everythingText(d) {
  const lines = [String(d.name || '').trim()];
  const c = askingCents(d);
  if (c != null) lines.push(money(c));
  if (d.description && d.description.trim()) lines.push('', d.description.trim());
  return lines.join('\n').trim();
}

// The copy written for one marketplace (v26), or null. Blank copy is no copy.
export function copyFor(d, platform) {
  const c = d.platformCopy && d.platformCopy[platform];
  if (!c || (!String(c.title || '').trim() && !String(c.description || '').trim())) return null;
  return c;
}

// The price to list at on one marketplace: what is live there now, then the
// price written for that marketplace, then the item's general asking price.
export function askOn(d, platform) {
  const live = activeListings(d).filter((l) => l.platform === platform);
  if (live.length && live[live.length - 1].priceCents != null) return live[live.length - 1].priceCents;
  const c = copyFor(d, platform);
  if (c && c.askCents != null) return c.askCents;
  // Then the prices on the item itself. NOT the newest live listing: that is
  // another marketplace's price, and an eBay ask padded for fees is the wrong
  // number to show for a porch pickup.
  const own = [d.priceAskCents, d.pricePatientCents, d.priceQuickCents].find((v) => v != null);
  return own != null ? own : askingCents(d);
}

// One paste for one marketplace: title, price, description, then tags where
// the marketplace uses them. Falls back to the item's own text, so the button
// works on every item, written-for or not.
export function platformText(d, platform) {
  const c = copyFor(d, platform);
  if (!c) return everythingText(d);
  const lines = [];
  if (c.title) lines.push(c.title);
  const ask = askOn(d, platform);
  if (ask != null) lines.push(money(ask));
  if (c.description) lines.push('', c.description);
  if (c.tags && c.tags.length) lines.push('', c.tags.map((t) => (platform === 'depop' ? '#' : '') + t).join(platform === 'depop' ? ' ' : ', '));
  return lines.join('\n').trim();
}

// Mark every live listing on the platform it sold on as down. The marketplace
// it sold on is the one Ben is already looking at; the OTHERS are the danger.
export function closeSoldListing(d, soldAt) {
  const platform = d.sale && d.sale.platform;
  (d.listings || []).forEach((l) => {
    if (!l.removedAt && l.platform === platform) {
      l.removedAt = soldAt;
      l.removedWhy = 'sold here';
    }
  });
  return d;
}

// What still has to come down. Only a SOLD item can owe a take-down; a dead
// item is Ben's call and nobody is about to pay for it twice.
export function pendingTakedowns(d) {
  if (d.status !== 'sold') return [];
  return activeListings(d);
}

export function markTakenDown(d, platform, when) {
  (d.listings || []).forEach((l) => {
    if (!l.removedAt && l.platform === platform) {
      l.removedAt = when;
      l.removedWhy = d.status === 'sold' ? 'sold elsewhere' : 'taken down';
    }
  });
  return d;
}
