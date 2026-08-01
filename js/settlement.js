// settlement.js — the money math (FR-013, FLIP-D18, FLIP-D19).
//
// Pure by design: no DOM, no imports, no side effects. Everything here runs in
// node so the fixtures in tests/settlement.test.mjs can prove the numbers
// without a browser. Integer cents only, never floats.
//
// FLIP-D18: a sale is a FREEZE POINT. This is the one deliberate exception to
// ADR-006 ("derive, never store"). Margin and payouts are computed once at sale
// close and written onto the sale record, because editing a share percentage
// two months later must not silently rewrite what was already paid.
//
// FLIP-D19: whoever fronts the money recoups it first, and partner profit
// shares floor at zero. A partner never OWES on a bad flip, but a partner who
// put up capital can get back less than she put in. That is intentional.

// ---------- helpers ----------

// Partner NAME IS THE LEDGER KEY, so it is normalized everywhere it is read.
// Phone entry leaves trailing spaces (seen in real data 2026-07-31); without
// this, "Ada" and "Ada " are two people owed two separate balances and a
// partner who has been paid in full never clears off the tab.
export function partnerKey(name) {
  return String(name == null ? '' : name).trim();
}

export function activePartners(partners) {
  return (partners || [])
    .filter((p) => p && partnerKey(p.name))
    .map((p) => ({ ...p, name: partnerKey(p.name) }));
}

export function sharesTotal(partners) {
  return activePartners(partners).reduce((s, p) => s + (Number(p.sharePct) || 0), 0);
}

// A partner's investedCents is the PORTION OF costCents she put up — not money
// on top of it. Ben's own stake is therefore whatever is left over.
export function investedTotal(partners) {
  return activePartners(partners).reduce((s, p) => s + (Number(p.investedCents) || 0), 0);
}

export function benInvested(costCents, partners) {
  return (costCents || 0) - investedTotal(partners);
}

// ---------- acquisition (FLIP-D21) ----------

// Did Ben actually make a BUYING DECISION on this item?
//
// A gifted or already-owned item can still be listed and sold at a profit, and
// that profit is real money. But it must never count toward the buy hit rate:
// a $0 gift that sells for $80 is an infinite return on a decision he never
// made, and mixing those in would flatter the one number meant to tell him
// whether he is any good at picking.
//
// Profit counts. The pick does not. Those are different questions.
//
// Items created before this field existed have no `acquisition` and are
// treated as bought, which is what they were.
export function isBuy(d) {
  return !!d && (!d.acquisition || d.acquisition === 'bought');
}

// Capital at risk. Only bought items tie up money Ben chose to spend, so this
// is the denominator for return-on-investment; a gift's $0 is not a shrewd buy.
export function investedCapital(items) {
  return (items || []).filter(isBuy).reduce((s, d) => s + (d.costCents || 0), 0);
}

// ---------- margin ----------

// Margin is proceeds minus what the item cost. Unchanged since story 3.2.
export function computeMargin(d) {
  if (!d || !d.sale || d.sale.priceCents == null) return null;
  return d.sale.priceCents - (d.costCents || 0) - (d.sale.feesCents || 0);
}

export function proceedsOf(sale) {
  if (!sale || sale.priceCents == null) return 0;
  return sale.priceCents - (sale.feesCents || 0);
}

// ---------- settlement (FLIP-D19) ----------
//
//   proceeds = price - fees
//   1. Return capital, pro-rata if proceeds fall short of cost
//   2. margin = proceeds - cost
//   3. If margin > 0, each partner also takes round(margin * share% / 100)
//   4. Ben takes the remainder: his capital back plus whatever profit is left
//
// Returns the frozen-payout shape. capitalCents + profitCents === payoutCents,
// kept separate so a receipt can say "your $20 back, plus $25 profit" instead
// of one unexplained number.
export function settle(costCents, proceedsCents, partners) {
  const cost = costCents || 0;
  const proceeds = proceedsCents || 0;
  const margin = proceeds - cost;
  const ps = activePartners(partners);

  // Denominator for the pro-rata capital return. Normally this is cost. If the
  // partners somehow invested MORE than the item cost (bad data — the form
  // warns about it), fall back to what was actually contributed so nobody's
  // capital line silently inflates past the money in the deal.
  const basis = Math.max(cost, investedTotal(ps));

  const payouts = ps.map((p) => {
    const invested = Number(p.investedCents) || 0;
    const sharePct = Number(p.sharePct) || 0;

    let capitalCents = 0;
    if (invested > 0 && basis > 0) {
      capitalCents = Math.max(0, Math.min(invested, Math.round(proceeds * invested / basis)));
    }
    // The zero floor: no profit share on a break-even or losing flip, and a
    // partner is never asked to cover a loss.
    const profitCents = margin > 0 ? Math.round(margin * sharePct / 100) : 0;

    return {
      name: p.name,
      sharePct,
      investedCents: invested,
      capitalCents,
      profitCents,
      payoutCents: capitalCents + profitCents,
    };
  });

  const partnerTotal = payouts.reduce((s, p) => s + p.payoutCents, 0);

  return {
    marginCents: margin,
    proceedsCents: proceeds,
    payouts,
    // Step 4. Ben is not a row in partners[], so he implicitly absorbs the
    // rounding remainder along with his own capital and profit.
    benCents: proceeds - partnerTotal,
  };
}

