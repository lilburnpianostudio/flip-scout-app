// Fixtures for multi-marketplace posting and the take-down rule (FLIP-D30).
//   node tests/listing.test.mjs
// No framework, no install, like settlement.test.mjs: listing.js is pure.

import {
  SELL_PLATFORMS, platformLabel, activeListings, isListedOn, askingCents,
  albumName, everythingText, closeSoldListing, pendingTakedowns, markTakenDown,
} from '../js/listing.js';

let pass = 0;
const fails = [];
function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     expected ${e}\n     got      ${a}`);
}

const item = (over = {}) => ({
  flipId: 'FLIP-0006', name: 'Kurzweil SP88X 88-Key Weighted Keyboard', status: 'listed',
  priceQuickCents: 25000, pricePatientCents: 37500, listings: [], description: 'Plays great.',
  ...over,
});

// ---- platforms -------------------------------------------------------------
is('all four marketplaces Ben uses are offered',
  SELL_PLATFORMS.map(([v]) => v), ['fbm', 'offerup', 'craigslist', 'ebay']);
is('Craigslist has a label', platformLabel('craigslist'), 'Craigslist');
is('OfferUp no longer says "(existing)"', platformLabel('offerup'), 'OfferUp');
is('an unknown platform id still renders as itself', platformLabel('mercari'), 'mercari');

// ---- live vs down ----------------------------------------------------------
{
  const d = item({ listings: [
    { platform: 'fbm', priceCents: 37500, listedAt: '2026-09-01' },
    { platform: 'offerup', priceCents: 37500, listedAt: '2026-09-02', removedAt: '2026-09-05' },
  ] });
  is('a listing with no removedAt is live (every pre-v24 record)', activeListings(d).length, 1);
  is('listed on FB', isListedOn(d, 'fbm'), true);
  is('NOT listed on OfferUp once taken down', isListedOn(d, 'offerup'), false);
  is('no listings field at all is not a crash', activeListings({}).length, 0);
}

// ---- asking price ----------------------------------------------------------
is('no listing: asks the patient price', askingCents(item()), 37500);
is('no patient price: asks the quick price', askingCents(item({ pricePatientCents: null })), 25000);
is('no prices at all: null, not $0', askingCents(item({ pricePatientCents: null, priceQuickCents: null })), null);
is('newest LIVE listing wins over the tiers',
  askingCents(item({ listings: [{ platform: 'fbm', priceCents: 30000 }] })), 30000);
is('a taken-down listing does not set the price',
  askingCents(item({ listings: [{ platform: 'fbm', priceCents: 30000, removedAt: '2026-09-09' }] })), 37500);

// ---- album name ------------------------------------------------------------
is('default album: FLIP number + first three words', albumName(item()), 'FLIP-0006 Kurzweil SP88X 88-Key');
is('a name Ben typed wins', albumName(item({ photoAlbum: '  Kurzweil keyboard ' })), 'Kurzweil keyboard');
is('no FLIP number yet still gives something to type', albumName(item({ flipId: null, name: 'Amp' })), 'FLIP-new Amp');
is('no name: just the number', albumName(item({ name: '' })), 'FLIP-0006');

// ---- copy everything -------------------------------------------------------
is('title, price, blank line, description',
  everythingText(item()), 'Kurzweil SP88X 88-Key Weighted Keyboard\n$375\n\nPlays great.');
is('no description: title and price only',
  everythingText(item({ description: '' })), 'Kurzweil SP88X 88-Key Weighted Keyboard\n$375');
is('cents are kept when there are cents',
  everythingText(item({ description: '', pricePatientCents: 1999 })), 'Kurzweil SP88X 88-Key Weighted Keyboard\n$19.99');
is('no price: no stray "$" line',
  everythingText(item({ description: '', pricePatientCents: null, priceQuickCents: null })), 'Kurzweil SP88X 88-Key Weighted Keyboard');

// ---- THE double-sale guard -------------------------------------------------
{
  const d = item({ status: 'sold', sale: { platform: 'fbm', soldAt: '2026-09-20' }, listings: [
    { platform: 'fbm', priceCents: 37500 },
    { platform: 'offerup', priceCents: 37500 },
    { platform: 'craigslist', priceCents: 37500 },
  ] });
  closeSoldListing(d, '2026-09-20');
  is('the listing it sold on is closed by the sale', d.listings[0].removedAt, '2026-09-20');
  is('and says why', d.listings[0].removedWhy, 'sold here');
  is('the OTHER two are still owed a take-down',
    pendingTakedowns(d).map((l) => l.platform), ['offerup', 'craigslist']);

  markTakenDown(d, 'offerup', '2026-09-21');
  is('ticking OfferUp leaves only Craigslist', pendingTakedowns(d).map((l) => l.platform), ['craigslist']);
  is('a take-down after the sale says "sold elsewhere"', d.listings[1].removedWhy, 'sold elsewhere');

  markTakenDown(d, 'craigslist', '2026-09-21');
  is('all clear once every one is down', pendingTakedowns(d).length, 0);
}
{
  const d = item({ status: 'sold', sale: { platform: 'fbm', soldAt: '2026-08-01' }, listings: [] });
  is('a sale with nothing listed owes nothing (FLIP-0001 and FLIP-0003 today)', pendingTakedowns(d).length, 0);
}
is('an UNSOLD item never owes a take-down',
  pendingTakedowns(item({ listings: [{ platform: 'fbm' }] })).length, 0);
is('a DEAD item never owes a take-down',
  pendingTakedowns(item({ status: 'dead', listings: [{ platform: 'fbm' }] })).length, 0);
{
  const d = item({ listings: [{ platform: 'ebay', priceCents: 40000 }] });
  markTakenDown(d, 'ebay', '2026-09-22');
  is('taking an unsold listing down says "taken down"', d.listings[0].removedWhy, 'taken down');
}
{
  const d = item({ status: 'sold', sale: { platform: 'fbm' }, listings: [{ platform: 'offerup', removedAt: '2026-09-01' }] });
  closeSoldListing(d, '2026-09-20');
  is('an already-removed listing keeps its original date', d.listings[0].removedAt, '2026-09-01');
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} listing fixtures passed`);
