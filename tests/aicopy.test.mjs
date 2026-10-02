// Fixtures for the AI step: the prompt, and the door every answer comes back
// through (v26, FLIP-D32).
//   node tests/aicopy.test.mjs
// No framework, no install: aicopy.js is pure.

import { buildPrompt, extractJson, toCents, parseAnswer, applyAnswer, LIMITS } from '../js/aicopy.js';

let pass = 0;
const fails = [];
function is(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n     expected ${e}\n     got      ${a}`);
}
const has = (label, text, needle) => is(label, String(text).includes(needle), true);
const lacks = (label, text, needle) => is(label, String(text).includes(needle), false);

const item = (over = {}) => ({
  flipId: 'FLIP-0006', name: 'Kurzweil SP88X', category: 'musical', costCents: 9000,
  notes: 'bought from a church, sustain pedal missing', description: '',
  copyFields: { brand: 'Kurzweil', model: 'SP88X', condition: 'good', quirks: 'one sticky key' },
  priceQuickCents: null, pricePatientCents: 37500, priceAskCents: null, priceFloorCents: null,
  ...over,
});
const FOUR = ['fbm', 'offerup', 'craigslist', 'ebay'];

// ---- the prompt ------------------------------------------------------------
{
  const p = buildPrompt(item(), FOUR, 'eBay sold: $350, $410');
  has('names the item', p, '- Item: Kurzweil SP88X');
  has('carries the flaw to disclose', p, '- Flaws to disclose: one sticky key');
  has('cost is in the private block', p, '- What I paid: $90');
  has('notes are in the private block', p, '- Private notes: bought from a church');
  has('says the private block is never repeated', p, 'Never repeat any of this in a listing');
  has('my own comps go along', p, '- Comparable sales I found: eBay sold: $350, $410');
  has('a price already typed is mentioned', p, 'fair $375');
  has('asks for sold prices, not asking prices', p, 'actually SELLS for used');
  has('forbids invented comps', p, 'Do not invent comps');
  has('forbids em dashes', p, 'No em dashes');
  has('asks for JSON only', p, 'Answer with ONLY this JSON');
  has('one instruction line per requested platform', p, '- craigslist: Craigslist.');
  lacks('a platform that was not requested is not in the prompt', p, 'depop');
  const shape = JSON.parse(p.slice(p.lastIndexOf('{\n "prices"')));
  is('the JSON skeleton lists exactly the requested platforms', Object.keys(shape.platforms), FOUR);
  is('the skeleton has every price field', Object.keys(shape.prices), ['ask', 'fair', 'quick', 'floor', 'rangeLow', 'rangeHigh', 'basis', 'comps']);
}
{
  const p = buildPrompt(item({ costCents: null, notes: '', pricePatientCents: null }), ['fbm']);
  has('nothing private: says so, rather than leaving a bare heading', p, '- (nothing)');
  lacks('no cost: no cost line', p, 'What I paid');
}
has('clothing platforms get their own instructions', buildPrompt(item({ category: 'clothing' }), ['depop', 'vinted']), 'Up to 5 hashtags');

// ---- finding the JSON ------------------------------------------------------
is('plain JSON', extractJson('{"a":1}'), { a: 1 });
is('inside a code fence with a sentence first', extractJson('Here you go:\n```json\n{"a":1}\n```\nHope that helps'), { a: 1 });
is('curly quotes from a phone keyboard', extractJson('{“a”: “b”}'), { a: 'b' });
is('no JSON at all', extractJson('sorry, I cannot see the photo'), null);
is('broken JSON', extractJson('{"a": }'), null);
is('nothing pasted', extractJson(''), null);

// ---- prices from the AI ----------------------------------------------------
is('a number of dollars', toCents(125), 12500);
is('cents survive', toCents(19.99), 1999);
is('a string with a dollar sign and a comma', toCents('$1,250'), 125000);
is('zero is not a price', toCents(0), null);
is('negative is not a price', toCents(-5), null);
is('words are not a price', toCents('call me'), null);
is('blank is not a price', toCents(''), null);

// ---- a good answer ---------------------------------------------------------
const good = JSON.stringify({
  prices: { ask: 425, fair: 375, quick: 300, floor: 260, rangeLow: 320, rangeHigh: 400,
    basis: 'Three eBay sold listings, last 60 days', comps: [{ source: 'eBay sold', price: 380, note: 'with pedal' }] },
  platforms: {
    fbm: { title: 'Kurzweil SP88X 88-key weighted keyboard', description: 'Plays well. One sticky key.', category: 'Musical Instruments', tags: [], ask: 425 },
    offerup: { title: 'Kurzweil SP88X keyboard', description: 'Weighted keys.', category: 'Musical instruments', tags: [], ask: 425 },
    craigslist: { title: 'Kurzweil SP88X 88-key', description: 'Cash, local pickup.', category: 'musical instruments', tags: [], ask: 425 },
    ebay: { title: 'Kurzweil SP88X 88-Key Weighted Stage Piano Keyboard Tested', description: 'Tested.', category: 'Electronic Keyboards', tags: ['Brand: Kurzweil'], ask: 475 },
  },
});
{
  const r = parseAnswer(good, FOUR);
  is('a good answer is ok', r.ok, true);
  is('no notes on a clean answer', r.notes, []);
  is('prices land in cents', [r.prices.askCents, r.prices.fairCents, r.prices.quickCents, r.prices.floorCents], [42500, 37500, 30000, 26000]);
  is('the range lands in cents', [r.prices.rangeLowCents, r.prices.rangeHighCents], [32000, 40000]);
  is('comps are kept', r.prices.comps, [{ source: 'eBay sold', priceCents: 38000, note: 'with pedal' }]);
  is('all four platforms came back', Object.keys(r.platformCopy), FOUR);
  is('a platform can carry its own ask', r.platformCopy.ebay.askCents, 47500);
  is('category is kept', r.platformCopy.ebay.category, 'Electronic Keyboards');
}

// ---- the rules the AI is not trusted with ----------------------------------
{
  const long = 'Kurzweil SP88X 88-Key Fully Weighted Hammer Action Stage Piano Keyboard With Power Supply Tested Working Great';
  const r = parseAnswer(JSON.stringify({ prices: { ask: 400, comps: [{ source: 'x', price: 390 }] }, platforms: { ebay: { title: long, description: 'ok' } } }), ['ebay']);
  is('an eBay title is cut to 80', r.platformCopy.ebay.title.length <= LIMITS.ebay.title, true);
  is('and cut at a word, not mid-word', long.startsWith(r.platformCopy.ebay.title + ' '), true);
  is('and Ben is told', r.notes.some((n) => n.includes('trimmed to 80')), true);
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 300, floor: 350, comps: [{ source: 'x', price: 300 }] }, platforms: { fbm: { title: 'A', description: 'B' } } }), ['fbm']);
  is('a floor above the ask is flagged, not silently saved', r.notes.some((n) => n.includes('floor price is higher than its ask price')), true);
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 300 }, platforms: { fbm: { title: 'A', description: 'B' } } }), ['fbm']);
  is('prices with no comps are called a guess', r.notes.some((n) => n.includes('treat the prices as a guess')), true);
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 300, comps: [{ source: 'x', price: 290 }] },
    platforms: { fbm: { title: 'Great amp — loud', description: 'Works — really.\n\nSecond line – fine.' } } }), ['fbm']);
  is('em dashes never reach a listing: title', r.platformCopy.fbm.title, 'Great amp, loud');
  is('em dashes never reach a listing: description, line breaks kept', r.platformCopy.fbm.description, 'Works, really.\n\nSecond line, fine.');
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 40, comps: [{ source: 'x', price: 38 }] },
    platforms: { depop: { title: '', description: 'Vintage tee', tags: ['#vintage', 'tee', 'tee', '90s', 'band', 'grunge', 'extra'] } } }), ['depop']);
  is('Depop tags lose the #, lose repeats, and stop at five', r.platformCopy.depop.tags, ['vintage', 'tee', '90s', 'band', 'grunge']);
  is('a listing with no title but a description is kept (Depop has no title)', r.platformCopy.depop.description, 'Vintage tee');
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 40, comps: [{ source: 'x', price: 38 }] }, platforms: { fbm: { title: 'A', description: 'B', tags: 'red, large  cotton' } } }), ['fbm']);
  is('tags given as one string are split', r.platformCopy.fbm.tags, ['red', 'large', 'cotton']);
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 40, comps: [{ source: 'x', price: 38 }] }, platforms: { fbm: { title: 'A', description: 'B' } } }), FOUR);
  is('a platform that did not come back is named', r.notes.filter((n) => n.startsWith('Nothing came back for')).length, 3);
  is('and the one that did is still saved', Object.keys(r.platformCopy), ['fbm']);
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 40, comps: [{ source: 'x', price: 38 }] }, platforms: { fbm: { title: 'A', description: 'B' }, mercari: { title: 'X', description: 'Y' } } }), ['fbm']);
  is('a platform nobody asked for is ignored', Object.keys(r.platformCopy), ['fbm']);
}
{
  const r = parseAnswer(JSON.stringify({ prices: { ask: 'free', comps: [{ source: 'x', price: 'n/a' }] }, platforms: { fbm: { title: 'A', description: 'B', ask: -3 } } }), ['fbm']);
  is('a nonsense price is blank, never $0', [r.prices.askCents, r.platformCopy.fbm.askCents], [null, null]);
  is('a comp with no price is dropped', r.prices.comps, []);
}
is('prose with no JSON is refused', parseAnswer('I could not open the image.', FOUR).ok, false);
is('JSON with nothing useful is refused', parseAnswer('{"hello": "world"}', FOUR).ok, false);
is('a refusal carries a sentence Ben can act on', parseAnswer('nope', FOUR).error.includes('paste again'), true);

// ---- writing it onto the item ----------------------------------------------
{
  const d = applyAnswer(item(), parseAnswer(good, FOUR), '2026-10-02T12:00:00Z');
  is('blank prices are filled', [d.priceAskCents, d.priceQuickCents, d.priceFloorCents], [42500, 30000, 26000]);
  is('a price Ben already typed is kept', d.pricePatientCents, 37500);
  is('copy is saved per platform', Object.keys(d.platformCopy), FOUR);
  is('each platform is stamped with when', d.platformCopy.fbm.generatedAt, '2026-10-02T12:00:00Z');
  is('the range and basis are kept', [d.pricing.rangeLowCents, d.pricing.rangeHighCents, d.pricing.basis], [32000, 40000, 'Three eBay sold listings, last 60 days']);
  is('what the AI suggested is kept even where Ben\'s price won', d.pricing.suggested.fairCents, 37500);
}
{
  const d = applyAnswer(item({ pricePatientCents: 50000 }), parseAnswer(good, FOUR), 'now', { replacePrices: true });
  is('with replace on, his price is overwritten', d.pricePatientCents, 37500);
}
{
  const d = item({ platformCopy: { vinted: { title: 'old', description: 'old' } } });
  applyAnswer(d, parseAnswer(good, FOUR), 'now');
  is('copy for a platform not in this answer is left alone', d.platformCopy.vinted.title, 'old');
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ ${pass} AI-step fixtures passed`);
