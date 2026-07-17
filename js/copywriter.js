// copywriter.js — pure template engine (story 4.1 / FR-006, FR-014, ADR-009).
// No DOM, no storage, no network. Same fields in → same copy out. Casual voice,
// complete details, and NEVER an em-dash (guard at every exit).

// ---- the em-dash guard: every string leaves through here ----
export function guard(s) {
  return String(s)
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, ', ')
    .replace(/\s*--+\s*/g, ', ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const money = (c) => '$' + (c % 100 === 0 ? (c / 100) : (c / 100).toFixed(2));

// Deterministic variant pick: same item (seed) always gets the same opener.
function pick(arr, seed) {
  if (!seed) return arr[0];
  const n = String(seed).split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return arr[n % arr.length];
}

const OPENERS = {
  electronics: [
    'Clearing out some gear:',
    'Up for grabs:',
    'From my collection:',
  ],
  musical: [
    'Musician clearing space:',
    'From a piano teacher’s studio:',
    'Making room for new gear:',
  ],
  tools: [
    'Garage cleanout:',
    'Tool box is overflowing, so:',
    'Downsizing the workshop:',
  ],
  furniture: [
    'Making space at home:',
    'Furniture refresh means this goes:',
    'Moving things around, so:',
  ],
  other: [
    'Up for grabs:',
    'Clearing things out:',
  ],
};

// What "it works" sounds like per category.
function worksLine(category, worksStatus) {
  if (!worksStatus) return '';
  const w = worksStatus.trim();
  switch (category) {
    case 'electronics': return `Tested and ${w}.`;
    case 'musical': return `Plays great: ${w}.`;
    case 'tools': return `Fired it up before listing: ${w}.`;
    default: return `Condition-wise: ${w}.`;
  }
}

function bodyParts(category, f) {
  const name = [f.brand, f.model].filter(Boolean).join(' ') || f.name || 'this one';
  const parts = [];
  parts.push(pick(OPENERS[category] || OPENERS.other, f.seed) + ' ' + name + '.');
  if (f.condition) parts.push(`Overall condition is ${f.condition.trim()}.`);
  const wl = worksLine(category, f.worksStatus);
  if (wl) parts.push(wl);
  if (f.dimensions) parts.push(`Measures ${f.dimensions.trim()}.`);
  if (f.accessories) parts.push(`Comes with ${f.accessories.trim()}.`);
  if (f.quirks) parts.push(`Being upfront: ${f.quirks.trim()}.`);
  if (f.priceCents != null) parts.push(`Asking ${money(f.priceCents)}.`);
  return { name, parts };
}

const CLOSERS = {
  fbm: 'Cash or Venmo, porch pickup is easy. Happy to answer questions.',
  ebay: 'Ships carefully packed. Check the photos, they are part of the description.',
};

// generate(category, platform, fields) → description string.
// fields: { name?, brand?, model?, condition?, worksStatus?, quirks?,
//           dimensions?, accessories?, priceCents?, seed? }
export function generate(category, platform, fields) {
  const f = fields || {};
  const { parts } = bodyParts(category, f);
  parts.push(CLOSERS[platform] || CLOSERS.fbm);
  let out = parts.join(' ');
  if (platform === 'ebay') {
    const specs = [
      ['Brand', f.brand], ['Model', f.model], ['Condition', f.condition],
      ['Working status', f.worksStatus], ['Includes', f.accessories], ['Dimensions', f.dimensions],
    ].filter(([, v]) => v && String(v).trim());
    if (specs.length) {
      out += '\n\n' + specs.map(([k, v]) => `${k}: ${guard(v)}`).join('\n');
    }
  }
  return guard(out).split('\n').map((l) => guard(l)).join('\n');
}

// generateTitle(category, platform, fields) → title string (FR-014).
// eBay: keyword-dense, hard 80-char budget, brand/model first.
// FB: short and human.
const CATEGORY_KEYWORDS = {
  electronics: 'Tested Works',
  musical: 'Tested Sounds Great',
  tools: 'Runs Strong',
  furniture: 'Solid Condition',
  other: 'Good Condition',
};

export function generateTitle(category, platform, fields) {
  const f = fields || {};
  const core = [f.brand, f.model, f.name].filter(Boolean).join(' ').trim() || 'For Sale';
  if (platform === 'ebay') {
    let t = core;
    const extras = [f.condition, CATEGORY_KEYWORDS[category] || ''].filter(Boolean);
    for (const ex of extras) {
      if ((t + ' ' + ex).length <= 80) t = t + ' ' + ex;
    }
    if (t.length > 80) {
      t = t.slice(0, 80);
      const cut = t.lastIndexOf(' ');
      if (cut > 40) t = t.slice(0, cut);
    }
    return guard(t);
  }
  const price = f.priceCents != null ? ', ' + money(f.priceCents) : '';
  return guard(core + price);
}

// Per-category copy fields the UI renders (story 4.2 consumes this).
export const FIELD_SETS = {
  electronics: [
    ['brand', 'Brand'], ['model', 'Model'], ['condition', 'Condition'],
    ['worksStatus', 'Tested? works how?'], ['accessories', 'Cables/accessories included'], ['quirks', 'Flaws to disclose'],
  ],
  musical: [
    ['brand', 'Brand'], ['model', 'Model'], ['condition', 'Condition'],
    ['worksStatus', 'How it plays/sounds'], ['accessories', 'Stand/pedal/case included'], ['quirks', 'Flaws to disclose'],
  ],
  tools: [
    ['brand', 'Brand'], ['model', 'Model'], ['condition', 'Condition'],
    ['worksStatus', 'Runs/works status'], ['accessories', 'Blades/bits/case included'], ['quirks', 'Flaws to disclose'],
  ],
  furniture: [
    ['brand', 'Brand/maker (if known)'], ['condition', 'Condition'], ['dimensions', 'Dimensions'],
    ['worksStatus', 'Sturdy? drawers/doors work?'], ['quirks', 'Flaws to disclose'],
  ],
  other: [
    ['brand', 'Brand'], ['model', 'Model'], ['condition', 'Condition'], ['quirks', 'Flaws to disclose'],
  ],
};
