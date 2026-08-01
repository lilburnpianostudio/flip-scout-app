// buttons.test.mjs — WHICH BUTTONS ARE ON SCREEN, per item status.
//
// This is the FLIP-0001 regression suite. That bug was one condition —
// `if (d.status === 'listed')` around the Sold button — and it cost the first
// real sale in this tracker's life going unrecorded for days while three
// sessions of notes blamed the owner for not doing an obvious thing.
//
// The rule those notes produced: when the owner repeatedly does not do an
// obvious thing, check whether the software permits it. These assertions are
// that check, run automatically.
//
//   node tests/ui/buttons.test.mjs   (after npm i in tests/ui)

import { boot, is, report, anItem, aSale } from './harness.mjs';
import { freezeSale } from '../../js/settlement.js';

const soldItem = (over) => {
  const d = anItem({ status: 'sold', ...over });
  freezeSale(d);
  return d;
};

const { openItem, actionLabels } = await boot([
  anItem({ id: 'a1', flipId: 'FLIP-0001', name: 'Scouted thing', status: 'scouted' }),
  anItem({ id: 'a2', flipId: 'FLIP-0002', name: 'Acquired thing', status: 'acquired' }),
  anItem({ id: 'a3', flipId: 'FLIP-0003', name: 'Listed thing', status: 'listed' }),
  soldItem({ id: 'a4', flipId: 'FLIP-0004', name: 'Sold thing', sale: aSale(14000) }),
  anItem({ id: 'a5', flipId: 'FLIP-0005', name: 'Dead thing', status: 'dead' }),
  anItem({ id: 'a6', flipId: 'FLIP-0006', name: 'Described thing', description: 'a nice description' }),
]);

const has = (labels, needle) => labels.some((l) => l.includes(needle));

// ---- THE regression: an acquired item must be sellable (FLIP-D25) -----------
await openItem('FLIP-0002');
{
  const l = actionLabels();
  // If this ever goes red, someone has re-broken FLIP-0001. Do not "fix" the
  // test.
  is('ACQUIRED item offers Sold… — this is the FLIP-0001 bug', has(l, 'Sold'), true);
  is('acquired: can add a listing', has(l, 'Add listing'), true);
  is('acquired: can generate listing copy', has(l, 'Listing copy'), true);
  is('acquired: can be marked dead', has(l, 'Mark dead'), true);
  is('acquired: is not offered "Mark acquired" again', has(l, 'Mark acquired'), false);
}

// ---- listed ----------------------------------------------------------------
await openItem('FLIP-0003');
{
  const l = actionLabels();
  is('listed: offers Sold…', has(l, 'Sold'), true);
  is('listed: can be marked dead', has(l, 'Mark dead'), true);
}

// ---- scouted ---------------------------------------------------------------
await openItem('FLIP-0001');
{
  const l = actionLabels();
  is('scouted: offers Mark acquired', has(l, 'Mark acquired'), true);
  // Not bought yet, so there is nothing to sell or list.
  is('scouted: does NOT offer Sold…', has(l, 'Sold'), false);
  is('scouted: does NOT offer Add listing', has(l, 'Add listing'), false);
  is('scouted: can be marked dead', has(l, 'Mark dead'), true);
}

// ---- sold (terminal) -------------------------------------------------------
await openItem('FLIP-0004');
{
  const l = actionLabels();
  is('sold: cannot be sold twice', has(l, 'Sold'), false);
  is('sold: cannot be listed again', has(l, 'Add listing'), false);
  is('sold: cannot be marked dead — it is terminal', has(l, 'Mark dead'), false);
}

// ---- dead (terminal) -------------------------------------------------------
await openItem('FLIP-0005');
{
  const l = actionLabels();
  is('dead: cannot be marked dead twice', has(l, 'Mark dead'), false);
  is('dead: offers no sale path', has(l, 'Sold'), false);
}

// ---- copy buttons follow the data, not the status --------------------------
await openItem('FLIP-0006');
{
  const l = actionLabels();
  is('an item with a description offers Copy description', has(l, 'Copy description'), true);
  is('a named item offers Copy title', has(l, 'Copy title'), true);
}
await openItem('FLIP-0002');
is('an item with no description does NOT offer Copy description',
  actionLabels().some((l) => l.includes('Copy description')), false);

report('button-visibility checks passed against the real index.html');
