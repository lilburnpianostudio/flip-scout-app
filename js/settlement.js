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
