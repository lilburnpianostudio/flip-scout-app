// feedback.test.mjs — the 💬 button reaches every screen and records which one.
//
// The whole value of in-app feedback is the context Ben does not type. If the
// screen label is wrong, a note lands against the wrong part of the app and is
// worse than no note at all — so the screen detection is what these assert
// hardest.
//
//   node tests/ui/feedback.test.mjs   (after npm i in tests/ui)

import { boot, is, report, anItem, aSale, tick } from './harness.mjs';
import { freezeSale } from '../../js/settlement.js';

const austin = anItem({
  id: 'itm3', flipId: 'FLIP-0003', name: 'Austin Electric', status: 'sold',
  costCents: 6000, partners: [{ name: 'Partner A', sharePct: 50, investedCents: 3000 }],
  sale: aSale(25000, '2026-08-05'),
});
freezeSale(austin);

const { $, click, store, window } = await boot([
  austin,
  anItem({ id: 'itm2', flipId: 'FLIP-0002', name: 'Takamine G-240', status: 'acquired' }),
]);

const feedback = await import(new URL('../../js/feedback.js', import.meta.url).href);

// ---- the button is reachable at all -----------------------------------------
is('the feedback button exists', !!$('fbFab'), true);
is('and is visible once signed in', $('fbFab').hidden, false);
is('it lives outside the shell so the help page can reach it too',
  $('fbFab').closest('#shell'), null);

// ---- it knows which screen you are on ---------------------------------------
is('inventory list', feedback.currentScreen().screen, 'inventory');

await (async () => {
  const row = [...$('itemRows').querySelectorAll('.item-row')]
    .find((r) => r.querySelector('.ir-flip').textContent.trim() === 'FLIP-0002');
  click(row);
  await tick(200);
})();
is('item detail', feedback.currentScreen().screen, 'itemDetail');

click($('btnDetEdit'));
await tick(200);
is('item form', feedback.currentScreen().screen, 'itemForm');

click($('btnItemCancel'));
await tick(200);
click($('pipeTotals').querySelector('[data-settle]'));
await tick(200);
is('settle up', feedback.currentScreen().screen, 'settle');

click($('btnSettleBack'));
await tick(200);
click([...window.document.querySelectorAll('.navbtn')].find((b) => b.dataset.view === 'investigate'));
await tick(150);
is('research', feedback.currentScreen().screen, 'research');

click($('btnHelp'));
await tick(150);
is('help — checked before the shell, since help hides it',
  feedback.currentScreen().screen, 'help');
click($('btnHelpClose'));
await tick(150);

// ---- the panel opens and labels itself --------------------------------------
click([...window.document.querySelectorAll('.navbtn')].find((b) => b.dataset.view === 'inventory'));
await tick(200);
click($('fbFab'));
await tick(100);
is('the panel opens', $('fbOverlay').hidden, false);
is('and says which screen it is about', $('fbAbout').textContent, 'About: Inventory list');
is('four quick tags offered', $('fbTags').querySelectorAll('[data-tag]').length, 4);

// ---- an empty note is not worth sending -------------------------------------
click($('fbSend'));
await tick(200);
is('an empty note does not send', (await store.getAll('feedback')).length, 0);
is('and the panel stays open so nothing is lost', $('fbOverlay').hidden, false);

// ---- tags toggle -------------------------------------------------------------
const brokenTag = $('fbTags').querySelector('[data-tag=broken]');
click(brokenTag);
await tick(80);
is('tapping a tag selects it', $('fbTags').querySelector('[data-tag=broken]').className.includes('on'), true);
click($('fbTags').querySelector('[data-tag=broken]'));
await tick(80);
is('tapping it again clears it', $('fbTags').querySelector('[data-tag=broken]').className.includes('on'), false);

// ---- send from the settle screen, with item context --------------------------
click($('fbCancel'));
await tick(80);
is('cancel closes the panel', $('fbOverlay').hidden, true);

click($('pipeTotals').querySelector('[data-settle]'));
await tick(200);
click($('fbFab'));
await tick(100);
is('panel now labelled for the settle screen', $('fbAbout').textContent, 'About: Settle up');
click($('fbTags').querySelector('[data-tag=confusing]'));
$('fbText').value = "  I wasn't sure if this had already sent  ";
click($('fbSend'));
await tick(400);

const notes = await store.getAll('feedback');
is('one note recorded', notes.length, 1);
const n = notes[0].data;
is('against the right screen', n.screen, 'settle');
is('with a human label for it', n.screenLabel, 'Settle up');
is('the text is trimmed', n.text, "I wasn't sure if this had already sent");
is('the tag rides along', n.tag, 'confusing');
is('the app version is captured so Larry never has to ask', n.appVersion, 'v23');
is('context Ben did not have to type', n.context, 'Settle up with Partner A');
is('marked new for triage', n.status, 'new');
is('it has a timestamp', typeof n.createdAt === 'string' && n.createdAt.length > 10, true);

is('the panel closes after sending', $('fbOverlay').hidden, true);

// ---- it queues rather than requiring signal ----------------------------------
// boot() rejects all fetches, so this note could only have been stored by the
// offline path — which is the path that matters at a garage sale.
is('the note survived with no network', (await store.getAll('feedback')).length, 1);

report('feedback checks passed against the real index.html');
