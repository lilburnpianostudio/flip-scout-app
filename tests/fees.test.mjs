// Fixtures for marketplace fees and expected net (v25, FLIP-D31).
//   node tests/fees.test.mjs
// No framework, no install, like settlement.test.mjs: fees.js is pure.

import { DEFAULT_FEES, mergeFees, sellMode, feeFor, expectedNet, feeClassOf } from '../js/fees.js';

let pass = 0;
const fails = [];
function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     expected ${e}\n     got      ${a}`);
}

// ---- local pickup is free --------------------------------------------------
is('FB porch pickup costs nothing', feeFor('fbm', 20000), 0);
is('OfferUp local costs nothing', feeFor('offerup', 20000), 0);
is('Craigslist costs nothing', feeFor('craigslist', 20000), 0);
is('Craigslist has no shipped rate, so "shipped" is still free', feeFor('craigslist', 20000, { mode: 'shipped' }), 0);

// ---- shipped through the app ----------------------------------------------
is('FB shipped is 10%', feeFor('fbm', 20000, { mode: 'shipped' }), 2000);
is('FB shipped has an 80 cent floor', feeFor('fbm', 500, { mode: 'shipped' }), 80);
is('OfferUp shipped is 12.9%', feeFor('offerup', 10000, { mode: 'shipped' }), 1290);
is('OfferUp shipped has a $1.99 floor', feeFor('offerup', 1000, { mode: 'shipped' }), 199);

// ---- eBay ------------------------------------------------------------------
is('eBay: 13.6% plus 40 cents', feeFor('ebay', 20000), 2760);
is('eBay: the fee is charged on buyer-paid shipping too', feeFor('ebay', 20000, { buyerShipCents: 2500 }), 3100);
is('eBay: a $10 order pays the 30 cent order fee', feeFor('ebay', 1000), 166);
is('eBay: a $10.01 order pays the 40 cent order fee', feeFor('ebay', 1001), 176);
is('eBay: guitars and basses are 6.7%', feeFor('ebay', 20000, { feeClass: 'guitars' }), 1380);
is('eBay: an unknown fee class uses the normal rate', feeFor('ebay', 20000, { feeClass: 'sneakers' }), 2760);

// ---- Vinted and Depop ------------------------------------------------------
is('Vinted charges the seller nothing', feeFor('vinted', 4000), 0);
is('Depop: 3.3% plus 45 cents', feeFor('depop', 2000), 111);
is('Depop: processing is charged on shipping too', feeFor('depop', 5000, { buyerShipCents: 500 }), 227);

// ---- unknown is not zero ---------------------------------------------------
is('an unknown platform has no fee, not a $0 fee', feeFor('mercari', 20000), null);
is('no price: no fee', feeFor('ebay', null), null);
is('a price that is not a number: no fee', feeFor('ebay', 'abc'), null);

// ---- how each platform usually sells ---------------------------------------
is('FB defaults to local', sellMode('fbm'), 'local');
is('eBay defaults to shipped', sellMode('ebay'), 'shipped');
is('an unknown platform defaults to local', sellMode('mercari'), 'local');

// ---- expected net ----------------------------------------------------------
{
  const n = expectedNet('fbm', 20000, { costCents: 4500 });
  is('FB local: net is the whole price', n.netCents, 20000);
  is('FB local: profit is net minus cost', n.profitCents, 15500);
  is('FB local: mode is reported', n.mode, 'local');
}
{
  const n = expectedNet('ebay', 20000, { shipCostCents: 1800, costCents: 4500 });
  is('eBay: fee', n.feeCents, 2760);
  is('eBay: net is price minus fee minus what I pay to ship', n.netCents, 15440);
  is('eBay: profit after cost', n.profitCents, 10940);
}
{
  const n = expectedNet('fbm', 20000, { shipCostCents: 1800 });
  is('a local sale ignores a shipping cost: nothing is being shipped', n.netCents, 20000);
  is('no cost given: profit is unknown, not equal to net', n.profitCents, null);
}
is('unknown platform: no estimate at all', expectedNet('mercari', 20000), null);
{
  const n = expectedNet('ebay', 1000, { shipCostCents: 1500, costCents: 0 });
  is('a net can go negative, and it must say so', n.netCents, -666);
}

// ---- the table from config -------------------------------------------------
is('no config: the defaults', mergeFees(null), DEFAULT_FEES);
is('garbage config: the defaults', mergeFees('nope'), DEFAULT_FEES);
{
  const t = mergeFees({ checkedOn: '2027-01-05', platforms: { ebay: { defaultMode: 'shipped', shipped: { pct: 14, fixedCents: 40 } } } });
  is('config overrides one platform', feeFor('ebay', 10000, {}, t), 1440);
  is('config leaves the others alone', feeFor('depop', 2000, {}, t), 111);
  is('config carries its own date', t.checkedOn, '2027-01-05');
}
{
  const t = mergeFees({ platforms: { ebay: { shipped: { pct: 'oops' } } } });
  is('a typo in config is a 0% rate, never NaN', feeFor('ebay', 10000, {}, t), 0);
  is('config with no date keeps the default date', t.checkedOn, DEFAULT_FEES.checkedOn);
}

// ---- which eBay rate -------------------------------------------------------
is('a guitar gets the guitar rate', feeClassOf({ category: 'musical', name: 'Fender Stratocaster' }), 'guitars');
is('a bass gets the guitar rate', feeClassOf({ category: 'musical', name: 'Ibanez 4-string bass' }), 'guitars');
is('a guitar AMP does not', feeClassOf({ category: 'musical', name: 'Fender guitar amp' }), null);
is('a keyboard does not', feeClassOf({ category: 'musical', name: 'Kurzweil SP88X' }), null);
is('the word guitar outside musical gear does not', feeClassOf({ category: 'furniture', name: 'guitar shaped shelf' }), null);
is('no item: no class', feeClassOf(null), null);

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} fee fixtures passed`);
