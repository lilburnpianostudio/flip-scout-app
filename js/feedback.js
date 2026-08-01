// feedback.js — say "this screen is wrong" from the screen that is wrong.
//
// The point is the context Ben does not have to type. A note that says "the
// button is confusing" is nearly useless a week later; one that says
// "Settle up · FLIP-0003 Austin Electric · v22 · the button is confusing" is
// actionable without a single follow-up question.
//
// Writes go through the normal outbox, so this works in a dead zone at a garage
// sale and syncs when signal comes back — which is exactly where the friction
// worth reporting actually happens.
//
// Deliberately NOT hydrated back into the mirror (see outbox.hydrate's regex):
// Ben writes feedback, Larry reads it in the repo. Pulling it back onto the
// phone would be storage for nobody.

import * as outbox from './outbox.js';
import { ulid } from './ulid.js';
import { toast, APP_VERSION } from './ui.js';

const $ = (id) => document.getElementById(id);

// What is Ben actually looking at? Read from the DOM rather than tracked in a
// variable, because the DOM is the thing that cannot drift out of sync with
// what is on screen.
export function currentScreen() {
  if (!$('view-help').hidden) return { screen: 'help', label: 'Help' };
  if ($('shell').hidden) return { screen: 'signin', label: 'Sign-in' };
  if (!$('view-investigate').hidden) return { screen: 'research', label: 'Research' };
  if (!$('view-inventory').hidden) {
    if (!$('invSettle').hidden) return { screen: 'settle', label: 'Settle up' };
    if (!$('invForm').hidden) return { screen: 'itemForm', label: 'New / edit item' };
    if (!$('invDetail').hidden) return { screen: 'itemDetail', label: 'Item detail' };
    return { screen: 'inventory', label: 'Inventory list' };
  }
  return { screen: 'app', label: 'Flip Scout' };
}

// Which item he was on, taken straight off the heading. No new export from
// inventory.js and nothing to keep in sync: whatever the screen says is what
// gets recorded.
function contextOf(screen) {
  if (screen === 'itemDetail') return $('detTitle').textContent.trim();
  if (screen === 'itemForm') return $('invFormTitle').textContent.trim();
  if (screen === 'settle') return $('settleTitle').textContent.trim();
  return '';
}

const TAGS = [
  ['confusing', "Confusing"],
  ['broken', "Broken"],
  ['missing', "Missing"],
  ['idea', "Idea"],
];

let tag = null;

function renderTags() {
  $('fbTags').innerHTML = TAGS.map(([v, l]) =>
    `<button type="button" class="fb-tag${tag === v ? ' on' : ''}" data-tag="${v}">${l}</button>`).join('');
  $('fbTags').querySelectorAll('[data-tag]').forEach((b) => {
    b.addEventListener('click', () => {
      tag = tag === b.dataset.tag ? null : b.dataset.tag;  // tapping again clears it
      renderTags();
    });
  });
}

export function open() {
  const { label } = currentScreen();
  $('fbAbout').textContent = `About: ${label}`;
  $('fbText').value = '';
  tag = null;
  renderTags();
  $('fbOverlay').hidden = false;
  $('fbText').focus();
}

export function close() {
  $('fbOverlay').hidden = true;
}

async function send() {
  const text = $('fbText').value.trim();
  // A tag alone says almost nothing. The sentence is the whole value.
  if (!text) { toast('Say what happened first'); return; }

  const { screen, label } = currentScreen();
  const id = ulid();
  await outbox.enqueueRecord('feedback', id, {
    id,
    screen,
    screenLabel: label,
    context: contextOf(screen),
    tag,
    text,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    status: 'new',      // Larry flips this when it has been acted on
  });

  close();
  toast('Sent ✓ Larry will pick it up');
}

// Hidden on the sign-in screen: there is nothing to give feedback about yet,
// and the token field should not share the screen with anything.
export function setVisible(on) {
  $('fbFab').hidden = !on;
  if (!on) close();
}

export function init() {
  $('fbFab').addEventListener('click', open);
  $('fbSend').addEventListener('click', send);
  $('fbCancel').addEventListener('click', close);
  // Tapping the dim area behind the card closes it, the way a sheet should.
  $('fbOverlay').addEventListener('click', (e) => { if (e.target === $('fbOverlay')) close(); });
}
