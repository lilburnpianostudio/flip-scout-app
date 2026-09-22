// listing.test.mjs — the v24 posting flow, ON SCREEN (FLIP-D30).
//   node tests/ui/listing.test.mjs   (after npm i in tests/ui)
//
// Drives the real index.html: tap a marketplace chip, sell the item, and prove
// the take-down checklist appears, pins the item to the top of the list, and
// clears when ticked. The pure rules are in tests/listing.test.mjs; this proves
// they are actually wired to buttons Ben can see.

import { boot, is, report, anItem, tick } from './harness.mjs';

const { $, store, click, change, openItem, actionLabels } = await boot([
  anItem({ id: 'b1', flipId: 'FLIP-0010', name: 'Fender Amp', status: 'acquired', description: 'Loud.' }),
  anItem({ id: 'b2', flipId: 'FLIP-0011', name: 'Yamaha Keyboard', status: 'acquired', photoAlbum: 'Yamaha pics' }),
]);

const has = (needle) => actionLabels().some((l) => l.includes(needle));
const chip = (p) => $('postedOn').querySelector(`[data-post="${p}"]`);

await openItem('FLIP-0010');
is('acquired item offers Copy everything', has('Copy everything'), true);
is('acquired item offers Copy price', has('Copy price'), true);
is('acquired item offers Copy album name', has('Copy album name'), true);
is('all four marketplace chips are on screen',
  [...$('postedOn').querySelectorAll('[data-post]')].map((b) => b.dataset.post), ['fbm', 'offerup', 'craigslist', 'ebay']);
is('the suggested album name is shown', $('detRows').textContent.includes('FLIP-0010 Fender Amp'), true);

// ---- one tap posts it ------------------------------------------------------
click(chip('fbm'));
await tick(200);
click(chip('craigslist'));
await tick(200);
{
  const d = (await store.get('items', 'b1')).data;
  is('two taps = two listings', d.listings.map((l) => l.platform), ['fbm', 'craigslist']);
  is('a tap records the asking price (patient tier)', d.listings[0].priceCents, 9000);
  is('first post moves it to listed', d.status, 'listed');
  is('the tapped chip shows as on', chip('fbm').classList.contains('on'), true);
  is('an untapped chip stays off', chip('offerup').classList.contains('on'), false);
}

// ---- sell it on FB: Craigslist must come down ------------------------------
click([...$('detActions').querySelectorAll('button')].find((b) => b.textContent.includes('Sold')));
await tick(100);
$('saPlatform').value = 'fbm';
$('saPrice').value = '140';
click($('btnSaSave'));
await tick(300);
{
  const d = (await store.get('items', 'b1')).data;
  is('selling on FB closes the FB listing', !!d.listings[0].removedAt, true);
  is('Craigslist is still up', !d.listings[1].removedAt, true);
  const box = $('takedownBox');
  is('the take-down box is on screen', box.textContent.includes('Take it down from'), true);
  is('it names Craigslist', box.textContent.includes('Craigslist'), true);
  is('it does not ask to take down FB, where it sold', box.textContent.includes('FB Marketplace'), false);
  is('a sold item no longer offers Copy everything', has('Copy everything'), false);
}
{
  const listText = $('itemRows').textContent;
  is('the list pins it under "take these down"', listText.includes('take these down (1)'), true);
  is('with a "still up" badge', $('itemRows').querySelector('.td-badge')?.textContent, '1 still up');
}

// ---- tick it off -----------------------------------------------------------
const cb = $('takedownBox').querySelector('[data-down="craigslist"]');
cb.checked = true;
change(cb);
await tick(300);
{
  const d = (await store.get('items', 'b1')).data;
  is('ticking marks Craigslist down', !!d.listings[1].removedAt, true);
  is('and records why', d.listings[1].removedWhy, 'sold elsewhere');
  is('the box clears', $('takedownBox').textContent.trim(), '');
  is('the item leaves the take-down group', $('itemRows').textContent.includes('take these down'), false);
}

// ---- album override --------------------------------------------------------
await openItem('FLIP-0011');
is('a typed album name is shown, not the suggestion', $('detRows').textContent.includes('Yamaha pics'), true);
is('and is not marked "suggested"', $('detRows').textContent.includes('(suggested)'), false);

report('posting-flow checks passed against the real index.html');
