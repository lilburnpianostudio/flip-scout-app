// pricing.test.mjs — v25 on screen (FLIP-D31): the four prices, what each
// marketplace would leave, and a sale form that says what Ben keeps before the
// save freezes it.
//   node tests/ui/pricing.test.mjs   (after npm i in tests/ui)
//
// The pure rules are in tests/fees.test.mjs and tests/settlement.test.mjs.
// This proves they reach the screen.

import { boot, is, report, anItem, tick } from './harness.mjs';

const { window, $, store, click, openItem } = await boot([
  anItem({
    id: 'p1', flipId: 'FLIP-0020', name: 'Kurzweil SP88X', status: 'acquired', costCents: 5000,
    priceAskCents: 20000, pricePatientCents: 17500, priceQuickCents: 14000, priceFloorCents: 12000,
  }),
  anItem({ id: 'p2', flipId: 'FLIP-0021', name: 'Old Lamp', status: 'acquired', category: 'furniture',
    costCents: 500, priceQuickCents: null, pricePatientCents: null }),
  anItem({ id: 'p3', flipId: 'FLIP-0022', name: 'Yamaha Keyboard', status: 'acquired', costCents: 5000 }),
]);

const type = (id, v) => { $(id).value = v; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
const button = (needle) => [...$('detActions').querySelectorAll('button')].find((b) => b.textContent.includes(needle));

// ---- the four prices are shown together -----------------------------------
await openItem('FLIP-0020');
{
  const t = $('detRows').textContent;
  is('all four prices on one row', ['Ask $200', 'Fair $175', 'Quick $140', 'Floor $120'].every((s) => t.includes(s)), true);
  is('the floor is marked private', t.includes('never goes in a listing'), true);
}

// ---- what each marketplace would leave ------------------------------------
{
  // The label and the numbers are separate flex children; join them the way the eye does.
  const rows = [...$('netBox').querySelectorAll('.net-row')].map((r) =>
    [...r.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  is('the box is priced at the opening ask', $('netBox').textContent.includes('At $200.00, you would keep'), true);
  is('one line per marketplace', rows.length, 4);
  is('FB pickup keeps all of it', rows[0], 'FB Marketplace pickup | keep $200.00 no fee · $150.00 profit');
  is('eBay shows its fee and a smaller profit', rows[3], 'eBay shipped | keep $172.40 fee $27.60 · $122.40 profit');
  is('the date the rates were checked is on screen', /Fee rates checked \d{4}-\d{2}-\d{2}/.test($('netBox').textContent), true);
}

// ---- an item with no price shows no estimate ------------------------------
click($('btnDetBackTop'));
await tick(150);
await openItem('FLIP-0021');
is('no asking price: no estimate box, not a row of $0', $('netBox').innerHTML, '');

// ---- copy price uses the opening ask --------------------------------------
click($('btnDetBackTop'));
await tick(150);
await openItem('FLIP-0020');
is('the floor is not offered as a listing price',
  (() => { click(button('Listing copy')); return [...$('copyTier').options].map((o) => o.value); })(),
  ['ask', 'fair', 'quick', 'custom']);

// ---- the sale form says what he keeps before he saves ---------------------
click(button('Sold'));
await tick(150);
is('no price yet: no "you keep" line', $('saNet').hidden, true);
$('saPlatform').value = 'ebay';
type('saPrice', '180');
is('with a price it shows proceeds and profit', $('saNet').textContent, 'You keep $180.00 · profit $130.00');
is('an empty fee box gets an estimate offered', $('saFeeHint').hidden, false);
is('the estimate is the eBay fee on $180', $('saFeeHint').textContent.includes('$24.88'), true);
click($('btnUseFee'));
is('one tap fills the fee', $('saFees').value, '24.88');
is('and the offer goes away once a fee is typed', $('saFeeHint').hidden, true);
type('saShip', '18.50');
is('shipping comes off too', $('saNet').textContent, 'You keep $136.62 · profit $86.62');

click($('btnSaSave'));
await tick(300);
{
  const d = (await store.get('items', 'p1')).data;
  is('the sale stores fees and shipping separately', [d.sale.feesCents, d.sale.shippingCents], [2488, 1850]);
  is('the frozen margin is after both', d.sale.marginCents, 8662);
  is('the sold row shows shipping', $('detRows').textContent.includes('shipping $18.50'), true);
  is('a sold item shows no "you would keep" box', $('netBox').innerHTML, '');
}

// ---- a local cash sale: no fee is offered for a platform with none --------
click($('btnDetBackTop'));
await tick(150);
await openItem('FLIP-0022');
click(button('Sold'));
await tick(150);
$('saPlatform').value = 'craigslist';
type('saPrice', '90');
is('Craigslist has no fee to offer', $('saFeeHint').hidden, true);
is('keeps the whole price', $('saNet').textContent, 'You keep $90.00 · profit $40.00');
click($('btnSaSave'));
await tick(300);
{
  const d = (await store.get('items', 'p3')).data;
  is('blank fee and shipping save as 0, never null', [d.sale.feesCents, d.sale.shippingCents], [0, 0]);
  is('margin is price minus cost', d.sale.marginCents, 4000);
}

// ---- the form warns when prices contradict each other ---------------------
click($('btnDetBackTop'));
await tick(150);
click($('btnNewItem'));
await tick(100);
is('a blank form has no price warning', $('priceWarn').hidden, true);
type('itCost', '50');
type('itAsk', '100');
type('itFloor', '120');
is('a floor above the ask is called out', $('priceWarn').textContent.includes('Floor ($120) is higher than Ask ($100)'), true);
type('itFloor', '40');
is('a floor below cost is called out', $('priceWarn').textContent.includes('below what you paid'), true);
type('itFloor', '60');
is('sensible prices clear the warning', $('priceWarn').hidden, true);

// ---- new prices save and reload -------------------------------------------
type('itName', 'Roland Amp');
click($('btnItemSave'));
await tick(300);
{
  const rows = await store.getAll('items');
  const d = rows.map((r) => r.data).find((x) => x.name === 'Roland Amp');
  is('ask and floor are saved on the item', [d.priceAskCents, d.priceFloorCents], [10000, 6000]);
}

report('pricing checks passed (on screen)');
