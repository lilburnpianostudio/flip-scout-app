// Fixtures for the settlement math (FLIP-D18 / FLIP-D19).
//   node tests/settlement.test.mjs
// No framework, no install. settlement.js is pure and DOM-free so it imports
// straight into node. Partner names here are placeholders on purpose: this
// repo is public and real names live only in the private data repo.

import {
  settle, settleSale, freezeSale, frozenPayouts, needsFreeze,
  computeMargin, computePartnerLedger, investedTotal, benInvested,
  isBuy, investedCapital,
  partnerItemLedger, buildPayout, formatReceipt,
} from '../js/settlement.js';

let pass = 0;
const fails = [];

function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     expected ${e}\n     got      ${a}`);
}

const sold = (costCents, priceCents, partners, feesCents = 0) => ({
  status: 'sold',
  costCents,
  partners,
  sale: { platform: 'fbm', priceCents, feesCents, soldAt: '2026-08-01' },
});

// ---------------------------------------------------------------- design §3b
// The three worked examples from payout-settlement-design.md. If these three
// numbers ever change, the design doc and the decision log are now lies.

// 1. Profitable, no partner capital. 50% of an $8 item that sells for $60.
{
  const s = settle(800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]);
  is('§3b #1 margin is $52', s.marginCents, 5200);
  is('§3b #1 partner takes $26', s.payouts[0].payoutCents, 2600);
  is('§3b #1 none of it is capital', s.payouts[0].capitalCents, 0);
  is('§3b #1 Ben gets $8 cost back plus $26', s.benCents, 3400);
}

// 2. Profitable, partner fronted $20 of the $30 cost. Sells for $80.
{
  const s = settle(3000, 8000, [{ name: 'Partner A', sharePct: 50, investedCents: 2000 }]);
  is('§3b #2 margin is $50', s.marginCents, 5000);
  is('§3b #2 partner takes $45', s.payouts[0].payoutCents, 4500);
  is('§3b #2 = $20 capital back', s.payouts[0].capitalCents, 2000);
  is('§3b #2 + $25 profit', s.payouts[0].profitCents, 2500);
  is('§3b #2 Ben gets $10 back plus $25', s.benCents, 3500);
}

// 3. Below cost. Same $20 of $30, but it only sells for $12.
{
  const s = settle(3000, 1200, [{ name: 'Partner A', sharePct: 50, investedCents: 2000 }]);
  is('§3b #3 margin is -$18', s.marginCents, -1800);
  is('§3b #3 partner gets $8 back, pro-rata', s.payouts[0].payoutCents, 800);
  is('§3b #3 no profit share on a loss', s.payouts[0].profitCents, 0);
  is('§3b #3 Ben gets $4', s.benCents, 400);
  // The consequence worth naming: she put in $20 and got $8. She lost $12 of
  // her own capital. She never OWES anything — but principal is not protected.
  is('§3b #3 payout never goes negative', s.payouts[0].payoutCents >= 0, true);
}

// ------------------------------------------------------------- the zero floor
{
  const s = settle(3000, 0, [{ name: 'Partner A', sharePct: 50, investedCents: 2000 }]);
  is('total loss: partner gets $0, not a debt', s.payouts[0].payoutCents, 0);
}
{
  // Fees swallow the whole sale price.
  const s = settle(1000, -500, [{ name: 'Partner A', sharePct: 50, investedCents: 500 }]);
  is('negative proceeds: capital return floors at $0', s.payouts[0].capitalCents, 0);
  is('negative proceeds: payout floors at $0', s.payouts[0].payoutCents, 0);
}
{
  const s = settle(3000, 3000, [{ name: 'Partner A', sharePct: 50, investedCents: 2000 }]);
  is('exactly break-even: capital back, no profit', s.payouts[0].payoutCents, 2000);
  is('exactly break-even: margin is zero', s.marginCents, 0);
}

// ------------------------------------------------------- multi-partner splits
{
  const s = settle(4000, 10000, [
    { name: 'Partner A', sharePct: 50, investedCents: 2000 },
    { name: 'Partner B', sharePct: 25, investedCents: 1000 },
  ]);
  is('two partners: margin is $60', s.marginCents, 6000);
  is('two partners: A takes $20 + $30', s.payouts[0].payoutCents, 5000);
  is('two partners: B takes $10 + $15', s.payouts[1].payoutCents, 2500);
  is('two partners: Ben keeps his $10 + $15', s.benCents, 2500);
}
{
  // Pro-rata when proceeds fall short and two people fronted money.
  const s = settle(4000, 2000, [
    { name: 'Partner A', sharePct: 50, investedCents: 2000 },
    { name: 'Partner B', sharePct: 25, investedCents: 1000 },
  ]);
  is('short sale: A gets half her $20', s.payouts[0].capitalCents, 1000);
  is('short sale: B gets half her $10', s.payouts[1].capitalCents, 500);
  is('short sale: Ben eats the rest of the shortfall', s.benCents, 500);
}
{
  // Bad data (form warns): invested exceeds cost. Nothing may go negative.
  const s = settle(3000, 8000, [{ name: 'Partner A', sharePct: 50, investedCents: 5000 }]);
  is('over-invested: capital caps at what she put in', s.payouts[0].capitalCents, 5000);
  is('over-invested: Ben absorbs the incoherence, not the partner', s.benCents >= 0, true);
}
{
  const s = settle(0, 5000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]);
  is('free item: margin is the whole sale', s.marginCents, 5000);
  is('free item: 50% of $50', s.payouts[0].payoutCents, 2500);
}
{
  const s = settle(1000, 3000, []);
  is('no partners: Ben takes everything', s.benCents, 3000);
  is('no partners: no payout rows', s.payouts.length, 0);
}
{
  const s = settle(1000, 3000, [{ name: '  ', sharePct: 50, investedCents: 0 }]);
  is('blank partner name is ignored', s.payouts.length, 0);
}

// ------------------------------------------------------------ rounding + fees
{
  const s = settle(1000, 3333, [{ name: 'Partner A', sharePct: 33, investedCents: 0 }]);
  is('odd cents: round half up', s.payouts[0].payoutCents, 770); // 2333 * .33 = 769.89
  is('odd cents: remainder lands on Ben', s.benCents, 3333 - 770);
}
{
  const d = sold(2000, 10000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }], 1500);
  is('fees come off before margin', computeMargin(d), 6500);
  is('fees come off before the split', settleSale(d).payouts[0].payoutCents, 3250);
}

// --------------------------------------------------- the freeze point (D18)
{
  const d = sold(800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]);
  is('unfrozen sale is flagged for backfill', needsFreeze(d), true);

  freezeSale(d);
  is('freeze writes the margin', d.sale.marginCents, 5200);
  is('freeze writes the payouts', d.sale.payouts[0].payoutCents, 2600);
  is('frozen sale is no longer flagged', needsFreeze(d), false);

  // The defect this exists to kill: editing a sold item's shares must not
  // retroactively change what was already owed and possibly already paid.
  d.partners[0].sharePct = 10;
  is('history does not rewrite itself', frozenPayouts(d)[0].payoutCents, 2600);

  // And freezing again must not clobber the record of what actually happened.
  freezeSale(d);
  is('freeze is idempotent', d.sale.payouts[0].payoutCents, 2600);
}
{
  // Pre-freeze items still read correctly until backfill runs.
  const d = sold(800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]);
  is('unfrozen item still reports its payouts', frozenPayouts(d)[0].payoutCents, 2600);
}

// ------------------------------------------------ the ledger: owed is now owed
{
  const a = freezeSale(sold(800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]));
  const b = freezeSale(sold(3000, 8000, [{ name: 'Partner A', sharePct: 50, investedCents: 2000 }]));
  const led = computePartnerLedger([a, b]);
  is('earned across two flips', led['Partner A'].earnedCents, 2600 + 4500);
  is('nothing paid yet, so all of it is owed', led['Partner A'].owedCents, 7100);

  // Paid in full → the tab reads zero. This is the whole point of Stage 1.
  a.payments = [{ id: 'x1', name: 'Partner A', amountCents: 2600, paidAt: '2026-08-02', method: 'cash' }];
  b.payments = [{ id: 'x2', name: 'Partner A', amountCents: 4500, paidAt: '2026-08-02', method: 'cash' }];
  const led2 = computePartnerLedger([a, b]);
  is('paid in full reads $0 owed', led2['Partner A'].owedCents, 0);
  is('but lifetime earnings are still on the record', led2['Partner A'].earnedCents, 7100);
  is('and so is what was handed over', led2['Partner A'].paidCents, 7100);
}
{
  // Partial payment reads the remainder.
  const a = freezeSale(sold(800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]));
  a.payments = [{ id: 'x1', name: 'Partner A', amountCents: 1000, paidAt: '2026-08-02' }];
  is('partial payment leaves the remainder', computePartnerLedger([a])['Partner A'].owedCents, 1600);
}
{
  // Reversal: a negative row, never an edit or a delete.
  const a = freezeSale(sold(800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }]));
  a.payments = [
    { id: 'x1', name: 'Partner A', amountCents: 2600, paidAt: '2026-08-02' },
    { id: 'x2', name: 'Partner A', amountCents: -2600, paidAt: '2026-08-03', note: 'venmo bounced' },
  ];
  const led = computePartnerLedger([a]);
  is('a reversal puts it back on the tab', led['Partner A'].owedCents, 2600);
  is('and both rows survive', a.payments.length, 2);
}
{
  // Unsold items contribute nothing earned.
  const held = { status: 'listed', costCents: 1000, partners: [{ name: 'Partner A', sharePct: 50 }] };
  is('unsold items are not earnings', Object.keys(computePartnerLedger([held])).length, 0);
}
{
  // Payments recorded against an item that is not sold still count.
  const d = { status: 'acquired', costCents: 1000, partners: [],
              payments: [{ id: 'x1', name: 'Partner A', amountCents: 500 }] };
  is('an advance shows as overpaid, not ignored', computePartnerLedger([d])['Partner A'].owedCents, -500);
}

// -------------------------------------------- name normalization (ledger key)
{
  // Phone entry leaves trailing spaces. One partner must stay one partner.
  const a = freezeSale(sold(800, 6000, [{ name: 'Ada ', sharePct: 50, investedCents: 0 }]));
  const b = freezeSale(sold(800, 6000, [{ name: 'Ada', sharePct: 50, investedCents: 0 }]));
  const led = computePartnerLedger([a, b]);
  is('trailing space does not split a partner in two', Object.keys(led).length, 1);
  is('both flips land on one balance', led['Ada'].earnedCents, 5200);

  // And a payment recorded against the untrimmed spelling still clears it.
  a.payments = [{ id: 'x1', name: 'Ada ', amountCents: 2600 }];
  b.payments = [{ id: 'x2', name: ' Ada', amountCents: 2600 }];
  is('payments match across spellings', computePartnerLedger([a, b])['Ada'].owedCents, 0);
  is('frozen payout rows are keyed trimmed', a.sale.payouts[0].name, 'Ada');
}

// ------------------------------------------------------------- stake helpers
{
  const ps = [{ name: 'Partner A', investedCents: 2000 }, { name: 'Partner B', investedCents: 1000 }];
  is('invested total', investedTotal(ps), 3000);
  is("Ben's stake is the remainder", benInvested(5000, ps), 2000);
  is('over-invested reads negative so the form can warn', benInvested(2000, ps) < 0, true);
}

// ------------------------------------------------------- acquisition (D21)
{
  is('bought is a buy', isBuy({ acquisition: 'bought', costCents: 4500 }), true);
  is('gifted is not', isBuy({ acquisition: 'gifted', costCents: 0 }), false);
  is('already owned is not', isBuy({ acquisition: 'owned', costCents: 0 }), false);
  is('found free is not', isBuy({ acquisition: 'found', costCents: 0 }), false);

  // Every item that existed before the field was added really was bought, so
  // a missing acquisition must not silently drop items out of the hit rate.
  is('legacy item with no field counts as bought', isBuy({ costCents: 4500 }), true);
  is('null is not an item', isBuy(null), false);

  // The point of the whole feature: a gift's $0 never lands in the denominator
  // that grades Ben's picking, but the item is still tracked and still sells.
  const items = [
    { acquisition: 'bought', costCents: 4500 },
    { acquisition: 'bought', costCents: 6000 },
    { acquisition: 'gifted', costCents: 0 },
    { costCents: 6000 },                        // legacy, counts
  ];
  is('capital at risk skips the gift', investedCapital(items), 16500);
  is('and legacy items are still in it', investedCapital([{ costCents: 6000 }]), 6000);

  // A gifted item that sells is pure profit — the money math does not care how
  // it arrived, only the scoreboard does.
  const gift = sold(0, 8000, []);
  is('free item sold is all margin', computeMargin(gift), 8000);
  is('and Ben keeps all of it', settleSale(gift).benCents, 8000);
}

// ------------------------------------------------------- settle-up (Stage 2)
// The per-item ledger, the payout group, and the receipt text. Names are
// placeholders; the real ones live in the private repo.

// A sold item with everything the receipt needs hanging off it.
const item = (id, flipId, name, costCents, priceCents, partners, soldAt = '2026-08-01') => {
  const d = { id, flipId, name, status: 'sold', costCents, partners, payments: [],
              sale: { platform: 'fbm', priceCents, feesCents: 0, soldAt } };
  freezeSale(d);
  return d;
};

// Apply a payout the way inventory.js does: append, never edit.
const apply = (items, payout) => {
  payout.payments.forEach((p) => {
    const d = items.find((x) => x.id === p.itemId);
    if (d) d.payments.push(p.payment);
  });
};

// FLIP-0003's real shape: $60 item, partner fronted $30 of it at 50%, sells
// $250. These are the numbers NEXT-STEPS.md promises out loud.
const austin = () => item('i3', 'FLIP-0003', 'Austin Electric', 6000, 25000,
  [{ name: 'Partner A', sharePct: 50, investedCents: 3000 }]);

{
  const items = [austin(), item('i1', 'FLIP-0001', 'Fender DG8S', 4500, 14000, [])];
  const rows = partnerItemLedger(items, 'Partner A');
  is('per-item ledger: only items she has a stake in', rows.length, 1);
  is('per-item ledger: owed is the full payout', rows[0].owedCents, 12500);
  is('per-item ledger: $30 of it is capital', rows[0].capitalCents, 3000);
  is('per-item ledger: $95 of it is profit', rows[0].profitCents, 9500);
  is('per-item ledger: carries the item identity for the receipt', rows[0].flipId, 'FLIP-0003');
  is('per-item ledger totals match the global ledger',
    rows.reduce((s, r) => s + r.owedCents, 0),
    computePartnerLedger(items)['Partner A'].owedCents);
}

{
  // An unsold item with a partner on it is a promise, not a debt.
  const unsold = { id: 'i9', flipId: 'FLIP-0009', name: 'Not sold yet', status: 'acquired',
                   costCents: 6000, partners: [{ name: 'Partner A', sharePct: 50, investedCents: 3000 }], payments: [] };
  is('nothing is owed on an unsold item', partnerItemLedger([unsold], 'Partner A').length, 0);
}

{
  // The live trailing-space record (FLIP-0003 stores "Kaitlin "). If this ever
  // fails, a partner who has been paid in full never clears off the tab.
  const d = item('i3', 'FLIP-0003', 'Austin Electric', 6000, 25000,
    [{ name: 'Partner A ', sharePct: 50, investedCents: 3000 }]);
  is('trailing space in the stored name still finds her items',
    partnerItemLedger([d], 'Partner A').length, 1);
}

{
  // Paid in full: balance goes to zero and she drops off the partner tab.
  const items = [austin()];
  const rows = partnerItemLedger(items, 'Partner A');
  const payout = buildPayout('Partner A', rows, { payoutId: 'PO1', paidAt: '2026-08-05', method: 'venmo', nextId: () => 'PM1' });
  is('payout total is what she was owed', payout.totalCents, 12500);
  is('one payment row per item', payout.payments.length, 1);
  is('the payment carries the group id', payout.payments[0].payment.payoutId, 'PO1');
  apply(items, payout);
  is('paid in full reads $0 owed', partnerItemLedger(items, 'Partner A')[0].owedCents, 0);
  is('and she is off the partner tab',
    computePartnerLedger(items)['Partner A'].owedCents, 0);
  is('the earning is still on the record', partnerItemLedger(items, 'Partner A')[0].earnedCents, 12500);
}

{
  // Two sold items, settle only one. The other stays outstanding.
  const items = [
    austin(),
    item('i5', 'FLIP-0005', 'Chess set', 800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }], '2026-08-09'),
  ];
  const rows = partnerItemLedger(items, 'Partner A');
  is('oldest sale sorts first', rows[0].flipId, 'FLIP-0003');
  const payout = buildPayout('Partner A', [rows[0]], { payoutId: 'PO2', paidAt: '2026-08-10', nextId: () => 'PM2' });
  is('partial settlement pays only the chosen item', payout.totalCents, 12500);
  apply(items, payout);
  is('the unpaid item is still owed', computePartnerLedger(items)['Partner A'].owedCents, 2600);
}

{
  // A row with nothing outstanding must never become a payment.
  const rows = [{ itemId: 'a', owedCents: 0 }, { itemId: 'b', owedCents: -500 }, { itemId: 'c', owedCents: 100 }];
  const payout = buildPayout('Partner A', rows, { payoutId: 'PO3', nextId: () => 'PM3' });
  is('zero and negative rows are never paid', payout.payments.length, 1);
  is('only the outstanding amount is written', payout.totalCents, 100);
}

{
  // A reversal is a negative payment, never a delete, so the debt comes back.
  const items = [austin()];
  apply(items, buildPayout('Partner A', partnerItemLedger(items, 'Partner A'),
    { payoutId: 'PO4', paidAt: '2026-08-05', nextId: () => 'PM4' }));
  items[0].payments.push({ id: 'PM5', name: 'Partner A', amountCents: -12500, paidAt: '2026-08-06', payoutId: 'PO5' });
  is('a reversal puts the balance back', partnerItemLedger(items, 'Partner A')[0].owedCents, 12500);
}

// ------------------------------------------------------------- receipt text
{
  const items = [austin()];
  const payout = buildPayout('Partner A', partnerItemLedger(items, 'Partner A'),
    { payoutId: 'PO6', paidAt: '2026-08-05', method: 'venmo', methodLabel: 'Venmo', nextId: () => 'PM6' });
  is('receipt reads exactly as promised', formatReceipt(payout), [
    'Partner A — 2026-08-05',
    '',
    'FLIP-0003 Austin Electric',
    '  sold $250.00, margin $190.00',
    '  your $30.00 back',
    '  50% of the profit: $95.00',
    '  → $125.00',
    '',
    'Total: $125.00 · Venmo',
  ].join('\n'));
}

{
  // Capital and profit are separate lines (FLIP-D22) — never one number.
  const items = [austin()];
  const text = formatReceipt(buildPayout('Partner A', partnerItemLedger(items, 'Partner A'),
    { payoutId: 'PO7', paidAt: '2026-08-05', nextId: () => 'PM7' }));
  is('capital is its own line', text.includes('your $30.00 back'), true);
  is('profit is its own line', text.includes('50% of the profit: $95.00'), true);
  is('the two are never merged', text.includes('$125.00 profit'), false);
}

{
  // Break-even: capital back only, so there is one component and no total line
  // repeating the same number.
  const d = item('i7', 'FLIP-0007', 'Break-even amp', 3000, 3000,
    [{ name: 'Partner A', sharePct: 50, investedCents: 2000 }]);
  const text = formatReceipt(buildPayout('Partner A', partnerItemLedger([d], 'Partner A'),
    { payoutId: 'PO8', paidAt: '2026-08-05', nextId: () => 'PM8' }));
  is('capital-only receipt has no redundant arrow total', text.includes('→'), false);
  is('capital-only receipt still totals', text.includes('Total: $20.00'), true);
}

{
  // Part-paid item: the frozen breakdown no longer adds to what is left, so the
  // receipt shows the subtraction rather than a number that looks wrong.
  const items = [austin()];
  items[0].payments.push({ id: 'PM9', name: 'Partner A', amountCents: 5000, paidAt: '2026-08-02', payoutId: 'PO9' });
  const rows = partnerItemLedger(items, 'Partner A');
  is('part-paid leaves the remainder', rows[0].owedCents, 7500);
  const text = formatReceipt(buildPayout('Partner A', rows, { payoutId: 'PO10', paidAt: '2026-08-05', nextId: () => 'PM10' }));
  is('receipt shows what was already paid', text.includes('less already paid: $50.00'), true);
  is('receipt totals the remainder', text.includes('  → $75.00'), true);
}

{
  // Two items in one settlement = one payoutId group = one receipt.
  const items = [
    austin(),
    item('i5', 'FLIP-0005', 'Chess set', 800, 6000, [{ name: 'Partner A', sharePct: 50, investedCents: 0 }], '2026-08-09'),
  ];
  let n = 0;
  const payout = buildPayout('Partner A', partnerItemLedger(items, 'Partner A'),
    { payoutId: 'PO11', paidAt: '2026-08-10', methodLabel: 'Cash', nextId: () => 'PM' + (++n) });
  is('two items, one group', payout.payments.every((p) => p.payoutId === payout.payoutId || p.payment.payoutId === 'PO11'), true);
  is('two items, distinct payment ids', payout.payments[0].payment.id !== payout.payments[1].payment.id, true);
  is('grouped total', payout.totalCents, 15100);
  const text = formatReceipt(payout);
  is('both items appear', text.includes('FLIP-0003') && text.includes('FLIP-0005'), true);
  is('grouped receipt totals once', text.includes('Total: $151.00 · Cash'), true);
  apply(items, payout);
  is('settling the group clears her entirely',
    computePartnerLedger(items)['Partner A'].owedCents, 0);
}

// ---------------------------------------------------------------------- report
if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} settlement fixtures passed`);
