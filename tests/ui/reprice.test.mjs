// reprice.test.mjs — v28 on screen (FLIP-D34): a listing that has sat too long
// gets one suggestion, and one tap records what Ben did about it.
//   node tests/ui/reprice.test.mjs   (after npm i in tests/ui)
//
// The rules are in tests/pipeline.test.mjs against fixed dates. This runs on
// the real clock, so every date here is "N days ago".

import { boot, is, report, anItem, tick } from './harness.mjs';

const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const { $, store, click, openItem } = await boot([
  anItem({ id: 'r1', flipId: 'FLIP-0050', name: 'Kurzweil SP88X', status: 'listed',
    priceAskCents: 42500, pricePatientCents: 37500, priceQuickCents: 30000, priceFloorCents: 26000,
    listings: [{ platform: 'fbm', priceCents: 42500, listedAt: ago(16) }, { platform: 'ebay', priceCents: 47500, listedAt: ago(16) }] }),
  anItem({ id: 'r2', flipId: 'FLIP-0051', name: 'Fresh Amp', status: 'listed',
    priceAskCents: 20000, pricePatientCents: 17500,
    listings: [{ platform: 'fbm', priceCents: 20000, listedAt: ago(3) }] }),
  anItem({ id: 'r3', flipId: 'FLIP-0052', name: 'Old Lamp', status: 'listed', category: 'furniture',
    priceAskCents: null, pricePatientCents: null, priceQuickCents: 4000,
    listings: [{ platform: 'craigslist', priceCents: 4000, listedAt: ago(20) }] }),
]);

const groups = () => [...$('itemRows').querySelectorAll('.pipe-group')].map((p) => p.textContent);
const back = async () => { click($('btnDetBackTop')); await tick(150); };
const rp = (what) => $('repriceBox').querySelector(`[data-rp="${what}"]`);

// ---- the list separates stale from merely live -----------------------------
is('stale listings get their own group, above plain live', groups(), ['⏳ Needs repricing (2)', 'Live, waiting on a buyer (1)']);
{
  const badges = [...$('itemRows').querySelectorAll('.rp-badge')].map((b) => b.textContent);
  is('the badge says what to do, briefly', badges.includes('↓ $375'), true);
  is('an item with no lower tier is told to refresh', badges.includes('refresh'), true);
}

// ---- a fresh listing gets no advice ---------------------------------------
await openItem('FLIP-0051');
is('3 days up: no reprice box', $('repriceBox').innerHTML, '');
await back();

// ---- drop the price --------------------------------------------------------
await openItem('FLIP-0050');
{
  const t = $('repriceBox').textContent;
  is('the advice is on the item', t.includes('Up 16 days at $425 with no offers. Drop it to your fair price, $375.'), true);
  is('it says where the price has to be changed by hand', t.includes('Change the price on FB Marketplace, eBay first, then tap.'), true);
  is('the button says exactly what it records', rp('reduce').textContent, 'I dropped it to $375');
}
click(rp('reduce'));
await tick(300);
{
  const d = (await store.get('items', 'r1')).data;
  is('both live listings came down by the same $50', d.listings.map((l) => l.priceCents), [37500, 42500]);
  is('the box is gone: the clock restarted', $('repriceBox').innerHTML, '');
  is('the row shows the new price', $('postedOn').textContent.includes('$375.00'), true);
}
await back();
is('it went back to plain live', groups(), ['⏳ Needs repricing (1)', 'Live, waiting on a buyer (2)']);

// ---- refresh ---------------------------------------------------------------
await openItem('FLIP-0052');
is('at its only price: the advice is to refresh', $('repriceBox').textContent.includes('Refresh it: a better first photo, then repost.'), true);
is('no "drop" button when there is nowhere to drop to', rp('reduce'), null);
click(rp('refresh'));
await tick(300);
is('refreshing is recorded on the listing', (await store.get('items', 'r3')).data.listings[0].refreshedAt, ago(0));
is('and the price did not move', (await store.get('items', 'r3')).data.listings[0].priceCents, 4000);
await back();
is('nothing left that needs repricing', groups(), ['Live, waiting on a buyer (3)']);

report('repricing checks passed (on screen)');
