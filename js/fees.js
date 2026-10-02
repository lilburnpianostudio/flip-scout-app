// fees.js — what a marketplace keeps, and what is left (v25, FLIP-D31).
// Pure: no DOM, no storage, no network. tests/fees.test.mjs proves it with
// nothing but node.
//
// Why it exists: "ask $200" means $200 on Facebook at a porch pickup and about
// $172 on eBay. Ben was pricing every platform as if it were the first one.
//
// The rates below are a FALLBACK. The live table is config/fees.json in the
// private repo, so a rate change is an edit there, not a release here. Every
// table carries the date it was checked, and the screen shows that date, so a
// stale table reads as stale instead of as fact.
//
// These are estimates. eBay charges its fee on the total the buyer pays,
// sales tax included, and this cannot know the buyer's tax; the real fee runs
// a little higher than the figure here.

export const DEFAULT_FEES = {
  checkedOn: '2026-10-02',
  platforms: {
    // Local pickup is free on all three; the shipped rate applies only when
    // the buyer checks out through the app.
    fbm: { defaultMode: 'local', local: { pct: 0 }, shipped: { pct: 10, minCents: 80 } },
    offerup: { defaultMode: 'local', local: { pct: 0 }, shipped: { pct: 12.9, minCents: 199 } },
    craigslist: { defaultMode: 'local', local: { pct: 0 } },
    // Most categories 13.6%; guitars and basses 6.7%. Per-order fee is 30
    // cents up to $10 and 40 cents above it.
    ebay: {
      defaultMode: 'shipped',
      shipped: { pct: 13.6, fixedCents: 40, smallOrderFixedCents: 30, smallOrderMaxCents: 1000 },
      categoryPct: { guitars: 6.7 },
    },
    // Vinted charges the buyer, not the seller.
    vinted: { defaultMode: 'shipped', shipped: { pct: 0 } },
    // No selling fee in the US; payment processing only.
    depop: { defaultMode: 'shipped', shipped: { pct: 3.3, fixedCents: 45 } },
  },
};

// A table from config can be partial or malformed. Anything it does not say
// falls back to the default for that platform, so a typo in the private repo
// can never turn a fee into NaN on the screen.
export function mergeFees(custom) {
  if (!custom || typeof custom !== 'object' || !custom.platforms) return DEFAULT_FEES;
  return {
    checkedOn: custom.checkedOn || DEFAULT_FEES.checkedOn,
    platforms: { ...DEFAULT_FEES.platforms, ...custom.platforms },
  };
}

export function sellMode(platform, table = DEFAULT_FEES) {
  const p = table.platforms[platform];
  return (p && p.defaultMode) || 'local';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The fee on one sale.
//   priceCents           what the item sold (or would sell) for
//   opts.mode            'local' | 'shipped'; defaults to how that platform usually sells
//   opts.buyerShipCents  shipping the BUYER pays, which the fee is also charged on
//   opts.feeClass        e.g. 'guitars', to use a category rate where one exists
// Returns null for an unknown platform or a missing price: unknown is not $0.
export function feeFor(platform, priceCents, opts = {}, table = DEFAULT_FEES) {
  const p = table.platforms[platform];
  if (!p || priceCents == null || !Number.isFinite(Number(priceCents))) return null;
  const mode = opts.mode || p.defaultMode || 'local';
  // A platform with no shipped rate (Craigslist) is local whatever was asked.
  const rule = p[mode] || p.local || p.shipped;
  if (!rule) return null;
  const base = Math.max(0, num(priceCents) + num(opts.buyerShipCents));
  let pct = num(rule.pct);
  if (mode === 'shipped' && opts.feeClass && p.categoryPct && p.categoryPct[opts.feeClass] != null) {
    pct = num(p.categoryPct[opts.feeClass]);
  }
  let fee = Math.round(base * pct / 100);
  if (rule.smallOrderMaxCents != null && base <= num(rule.smallOrderMaxCents)) fee += num(rule.smallOrderFixedCents);
  else fee += num(rule.fixedCents);
  if (rule.minCents != null && pct > 0 && fee < num(rule.minCents)) fee = num(rule.minCents);
  return fee;
}

// What is left after the marketplace and the post office.
//   opts.shipCostCents   what the SELLER pays to ship it (0 when the buyer pays a label)
// netCents is before the item's own cost; profitCents is after it.
export function expectedNet(platform, priceCents, opts = {}, table = DEFAULT_FEES) {
  const feeCents = feeFor(platform, priceCents, opts, table);
  if (feeCents == null) return null;
  const mode = opts.mode || sellMode(platform, table);
  const shipCostCents = mode === 'shipped' ? num(opts.shipCostCents) : 0;
  const netCents = num(priceCents) - feeCents - shipCostCents;
  return {
    platform,
    mode,
    priceCents: num(priceCents),
    feeCents,
    shipCostCents,
    netCents,
    profitCents: opts.costCents == null ? null : netCents - num(opts.costCents),
  };
}

// Musical gear splits two ways on eBay. A guitar or bass pays less than half
// the usual rate, and the name is the only place that says which it is.
export function feeClassOf(d) {
  if (!d) return null;
  const text = `${d.name || ''} ${(d.copyFields && d.copyFields.model) || ''}`.toLowerCase();
  if (d.category === 'musical' && /\b(guitar|bass|stratocaster|telecaster|les paul)\b/.test(text)
      && !/\b(amp|amplifier|pedal|case|strap|stand)\b/.test(text)) return 'guitars';
  return null;
}
