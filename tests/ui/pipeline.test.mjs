// pipeline.test.mjs — v27 on screen (FLIP-D33): offers, a pending sale, the
// status under each marketplace, and a list sorted by what needs Ben.
//   node tests/ui/pipeline.test.mjs   (after npm i in tests/ui)
//
// The pure rules are in tests/pipeline.test.mjs. This proves they are wired to
// things he can see and tap.

import { boot, is, report, anItem, tick } from './harness.mjs';

const { window, $, store, click, openItem } = await boot([
  anItem({ id: 'k1', flipId: 'FLIP-0040', name: 'Kurzweil SP88X', status: 'listed', costCents: 9000,
    priceAskCents: 42500, pricePatientCents: 37500, priceQuickCents: 30000, priceFloorCents: 26000,
    listings: [{ platform: 'fbm', priceCents: 42500, listedAt: '2026-09-20' }, { platform: 'ebay', priceCents: 47500, listedAt: '2026-09-21' }] }),
  anItem({ id: 'k2', flipId: 'FLIP-0041', name: 'Yamaha Keyboard', status: 'acquired',
    platformCopy: { fbm: { title: 'Yamaha keyboard', description: 'Works.' } } }),
  anItem({ id: 'k3', flipId: 'FLIP-0042', name: 'Fender Amp', status: 'acquired' }),
  anItem({ id: 'k4', flipId: 'FLIP-0043', name: 'Old Lamp', status: 'listed', category: 'furniture',
    listings: [{ platform: 'craigslist', priceCents: 9000, listedAt: '2026-09-25' }] }),
]);