// Settle a whole item from its sale record.
export function settleSale(d) {
  if (!d || !d.sale || d.sale.priceCents == null) return null;
  return settle(d.costCents || 0, proceedsOf(d.sale), d.partners);
}

// ---------- freeze point ----------

// The payouts of record for a sold item. Frozen values win; anything sold
// before the freeze shipped is settled on the fly until backfill writes it in.
export function frozenPayouts(d) {
  if (d && d.sale && Array.isArray(d.sale.payouts)) return d.sale.payouts;
  const s = settleSale(d);
  return s ? s.payouts : [];
}

export function frozenMargin(d) {
  if (d && d.sale && d.sale.marginCents != null) return d.sale.marginCents;
  return computeMargin(d);
}

// True when a sold item predates the freeze and needs backfilling.
export function needsFreeze(d) {
  return !!(d && d.status === 'sold' && d.sale && d.sale.priceCents != null
            && !Array.isArray(d.sale.payouts));
}

// Writes the freeze onto a sale record in place. Idempotent: never overwrites
// an existing freeze, because that is the whole point of one.
export function freezeSale(d) {
  if (!d || !d.sale || Array.isArray(d.sale.payouts)) return d;
  const s = settleSale(d);
  if (!s) return d;
  d.sale.marginCents = s.marginCents;
  d.sale.payouts = s.payouts;
  return d;
}

// ---------- payments (append-only) ----------

// Reversals are negative-amount rows, never edits or deletes, so Ben can
// always answer "what did I pay her, and when."
export function paymentsTotal(payments, name) {
  const key = partnerKey(name);
  return (payments || [])
    .filter((pm) => pm && partnerKey(pm.name) === key)
    .reduce((s, pm) => s + (Number(pm.amountCents) || 0), 0);
}

// The partner ledger: what each partner has earned across sold items, what she
// has actually been handed, and the difference. THIS is "owed" — the old
// computePartnerTotals returned lifetime earnings and called it a balance, so
// the tab could only ever grow and never went to zero after Ben paid up.
export function computePartnerLedger(items) {
  const rows = {};
  const row = (name) => (rows[name] = rows[name] || { name, earnedCents: 0, paidCents: 0, owedCents: 0 });

  (items || []).forEach((d) => {
    if (d.status === 'sold') {
      frozenPayouts(d).forEach((p) => { row(p.name).earnedCents += p.payoutCents; });
    }
    // A payment counts wherever it was recorded, regardless of item status.
    (d.payments || []).forEach((pm) => {
      const key = pm && partnerKey(pm.name);
      if (key) row(key).paidCents += Number(pm.amountCents) || 0;
    });
  });

  Object.values(rows).forEach((r) => { r.owedCents = r.earnedCents - r.paidCents; });
  return rows;
}

// ---------- settle-up (Stage 2, FLIP-D22) ----------

