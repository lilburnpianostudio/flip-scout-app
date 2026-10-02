// Fixtures for offers, pending sales, per-marketplace status and what an item
// needs next (v27, FLIP-D33).
//   node tests/pipeline.test.mjs
// No framework, no install: pipeline.js is pure.

import {
  isOpen, openOffers, bestOffer, addOffer, closeOffer, closeOffersOnSale, offerVerdict,
  setPending, isPending, platformStatus, STATUS_LABEL, attention,
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

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} pipeline fixtures passed`);
