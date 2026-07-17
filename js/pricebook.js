// pricebook.js — search/filter over past verdicts (FR-003). Mirror-only reads
// (ADR-006): results come from IndexedDB with zero network, works in airplane mode.

import * as store from './store.js';
import { CATEGORIES, centsToDollars } from './investigate.js';

const $ = (id) => document.getElementById(id);

let wired = false;

async function render() {
  const q = $('pbSearch').value;
  const cat = $('pbCategory').value;
  const verdict = $('pbVerdict').value;

  let rows = await store.search('verdicts', q, ['itemName', 'reason']);
  if (cat !== 'all') rows = rows.filter((r) => r.data.category === cat);
  if (verdict !== 'all') rows = rows.filter((r) => r.data.verdict === verdict);
  rows.sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1));

  const box = $('pbResults');
  box.innerHTML = '';
  $('pbCount').textContent = rows.length ? `${rows.length} verdict${rows.length === 1 ? '' : 's'}` : '';

  if (!rows.length) {
    box.innerHTML = '<p class="hint">Nothing here yet. Every investigation you log builds this book — even the passes.</p>';
    return;
  }

  rows.forEach((r) => {
    const d = r.data;
    const el = document.createElement('div');
    el.className = 'pb-row';
    const date = (d.createdAt || '').slice(0, 10);
    el.innerHTML = `
      <div class="pb-main">
        <b class="${d.verdict === 'buy' ? 'v-buy' : 'v-pass'}">${d.verdict === 'buy' ? 'BUY' : 'PASS'}</b>
        <span class="rn">${escapeHtml(d.itemName)}</span>
        <span class="rp">${d.maxBuyCents !== null && d.maxBuyCents !== undefined ? 'max ' + centsToDollars(d.maxBuyCents) : ''}</span>
        <span class="pb-date">${date}</span>
        ${r.pending ? '<span class="rpend">●</span>' : ''}
      </div>
      <div class="pb-detail" hidden>
        ${d.askingCents !== null && d.askingCents !== undefined ? `<div>Asking: ${centsToDollars(d.askingCents)}</div>` : ''}
        ${d.reason ? `<div>Why: ${escapeHtml(d.reason)}</div>` : ''}
        ${d.locationNote ? `<div>Where: ${escapeHtml(d.locationNote)}</div>` : ''}
        <div>Category: ${escapeHtml(d.category || 'other')}</div>
        ${d.promotedToItem ? '<div>Promoted to inventory ✓</div>' : ''}
      </div>`;
    el.querySelector('.pb-main').addEventListener('click', () => {
      const det = el.querySelector('.pb-detail');
      det.hidden = !det.hidden;
    });
    box.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function init() {
  if (wired) return;
  wired = true;
  const cat = $('pbCategory');
  CATEGORIES.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    cat.appendChild(o);
  });
  ['pbSearch', 'pbCategory', 'pbVerdict'].forEach((id) => {
    $(id).addEventListener('input', render);
  });
  window.addEventListener('outbox:change', () => {
    if (!$('view-pricebook').hidden) render();
  });
  window.addEventListener('view:show', (e) => {
    if (e.detail.view === 'pricebook') render();
  });
  render();
}
