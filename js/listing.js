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
];

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
// buyers are actually looking at; then the patient price, then the quick one.
export function askingCents(d) {
  const live = activeListings(d);
  if (live.length && live[live.length - 1].priceCents != null) return live[live.length - 1].priceCents;
  if (d.pricePatientCents != null) return d.pricePatientCents;
  if (d.priceQuickCents != null) return d.priceQuickCents;
  return null;
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