const type = (id, v) => { $(id).value = v; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
const button = (needle) => [...$('detActions').querySelectorAll('button')].find((b) => b.textContent.includes(needle));
const groups = () => [...$('itemRows').querySelectorAll('.pipe-group')].map((p) => p.textContent);
const subFor = (p) => $('postedOn').querySelector(`[data-post="${p}"]`).closest('.plat-row').nextElementSibling;
const back = async () => { click($('btnDetBackTop')); await tick(150); };

// ---- the list is sorted by what needs him ---------------------------------
is('groups, in order of urgency', groups(), ['Ready to post (1)', 'Live, waiting on a buyer (2)', 'Not listed yet (1)']);
is('a live item says how many places it is up', $('itemRows').textContent.includes('2 places'), true);

// ---- status under each marketplace ----------------------------------------
await openItem('FLIP-0040');
is('a live listing says live, and since when', subFor('fbm').textContent.startsWith('live since 2026-09-20'), true);
is('a live listing can be marked pending', !!subFor('fbm').querySelector('[data-pend="fbm"]'), true);
is('a marketplace with nothing has no status line', $('postedOn').querySelector('[data-post="offerup"]').closest('.plat-row').nextElementSibling.classList.contains('plat-sub'), false);
is('no offers yet: no offers box', $('offersBox').innerHTML, '');

// ---- log an offer ---------------------------------------------------------
click(button('Log an offer'));
await tick(50);
is('the offer form opens', $('offerForm').hidden, false);
is('marketplaces where it is up come first', [...$('ofPlatform').options].map((o) => o.value), ['fbm', 'ebay', 'offerup', 'craigslist']);
is('no amount: no verdict yet', $('ofVerdict').hidden, true);
type('ofAmount', '250');
is('a lowball is called below the floor, before he saves', $('ofVerdict').textContent.startsWith('Below your floor ($260).'), true);
is('and it says what he would keep', $('ofVerdict').textContent.includes('You would keep $250.00, $160.00 profit.'), true);
type('ofAmount', '380');
is('a good offer reads as one', $('ofVerdict').textContent.startsWith('At or above your fair price ($375).'), true);
$('ofNote').value = 'can pick up Saturday';
click($('btnOfSave'));
await tick(300);
{
  const d = (await store.get('items', 'k1')).data;
  is('the offer is on the record', [d.offers.length, d.offers[0].amountCents, d.offers[0].platform, d.offers[0].outcome], [1, 38000, 'fbm', 'open']);
  is('the offers box is on the item', $('offersBox').textContent.includes('$380.00 on FB Marketplace'), true);
  is('with his note', $('offersBox').textContent.includes('can pick up Saturday'), true);
  is('that marketplace now reads "offer waiting"', subFor('fbm').textContent.startsWith('offer waiting'), true);
  is('the other one is still just live', subFor('ebay').textContent.startsWith('live'), true);
}

// ---- a second, lower offer; the list shows the best one -------------------
click(button('Log an offer'));
await tick(50);
$('ofPlatform').value = 'ebay';
type('ofAmount', '300');
click($('btnOfSave'));
await tick(300);
await back();
is('the item moved to the top group', groups()[0], '💬 Offers waiting (1)');
is('the badge shows the BEST offer, short enough to leave the name readable', $('itemRows').querySelector('.of-badge').textContent, '$380 offer');

// ---- decline one, accept the other ----------------------------------------
await openItem('FLIP-0040');
is('two offers waiting', $('offersBox').querySelectorAll('.offer-row').length, 2);
click($('offersBox').querySelector('[data-odec="o2"]'));
await tick(300);
{
  const d = (await store.get('items', 'k1')).data;
  is('declined, and still on the record', [d.offers[1].outcome, d.offers.length], ['declined', 2]);
  is('one offer left on screen', $('offersBox').querySelectorAll('.offer-row').length, 1);
}
click($('offersBox').querySelector('[data-oacc="o1"]'));
await tick(300);
{
  const d = (await store.get('items', 'k1')).data;
  is('accepted', d.offers[0].outcome, 'accepted');
  is('accepting marks that listing pending', d.listings[0].status, 'pending');
  is('the offers box is gone', $('offersBox').innerHTML, '');
  is('FB reads "sale pending"', subFor('fbm').textContent.startsWith('sale pending'), true);
  is('and offers a way back', subFor('fbm').querySelector('[data-pend]').textContent, 'not pending after all');
}
await back();
is('the list moves it to "Sale pending"', groups()[0], '🤝 Sale pending (1)');

// ---- the sale form starts from the accepted offer -------------------------
await openItem('FLIP-0040');
click(button('Sold'));
await tick(150);
is('sold-where is where the offer came from', $('saPlatform').value, 'fbm');
is('sold-for is the offer', $('saPrice').value, '380');
click($('btnSaSave'));
await tick(300);
{
  const d = (await store.get('items', 'k1')).data;
  is('it sold for the offer', d.sale.priceCents, 38000);
  is('the pending FB listing is closed', !!d.listings[0].removedAt, true);
  is('eBay still has to come down', $('takedownBox').textContent.includes('eBay'), true);
  is('no offer is left open after a sale', d.offers.some((o) => o.outcome === 'open'), false);
}
await back();
is('sold with a take-down owed is the top group', groups()[0], '⚠ Sold, take these down (1)');

// ---- pending without an offer, and back -----------------------------------
await openItem('FLIP-0043');
click(subFor('craigslist').querySelector('[data-pend="craigslist"]'));
await tick(300);
is('one tap marks a listing pending', (await store.get('items', 'k4')).data.listings[0].status, 'pending');
click(subFor('craigslist').querySelector('[data-pend="craigslist"]'));
await tick(300);
is('and one tap takes it back, leaving no stray field', 'status' in (await store.get('items', 'k4')).data.listings[0], false);

// ---- an offer on an item that is not posted anywhere ----------------------
await back();
await openItem('FLIP-0042');
click(button('Log an offer'));
await tick(50);
type('ofAmount', '');
click($('btnOfSave'));
await tick(150);
is('an empty amount saves nothing', (await store.get('items', 'k3')).data.offers, undefined);
type('ofAmount', '70');
click($('btnOfSave'));
await tick(300);
is('word-of-mouth offers can be logged too', (await store.get('items', 'k3')).data.offers.length, 1);
await back();
is('and they count as an offer waiting, right under the take-downs',
  groups().slice(0, 2), ['⚠ Sold, take these down (1)', '💬 Offers waiting (1)']);

report('pipeline checks passed (on screen)');
