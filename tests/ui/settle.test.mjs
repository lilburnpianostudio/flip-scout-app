// settle.test.mjs — the Stage 2 settle-up flow, on screen.
//
// tests/settlement.test.mjs already proves the money. This proves the money is
// reachable: that the partner tab is tappable, the rows say what they should,
// the button carries the total, and paying actually clears the tab.
//
//   node tests/ui/settle.test.mjs   (after npm i in tests/ui)

import { boot, is, report, anItem, aSale, tick, confirms } from './harness.mjs';
import { freezeSale } from '../../js/settlement.js';

// FLIP-0003 as it really is: $60 item, partner fronted $30 of it at 50%, sold
// $250. The trailing space in the name is real live data, not a typo.
const austin = anItem({
  id: 'itm3', flipId: 'FLIP-0003', name: 'Austin Electric', status: 'sold',
  costCents: 6000, partners: [{ name: 'Partner A ', sharePct: 50, investedCents: 3000 }],
  sale: aSale(25000, '2026-08-05'), statusChangedAt: '2026-08-05T00:00:00Z',
});
freezeSale(austin);

// No partners — proves the tab only counts what is actually owed.
const fender = anItem({
  id: 'itm1', flipId: 'FLIP-0001', name: 'Fender DG8S', status: 'sold',
  costCents: 4500, sale: aSale(14000, '2026-07-31'),
});
freezeSale(fender);

const { $, click, change, store, window } = await boot([austin, fender]);

// ---- the partner tab is a way in, not just a number ------------------------
const chip = $('pipeTotals').querySelector('[data-settle]');
is('partner tab offers a tappable name', !!chip, true);
is('showing what she is owed', chip.textContent.replace(/\s+/g, ' ').trim(), 'Partner A $125.00');
is('the trailing space never reaches the label', chip.dataset.settle, 'Partner A');

// ---- tapping opens the settle screen ---------------------------------------
click(chip);
await tick(200);
is('settle screen is showing', $('invSettle').hidden, false);
is('the list is behind it', $('invList').hidden, true);
is('titled with her name', $('settleTitle').textContent, 'Settle up with Partner A');

const rows = $('settleRows').querySelectorAll('.settle-row');
is('only the item she has a stake in', rows.length, 1);
const rowText = rows[0].textContent.replace(/\s+/g, ' ').trim();
is('the row names the item', rowText.includes('FLIP-0003 Austin Electric'), true);
// FLIP-D22: capital and profit are never merged into one number.
is('capital and profit stay apart on screen too',
  rowText.includes('$30.00 of it is her money back · $95.00 profit'), true);
is('everything outstanding is ticked by default', rows[0].querySelector('input').checked, true);
is('the button carries the running total', $('btnSettlePay').textContent, 'Mark $125.00 paid');

// ---- unticking is honoured -------------------------------------------------
const cb = rows[0].querySelector('input');
cb.checked = false; change(cb);
await tick(80);
is('nothing ticked disables the button', $('btnSettlePay').disabled, true);
cb.checked = true; change(cb);
await tick(80);
is('re-ticking restores the total', $('btnSettlePay').textContent, 'Mark $125.00 paid');

// ---- pay her ----------------------------------------------------------------
$('seMethod').value = 'venmo';
$('seDate').value = '2026-08-06';
click($('btnSettlePay'));
await tick(500);

// FLIP-D26: append-only means no undo, so it must ask first.
is('it confirms before writing money', confirms.length, 1);
is('and says undo means a reversal', confirms[0].includes('not a delete'), true);

is('the receipt is on screen', $('settleReceipt').hidden, false);
is('receipt reads exactly as the fixtures promise', $('settleReceiptOut').textContent, [
  'Partner A — 2026-08-06',
  '',
  'FLIP-0003 Austin Electric',
  '  sold $250.00, margin $190.00',
  '  your $30.00 back',
  '  50% of the profit: $95.00',
  '  → $125.00',
  '',
  'Total: $125.00 · Venmo',
].join('\n'));

// ---- the ledger actually moved ----------------------------------------------
const rec = await store.get('items', 'itm3');
is('one payment written onto the item', rec.data.payments.length, 1);
is('for the right amount', rec.data.payments[0].amountCents, 12500);
is('name stored trimmed — it is the ledger key', rec.data.payments[0].name, 'Partner A');
is('method recorded', rec.data.payments[0].method, 'venmo');
is('grouped under a payoutId', (rec.data.payments[0].payoutId || '').length > 0, true);

const after = $('settleRows').querySelectorAll('.settle-row');
is('the row now reads settled', after[0].className.includes('settled'), true);
is('and says what was paid', after[0].textContent.includes('$125.00 paid'), true);
is('with nothing left to pay, the pay controls go away', $('settlePayWrap').hidden, true);

// ---- back on the list, she is off the tab ------------------------------------
click($('btnSettleDone'));
await tick(300);
is('back on the inventory list', $('invList').hidden, false);
is('a settled partner drops off the tab entirely',
  $('pipeTotals').querySelectorAll('[data-settle]').length, 0);
is('realized profit is untouched by paying her out',
  $('pipeTotals').textContent.includes('$285.00'), true);

report('settle-up UI checks passed against the real index.html');
