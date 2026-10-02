// Fixtures for offers, pending sales, per-marketplace status and what an item
// needs next (v27, FLIP-D33).
//   node tests/pipeline.test.mjs
// No framework, no install: pipeline.js is pure.

import {
  isOpen, openOffers, bestOffer, addOffer, closeOffer, closeOffersOnSale, offerVerdict,
  setPending, isPending, platformStatus, STATUS_LABEL, attention,
  DEFAULT_REPRICE, daysLive, livePrice, nextTierDown, repriceAdvice, applyReduce, markRefreshed, snoozeReprice,
} from '../js/pipeline.js';

let pass = 0;
const fails = [];
function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     expected ${e}\n     got      ${a}`);
}

const item = (over = {}) => ({
  flipId: 'FLIP-0006', name: 'Kurzweil SP88X', status: 'listed', costCents: 9000,
  priceAskCents: 42500, pricePatientCents: 37500, priceQuickCents: 30000, priceFloorCents: 26000,
  listings: [{ platform: 'fbm', priceCents: 42500, listedAt: '2026-09-20' }],
  ...over,
});

// ---- offers are appended, never edited -------------------------------------
{
  const d = item();
  const o = addOffer(d, { platform: 'fbm', amountCents: 30000, note: '  can pick up today ', at: '2026-10-01' });
  is('the first offer gets id o1', o.id, 'o1');
  is('a new offer is open', isOpen(o), true);
  is('the note is trimmed', o.note, 'can pick up today');
  addOffer(d, { platform: 'fbm', amountCents: 35000, at: '2026-10-02' });
  is('ids are sequential', d.offers.map((x) => x.id), ['o1', 'o2']);
  is('two open offers', openOffers(d).length, 2);
  is('the best offer is the highest', bestOffer(d).amountCents, 35000);

  closeOffer(d, 'o1', 'declined', '2026-10-02');
  is('declining closes one', openOffers(d).map((x) => x.id), ['o2']);
  is('the declined offer is still on the record', d.offers.length, 2);
  is('declining does not make the listing pending', isPending(d, 'fbm'), false);

  closeOffer(d, 'o2', 'accepted', '2026-10-03');
  is('accepting closes it', openOffers(d).length, 0);
  is('accepting marks that marketplace pending', isPending(d, 'fbm'), true);
  is('it records when', d.offers[1].closedAt, '2026-10-03');

  closeOffer(d, 'o1', 'accepted', '2026-10-04');
  is('an offer already closed cannot be reopened or re-decided', d.offers[0].outcome, 'declined');
  closeOffer(d, 'nope', 'accepted', '2026-10-04');
  is('an unknown id changes nothing', d.offers.map((x) => x.outcome), ['declined', 'accepted']);
}
is('no offers: none open', openOffers(item()), []);
is('no offers: no best offer', bestOffer(item()), null);
{
  // Records written before v27 have offers with no outcome field at all.
  const d = item({ offers: [{ id: 'o1', platform: 'fbm', amountCents: 100 }] });
  is('an offer with no outcome field is open', openOffers(d).length, 1);
}
{
  const d = item();
  addOffer(d, { platform: 'fbm', amountCents: 30000, at: '2026-10-01' });
  addOffer(d, { platform: 'ebay', amountCents: 31000, at: '2026-10-01' });
  closeOffer(d, 'o1', 'declined', '2026-10-01');
  closeOffersOnSale(d, '2026-10-05');
  is('a sale expires what was still open', d.offers[1].outcome, 'expired');
  is('and leaves an already-declined one as it was', d.offers[0].outcome, 'declined');
}

// ---- an offer against the prices on the item -------------------------------
is('full asking price', offerVerdict(item(), 42500).level, 'take');
is('over asking', offerVerdict(item(), 50000).text, 'Your full asking price.');
is('at the fair price', offerVerdict(item(), 37500).text, 'At or above your fair price ($375).');
is('between quick and fair', offerVerdict(item(), 32000).level, 'fair');
is('above the floor, under quick', offerVerdict(item(), 27000).text, 'Above your floor ($260), below your quick price.');
is('exactly the floor is not below it', offerVerdict(item(), 26000).level, 'low');
is('below the floor', offerVerdict(item(), 25999).text, 'Below your floor ($260).');
is('no floor set, low offer', offerVerdict(item({ priceFloorCents: null }), 10000).text, 'Below every price on this item. No floor is set.');
is('no prices at all', offerVerdict(item({ priceAskCents: null, pricePatientCents: null, priceQuickCents: null, priceFloorCents: null }), 10000).level, 'unknown');
is('only a floor: above it', offerVerdict({ priceFloorCents: 5000 }, 6000).level, 'low');

// ---- pending ---------------------------------------------------------------
{
  const d = item({ listings: [
    { platform: 'fbm', priceCents: 42500 },
    { platform: 'ebay', priceCents: 47500 },
    { platform: 'offerup', priceCents: 42500, removedAt: '2026-09-25' },
  ] });
  setPending(d, 'fbm', true);
  is('pending is per marketplace', [isPending(d, 'fbm'), isPending(d, 'ebay')], [true, false]);
  setPending(d, 'offerup', true);
  is('a taken-down listing cannot be pending', isPending(d, 'offerup'), false);
  setPending(d, 'fbm', false);
  is('pending can be undone', isPending(d, 'fbm'), false);
  is('undoing leaves no stray field on the record', 'status' in d.listings[0], false);
}

// ---- status per marketplace ------------------------------------------------
{
  const d = item({
    listings: [
      { platform: 'fbm', priceCents: 42500 },
      { platform: 'ebay', priceCents: 47500, status: 'pending' },
      { platform: 'offerup', priceCents: 42500, removedAt: '2026-09-25' },
    ],
    platformCopy: { craigslist: { title: 'Kurzweil', description: 'Cash.' } },
    offers: [{ id: 'o1', platform: 'fbm', amountCents: 30000, outcome: 'open' }],
  });
  is('an open offer on a live listing', platformStatus(d, 'fbm'), 'offer');
  is('pending beats everything while it is up', platformStatus(d, 'ebay'), 'pending');
  is('taken down', platformStatus(d, 'offerup'), 'removed');
  is('copy written, never posted', platformStatus(d, 'craigslist'), 'ready');
  is('nothing at all', platformStatus(d, 'depop'), 'not-prepared');
  is('every status has words for the screen',
    ['sold', 'pending', 'offer', 'live', 'removed', 'ready', 'not-prepared'].every((s) => typeof STATUS_LABEL[s] === 'string'), true);
}
is('a plain live listing', platformStatus(item(), 'fbm'), 'live');
is('an offer on a marketplace where it is NOT up does not make it "offer"',
  platformStatus(item({ offers: [{ id: 'o1', platform: 'ebay', amountCents: 1, outcome: 'open' }] }), 'ebay'), 'not-prepared');
is('where it sold', platformStatus(item({ status: 'sold', sale: { platform: 'fbm' }, listings: [{ platform: 'fbm', removedAt: '2026-10-01' }] }), 'fbm'), 'sold');

// ---- what the item needs ---------------------------------------------------
is('an offer outranks everything else', attention(item({ offers: [{ id: 'o1', platform: 'fbm', amountCents: 1, outcome: 'open' }] })), 'offer');
is('a pending sale', attention(item({ listings: [{ platform: 'fbm', status: 'pending' }] })), 'pending');
is('up and waiting', attention(item()), 'live');
is('written, not posted', attention(item({ status: 'acquired', listings: [], platformCopy: { fbm: { title: 'A', description: 'B' } } })), 'ready');
is('blank copy does not count as written', attention(item({ status: 'acquired', listings: [], platformCopy: { fbm: { title: '', description: ' ' } } })), 'unlisted');
is('nothing written, nothing posted', attention(item({ status: 'acquired', listings: [] })), 'unlisted');
is('everything taken down goes back to ready or unlisted, not "live"',
  attention(item({ listings: [{ platform: 'fbm', removedAt: '2026-09-30' }] })), 'unlisted');
is('sold and still up elsewhere', attention(item({ status: 'sold', sale: { platform: 'fbm' }, listings: [{ platform: 'ebay' }] })), 'takedown');
is('sold and clear needs nothing', attention(item({ status: 'sold', sale: { platform: 'fbm' }, listings: [{ platform: 'fbm', removedAt: '2026-10-01' }] })), null);
is('a declined offer does not keep it in "offers waiting"',
  attention(item({ offers: [{ id: 'o1', platform: 'fbm', amountCents: 1, outcome: 'declined' }] })), 'live');
is('scouted items are not in this pipeline', attention(item({ status: 'scouted' })), null);
is('dead items are not in this pipeline', attention(item({ status: 'dead' })), null);

// ---- repricing (v28, FLIP-D34) ---------------------------------------------
// item() is listed on FB at $425 since 2026-09-20, with ask 425, fair 375,
// quick 300, floor 260.
const at = (iso) => new Date(iso + 'T12:00:00Z').getTime();

is('the clock starts at the listing date', daysLive(item(), at('2026-10-04')), 14);
is('nothing live: no clock', daysLive(item({ listings: [] }), at('2026-10-04')), null);
is('a taken-down listing does not count', daysLive(item({ listings: [{ platform: 'fbm', listedAt: '2026-09-01', removedAt: '2026-09-10' }] }), at('2026-10-04')), null);
is('with two listings, the older one sets the clock',
  daysLive(item({ listings: [{ platform: 'fbm', listedAt: '2026-09-20' }, { platform: 'ebay', listedAt: '2026-09-30' }] }), at('2026-10-04')), 14);
is('a listing with no date gives no clock rather than a wrong one', daysLive(item({ listings: [{ platform: 'fbm' }] }), at('2026-10-04')), null);

is('the price buyers see is the lowest live one',
  livePrice(item({ listings: [{ platform: 'fbm', priceCents: 42500 }, { platform: 'ebay', priceCents: 47500 }] })), 42500);
is('no live price: null', livePrice(item({ listings: [] })), null);

is('below the ask comes fair', nextTierDown(item(), 42500).label, 'Fair');
is('below fair comes quick', nextTierDown(item(), 37500).label, 'Quick');
is('below quick there is nothing: the floor is never a listing price', nextTierDown(item(), 30000), null);
is('a price between tiers drops to the next one under it', nextTierDown(item(), 40000).cents, 37500);

// -- when to say nothing
is('13 days: too soon', repriceAdvice(item(), at('2026-10-03')), null);
is('not listed: nothing to reprice', repriceAdvice(item({ status: 'acquired', listings: [] }), at('2026-12-01')), null);
is('an open offer: answer that first',
  repriceAdvice(item({ offers: [{ id: 'o1', platform: 'fbm', amountCents: 30000, outcome: 'open', at: '2026-09-21' }] }), at('2026-11-01')), null);
is('a pending sale: leave it alone',
  repriceAdvice(item({ listings: [{ platform: 'fbm', priceCents: 42500, listedAt: '2026-09-20', status: 'pending' }] }), at('2026-11-01')), null);
is('an offer in the last two weeks is interest: leave the price',
  repriceAdvice(item({ offers: [{ id: 'o1', platform: 'fbm', amountCents: 30000, outcome: 'declined', at: '2026-10-01T10:00:00Z' }] }), at('2026-10-10')), null);
is('sold items get no advice', repriceAdvice(item({ status: 'sold' }), at('2026-12-01')), null);

// -- reduce
{
  const a = repriceAdvice(item(), at('2026-10-04'));
  is('14 days, no offers: drop a tier', [a.action, a.toCents, a.tierLabel, a.days], ['reduce', 37500, 'Fair', 14]);
  is('in words he can act on', a.text, 'Up 14 days at $425 with no offers. Drop it to your fair price, $375.');
}
{
  const a = repriceAdvice(item(), at('2026-10-25'));
  is('past 30 days it also says to repost', a.text.endsWith('$375, and repost it so it shows as new.'), true);
}
{
  const d = item({ listings: [{ platform: 'fbm', priceCents: 37500, listedAt: '2026-09-20' }] });
  is('already at fair: next is quick', repriceAdvice(d, at('2026-10-04')).toCents, 30000);
}

// -- refresh, then revalue
{
  const d = item({ listings: [{ platform: 'fbm', priceCents: 30000, listedAt: '2026-09-20' }] });
  is('at the lowest listed price, under 30 days: refresh it', repriceAdvice(d, at('2026-10-04')).action, 'refresh');
  const a = repriceAdvice(d, at('2026-10-25'));
  is('at the lowest listed price, past 30 days: the price is wrong', a.action, 'revalue');
  is('and it never suggests listing at the floor', a.text.includes('$260'), false);
}
{
  const d = item({ offers: [
    { id: 'o1', platform: 'fbm', amountCents: 20000, outcome: 'declined', at: '2026-09-21' },
    { id: 'o2', platform: 'fbm', amountCents: 22000, outcome: 'declined', at: '2026-09-22' },
  ] });
  const a = repriceAdvice(d, at('2026-09-25'));
  is('two offers, both under the floor: revalue, however few days', a.action, 'revalue');
  is('it names the best offer', a.text.includes('The best was $220.'), true);
}
{
  const d = item({ offers: [
    { id: 'o1', platform: 'fbm', amountCents: 20000, outcome: 'declined', at: '2026-09-21' },
    { id: 'o2', platform: 'fbm', amountCents: 30000, outcome: 'declined', at: '2026-09-22' },
  ] });
  is('one offer above the floor: the floor is not the problem', repriceAdvice(d, at('2026-09-25')), null);
}
is('one low offer is one person, not the market',
  repriceAdvice(item({ offers: [{ id: 'o1', platform: 'fbm', amountCents: 20000, outcome: 'declined', at: '2026-09-21' }] }), at('2026-09-25')), null);

// -- the settings
is('the days are configurable', repriceAdvice(item(), at('2026-09-27'), { staleDays: 7, refreshDays: 30 }).action, 'reduce');
is('nonsense settings fall back to the defaults', repriceAdvice(item(), at('2026-10-04'), { staleDays: 'soon', refreshDays: -1 }).action, 'reduce');
is('the defaults are 14 and 30', [DEFAULT_REPRICE.staleDays, DEFAULT_REPRICE.refreshDays], [14, 30]);

// -- recording what he did
{
  const d = item({ listings: [{ platform: 'fbm', priceCents: 42500, listedAt: '2026-09-20' }, { platform: 'ebay', priceCents: 47500, listedAt: '2026-09-20' },
    { platform: 'offerup', priceCents: 42500, listedAt: '2026-09-01', removedAt: '2026-09-10' }] });
  applyReduce(d, 37500, '2026-10-04');
  is('every live listing comes down by the same amount', d.listings.slice(0, 2).map((l) => l.priceCents), [37500, 42500]);
  is('a taken-down listing is left alone', d.listings[2].priceCents, 42500);
  is('the clock restarts', daysLive(d, at('2026-10-10')), 6);
  is('so the advice is quiet until the new price has had its two weeks', repriceAdvice(d, at('2026-10-10')), null);
  is('and comes back when it has', repriceAdvice(d, at('2026-10-18')).toCents, 30000);
}
{
  const d = item();
  applyReduce(d, 50000, '2026-10-04');
  is('a "reduction" to a higher price is ignored', d.listings[0].priceCents, 42500);
}
{
  const d = markRefreshed(item({ listings: [{ platform: 'fbm', priceCents: 30000, listedAt: '2026-09-20' }] }), '2026-10-04');
  is('refreshing restarts the clock', daysLive(d, at('2026-10-10')), 6);
}
{
  const d = snoozeReprice(item(), '2026-10-04');
  is('"keep the price" quiets the advice', repriceAdvice(d, at('2026-10-10')), null);
  is('for one stretch, not forever', repriceAdvice(d, at('2026-10-18')).action, 'reduce');
  is('an old snooze does not hide a newer listing date',
    daysLive(item({ repriceSnoozedAt: '2026-09-01' }), at('2026-10-04')), 14);
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} pipeline fixtures passed`);
