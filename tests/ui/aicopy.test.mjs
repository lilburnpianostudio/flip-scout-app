// aicopy.test.mjs — v26 on screen (FLIP-D32): carry the question to Claude,
// bring the answer back, and post from one row per marketplace.
//   node tests/ui/aicopy.test.mjs   (after npm i in tests/ui)
//
// The pure rules are in tests/aicopy.test.mjs and tests/listing.test.mjs.
// This proves the three taps are really on the screen and really save.

import { boot, is, report, anItem, tick } from './harness.mjs';

const { window, $, store, click, openItem } = await boot([
  anItem({ id: 'a1', flipId: 'FLIP-0030', name: 'Kurzweil SP88X', status: 'acquired', costCents: 9000,
    priceQuickCents: null, pricePatientCents: 37500, notes: 'from a church sale',
    copyFields: { brand: 'Kurzweil', model: 'SP88X', quirks: 'one sticky key' } }),
  anItem({ id: 'a2', flipId: 'FLIP-0031', name: 'Levi\'s 501 jeans', status: 'acquired', category: 'clothing',
    costCents: 600, priceQuickCents: null, pricePatientCents: null }),
]);

// Record what lands on the clipboard: it is the whole point of the screen.
const copied = [];
window.navigator.clipboard = { writeText: async (t) => { copied.push(t); } };

const button = (needle) => [...$('detActions').querySelectorAll('button')].find((b) => b.textContent.includes(needle));
const rows = () => [...$('postedOn').querySelectorAll('.plat-row')];
const rowFor = (p) => $('postedOn').querySelector(`[data-post="${p}"]`).closest('.plat-row');

const ANSWER = JSON.stringify({
  prices: { ask: 425, fair: 360, quick: 300, floor: 260, rangeLow: 320, rangeHigh: 400,
    basis: 'Three eBay sold listings, last 60 days', comps: [{ source: 'eBay sold', price: 380, note: 'with pedal' }] },
  platforms: {
    fbm: { title: 'Kurzweil SP88X 88-key weighted keyboard', description: 'Plays well. One sticky key.', category: 'Musical Instruments', tags: [], ask: 425 },
    offerup: { title: 'Kurzweil SP88X keyboard', description: 'Weighted keys.', category: 'Musical instruments', tags: [], ask: 425 },
    craigslist: { title: 'Kurzweil SP88X 88-key', description: 'Cash, local pickup.', category: 'musical instruments', tags: [], ask: 425 },
    ebay: { title: 'Kurzweil SP88X 88-Key Weighted Stage Piano Keyboard Tested', description: 'Tested — works.', category: 'Electronic Keyboards', tags: ['Brand: Kurzweil'], ask: 475 },
  },
});

// ---- before the AI: every row still works ---------------------------------
await openItem('FLIP-0030');
is('a keyboard gets four marketplace rows, not six', rows().length, 4);
is('each row has Copy and Open', rows().every((r) => r.querySelector('[data-pcopy]') && r.querySelector('[data-popen]')), true);
is('Open goes to the marketplace, in a new tab',
  [rowFor('ebay').querySelector('[data-popen]').href, rowFor('ebay').querySelector('[data-popen]').target], ['https://www.ebay.com/sl/sell', '_blank']);
click(rowFor('fbm').querySelector('[data-pcopy]'));
await tick(50);
is('with nothing written yet, Copy gives the item\'s own text', copied.at(-1), 'Kurzweil SP88X\n$375');
is('no row claims to be written for its marketplace', $('postedOn').querySelectorAll('.plat-ask small').length, 0);

// ---- step 1: the question -------------------------------------------------
is('the item offers AI listings', !!button('AI listings'), true);
click(button('AI listings'));
await tick(50);
is('the AI section opens', $('aiSection').hidden, false);
is('he has a price already, so "replace my prices" is offered and off', [$('aiReplaceRow').hidden, $('aiReplace').checked], [false, false]);
$('aiComps').value = 'eBay sold: $350, $410';
click($('btnAiCopy'));
await tick(100);
{
  const q = copied.at(-1);
  is('the question names the item', q.includes('- Item: Kurzweil SP88X'), true);
  is('it carries the flaw', q.includes('one sticky key'), true);
  is('it carries the comps he typed', q.includes('eBay sold: $350, $410'), true);
  is('it asks for the four marketplaces this item fits', ['fbm', 'offerup', 'craigslist', 'ebay'].every((p) => q.includes(`- ${p}: `)), true);
  is('it does not ask for Depop on a keyboard', q.includes('depop'), false);
}

