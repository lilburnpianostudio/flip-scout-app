// Fixtures for multi-marketplace posting and the take-down rule (FLIP-D30).
//   node tests/listing.test.mjs
// No framework, no install, like settlement.test.mjs: listing.js is pure.

import {
  SELL_PLATFORMS, platformLabel, activeListings, isListedOn, askingCents,
  albumName, everythingText, closeSoldListing, pendingTakedowns, markTakenDown,
  priceLadder, ladderProblems, platformsFor, sellUrl, copyFor, askOn, platformText,
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
is('all six marketplaces are known',
  SELL_PLATFORMS.map(([v]) => v), ['fbm', 'offerup', 'craigslist', 'ebay', 'vinted', 'depop']);
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
is('an opening ask beats the fair price', askingCents(item({ priceAskCents: 42500 })), 42500);
is('a live listing still beats the opening ask',
  askingCents(item({ priceAskCents: 42500, listings: [{ platform: 'fbm', priceCents: 30000 }] })), 30000);
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

// ---- the four prices (v25, FLIP-D31) ---------------------------------------
{
  const d = item({ priceAskCents: 42500, priceFloorCents: 20000, costCents: 9000 });
  is('the ladder runs ask, fair, quick, floor', priceLadder(d).map((t) => t.id), ['ask', 'fair', 'quick', 'floor']);
  is('a sensible ladder has no problems', ladderProblems(d), []);
}
is('blank tiers are left out, not shown as $0',
  priceLadder(item({ priceQuickCents: null })).map((t) => t.id), ['fair']);
is('an item from before v25 still has its two prices', priceLadder(item()).map((t) => t.label), ['Fair', 'Quick']);
is('a floor above the ask is a problem',
  ladderProblems({ priceAskCents: 10000, priceFloorCents: 12000 }), ['Floor ($120) is higher than Ask ($100)']);
is('quick above fair is a problem',
  ladderProblems({ pricePatientCents: 10000, priceQuickCents: 15000 }), ['Quick ($150) is higher than Fair ($100)']);
is('a floor below cost is a problem',
  ladderProblems({ priceAskCents: 10000, priceFloorCents: 4000, costCents: 5000 }), ['Floor ($40) is below what you paid ($50)']);
is('a free item has no cost to fall below', ladderProblems({ priceFloorCents: 500, costCents: 0 }), []);
is('equal tiers are fine', ladderProblems({ priceAskCents: 10000, pricePatientCents: 10000 }), []);

// ---- which marketplaces fit the item (v26, FLIP-D32) -----------------------
const ids = (d) => platformsFor(d).map(([v]) => v);
is('a keyboard is offered the four general marketplaces', ids(item({ category: 'musical' })), ['fbm', 'offerup', 'craigslist', 'ebay']);
is('clothing is offered all six', ids(item({ category: 'clothing' })), ['fbm', 'offerup', 'craigslist', 'ebay', 'vinted', 'depop']);
is('an item already listed on Vinted keeps Vinted, whatever its category',
  ids(item({ category: 'other', listings: [{ platform: 'vinted', priceCents: 2000 }] })), ['fbm', 'offerup', 'craigslist', 'ebay', 'vinted']);
is('an item with Depop copy written keeps Depop',
  ids(item({ category: 'other', platformCopy: { depop: { description: 'x' } } })), ['fbm', 'offerup', 'craigslist', 'ebay', 'depop']);
is('a taken-down Vinted listing still shows Vinted, so the history is reachable',
  ids(item({ category: 'other', listings: [{ platform: 'vinted', removedAt: '2026-09-01' }] })).includes('vinted'), true);

// ---- where to post ---------------------------------------------------------
is('every marketplace has a page to open', SELL_PLATFORMS.every(([v]) => String(sellUrl(v)).startsWith('https://')), true);
is('an unknown marketplace has none', sellUrl('mercari'), null);
is('no city or ZIP is baked into the public repo',
  /atlanta|[/.]atl[/.]|\d{5}/i.test(SELL_PLATFORMS.map(([v]) => sellUrl(v)).join(' ')), false);

// ---- copy written per marketplace ------------------------------------------
{
  const d = item({
    priceAskCents: 42500,
    platformCopy: {
      ebay: { title: 'Kurzweil SP88X Stage Piano', description: 'Tested.', tags: ['Brand: Kurzweil'], askCents: 47500 },
      depop: { title: '', description: 'Vintage tee', tags: ['vintage', '90s'], askCents: null },
      fbm: { title: '  ', description: '' },
    },
  });
  is('copy that exists is found', copyFor(d, 'ebay').title, 'Kurzweil SP88X Stage Piano');
  is('blank copy counts as no copy', copyFor(d, 'fbm'), null);
  is('a marketplace with none has none', copyFor(d, 'offerup'), null);
  is('a marketplace can carry its own asking price', askOn(d, 'ebay'), 47500);
  is('without one it uses the asking price on the item', askOn(d, 'offerup'), 42500);
  is('a live listing there beats both',
    askOn({ ...d, listings: [{ platform: 'ebay', priceCents: 45000 }] }, 'ebay'), 45000);
  is('a live listing somewhere ELSE does not set the price here',
    askOn({ ...d, listings: [{ platform: 'fbm', priceCents: 39000 }] }, 'ebay'), 47500);
  is('nor does it set the price on a marketplace with no copy: the item’s own ask does',
    askOn({ ...d, listings: [{ platform: 'ebay', priceCents: 49000 }] }, 'offerup'), 42500);
  is('with no prices on the item at all, a live price is better than nothing',
    askOn({ name: 'x', listings: [{ platform: 'ebay', priceCents: 49000 }] }, 'offerup'), 49000);
  is('one paste: title, price, description, tags',
    platformText(d, 'ebay'), ['Kurzweil SP88X Stage Piano', '$475', '', 'Tested.', '', 'Brand: Kurzweil'].join('\n'));
  is('Depop has no title, and its tags are hashtags',
    platformText(d, 'depop'), ['$425', '', 'Vintage tee', '', '#vintage #90s'].join('\n'));
  is('no copy for that marketplace: falls back to the text on the item',
    platformText(d, 'offerup'), everythingText(d));
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} listing fixtures passed`);