// This file imports nothing, so it carries its own formatter rather than
// reaching into investigate.js. Same output as the app's centsToDollars on
// purpose: a receipt that formats money differently from the screen it came
// from reads like a different number.
function money(cents) {
  return ((cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// computePartnerLedger answers "what do I owe her." This answers "on which
// items," which is what a settle-up screen and a receipt both need — one
// balance is not a thing you can hand someone and have them recognise.
//
// Rows carry everything a receipt line needs, so nothing downstream has to go
// back to the item record.
export function partnerItemLedger(items, name) {
  const key = partnerKey(name);
  const rows = [];

  (items || []).forEach((d) => {
    if (!d) return;
    let earned = 0, capital = 0, profit = 0, sharePct = 0, hasPayout = false;
    if (d.status === 'sold') {
      frozenPayouts(d).forEach((p) => {
        if (partnerKey(p.name) !== key) return;
        hasPayout = true;
        earned += p.payoutCents || 0;
        capital += p.capitalCents || 0;
        profit += p.profitCents || 0;
        sharePct += Number(p.sharePct) || 0;
      });
    }
    const paid = paymentsTotal(d.payments, key);
    // A payment with no matching payout still belongs here — that is how a
    // reversal, or a payment recorded against the wrong item, stays visible
    // instead of quietly unbalancing the total against computePartnerLedger.
    if (!hasPayout && paid === 0) return;

    rows.push({
      itemId: d.id,
      flipId: d.flipId || null,
      itemName: d.name || '',
      soldAt: (d.sale && d.sale.soldAt) || null,
      salePriceCents: (d.sale && d.sale.priceCents != null) ? d.sale.priceCents : null,
      marginCents: hasPayout ? frozenMargin(d) : null,
      sharePct,
      capitalCents: capital,
      profitCents: profit,
      earnedCents: earned,
      paidCents: paid,
      owedCents: earned - paid,
    });
  });

  // Oldest sale first: money owed longest gets settled first, and a receipt
  // listing three items should read in the order they happened.
  rows.sort((a, b) => {
    const ad = a.soldAt || '9999-99-99';
    const bd = b.soldAt || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.flipId || '') < String(b.flipId || '') ? -1 : 1;
  });
  return rows;
}

// One settlement across several items becomes ONE payoutId group — that group
// is the receipt (FLIP-D18). Payments are append-only rows; this never edits or
// clears anything, so the ledger stays a history rather than a current state.
//
// ID generation is passed in rather than imported, because this module stays
// pure and DOM-free so node can run the fixtures against it.
export function buildPayout(name, rows, opts) {
  const o = opts || {};
  const key = partnerKey(name);
  const payoutId = o.payoutId || '';
  const paidAt = o.paidAt || '';
  const method = o.method || '';
  const nextId = typeof o.nextId === 'function' ? o.nextId : () => '';

  // Only ever pay what is actually outstanding. A zero or negative row would
  // write a payment that makes the balance wrong in the other direction.
  const lines = (rows || []).filter((r) => r && r.owedCents > 0);

  return {
    payoutId,
    name: key,
    paidAt,
    method,
    methodLabel: o.methodLabel || '',
    lines,
    totalCents: lines.reduce((s, r) => s + r.owedCents, 0),
    payments: lines.map((r) => ({
      itemId: r.itemId,
      payment: {
        id: nextId(),
        name: key,
        amountCents: r.owedCents,
        paidAt,
        method,
        payoutId,
        note: o.note || '',
      },
    })),
  };
}

// The thing Ben actually hands over. Capital and profit are SEPARATE LINES
// (FLIP-D22) — "your $30 back" then "$95 profit", never one number she has to
// take on faith. The whole point of the app is that she can check the math.
export function formatReceipt(payout) {
  if (!payout || !payout.lines || !payout.lines.length) return '';
  const out = [`${payout.name}${payout.paidAt ? ' — ' + payout.paidAt : ''}`, ''];

  payout.lines.forEach((r) => {
    out.push(`${r.flipId ? r.flipId + ' ' : ''}${r.itemName}`.trim());
    if (r.salePriceCents != null) out.push(`  sold ${money(r.salePriceCents)}, margin ${money(r.marginCents)}`);

    const parts = [];
    if (r.capitalCents) parts.push(`  your ${money(r.capitalCents)} back`);
    if (r.profitCents) parts.push(`  ${r.sharePct ? r.sharePct + '% of the profit: ' : 'profit: '}${money(r.profitCents)}`);
    // A part-paid item's frozen breakdown no longer adds up to what is left, so
    // the receipt shows the subtraction rather than a number that looks wrong.
    if (r.paidCents > 0) parts.push(`  less already paid: ${money(r.paidCents)}`);
    else if (r.paidCents < 0) parts.push(`  plus a reversal: ${money(-r.paidCents)}`);
    parts.forEach((p) => out.push(p));

    // With a single component the line IS the amount; repeating it as a total
    // would just be the same number twice.
    if (parts.length > 1) out.push(`  → ${money(r.owedCents)}`);
    out.push('');
  });

  out.push(`Total: ${money(payout.totalCents)}${payout.methodLabel ? ' · ' + payout.methodLabel : ''}`);
  return out.join('\n');
}