// ---- step 3: a bad paste changes nothing ----------------------------------
click($('btnAiApply'));
await tick(100);
is('an empty box says so', $('aiResult').textContent.includes('Paste the answer'), true);
$('aiAnswer').value = 'Sorry, I could not see the photos.';
click($('btnAiApply'));
await tick(150);
is('prose is refused with a sentence he can act on', $('aiResult').textContent.includes('paste again'), true);
is('and nothing was written to the item', (await store.get('items', 'a1')).data.platformCopy, undefined);

// ---- step 3: the real answer ----------------------------------------------
$('aiAnswer').value = 'Here are your listings:\n```json\n' + ANSWER + '\n```';
click($('btnAiApply'));
await tick(400);
{
  const d = (await store.get('items', 'a1')).data;
  is('copy is saved for all four', Object.keys(d.platformCopy), ['fbm', 'offerup', 'craigslist', 'ebay']);
  is('blank prices were filled', [d.priceAskCents, d.priceQuickCents, d.priceFloorCents], [42500, 30000, 26000]);
  is('the fair price he typed was kept', d.pricePatientCents, 37500);
  is('the em dash never reached the listing', d.platformCopy.ebay.description, 'Tested, works.');
  is('the result names what was written', $('aiResult').textContent.includes('Written for FB Marketplace, OfferUp, Craigslist, eBay'), true);
  is('the answer box is cleared for next time', $('aiAnswer').value, '');
  is('the sells-for range is on the item', $('detRows').textContent.includes('$320.00 to $400.00'), true);
  is('the comp is on the item', $('detRows').textContent.includes('eBay sold $380.00'), true);
}

// ---- post it: copy, open, tap ---------------------------------------------
is('every row is now marked written', $('postedOn').querySelectorAll('.plat-ask small').length, 4);
is('eBay shows its own, higher ask', rowFor('ebay').querySelector('.plat-ask').textContent.includes('$475.00'), true);
click(rowFor('ebay').querySelector('[data-pcopy]'));
await tick(50);
is('Copy on the eBay row gives the eBay listing in one paste', copied.at(-1),
  ['Kurzweil SP88X 88-Key Weighted Stage Piano Keyboard Tested', '$475', '', 'Tested, works.', '', 'Brand: Kurzweil'].join('\n'));
click(rowFor('fbm').querySelector('[data-pcopy]'));
await tick(50);
is('and the FB row gives the FB one', copied.at(-1).startsWith('Kurzweil SP88X 88-key weighted keyboard\n$425'), true);
{
  const net = [...$('netBox').querySelectorAll('.net-row')].map((r) => r.textContent.replace(/\s+/g, ' '));
  is('"you would keep" prices eBay at the eBay ask', net[3].includes('at $475.00'), true);
}
click($('postedOn').querySelector('[data-post="ebay"]'));
await tick(250);
{
  const d = (await store.get('items', 'a1')).data;
  is('tapping eBay records the listing at the eBay price', [d.listings[0].platform, d.listings[0].priceCents], ['ebay', 47500]);
  is('and moves the item to listed', d.status, 'listed');
}

// ---- asking again with "replace" ------------------------------------------
click(button('AI listings'));
await tick(50);
$('aiReplace').checked = true;
$('aiAnswer').value = ANSWER;
click($('btnAiApply'));
await tick(400);
is('with replace ticked, his fair price is overwritten', (await store.get('items', 'a1')).data.pricePatientCents, 36000);

// ---- clothing gets Vinted and Depop ---------------------------------------
click($('btnDetBackTop'));
await tick(150);
await openItem('FLIP-0031');
is('jeans get six rows', rows().map((r) => r.querySelector('[data-post]').dataset.post), ['fbm', 'offerup', 'craigslist', 'ebay', 'vinted', 'depop']);
click(button('AI listings'));
await tick(50);
is('nothing to replace: the checkbox is not shown', $('aiReplaceRow').hidden, true);
click($('btnAiCopy'));
await tick(100);
is('the question for jeans asks for Depop and Vinted', ['- depop: ', '- vinted: '].every((s) => copied.at(-1).includes(s)), true);
click(button('Listing copy'));
await tick(50);
is('the template generator offers them too', [...$('copyPlatform').options].map((o) => o.value).slice(-2), ['vinted', 'depop']);
is('opening one section closes the other', $('aiSection').hidden, true);

report('AI-listing checks passed (on screen)');
