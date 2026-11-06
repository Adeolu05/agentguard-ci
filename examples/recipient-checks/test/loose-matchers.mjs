// Deliberately WRONG recipient matchers, the "forgiving" kind that ends up in agent tool code.
// Used only by the test that shows the recipient-checks pack catches each of them. Each one
// is a guard target that answers ALLOW when its matcher says the recipient is allowlisted.

/** Folds look-alikes together: lower case, Cyrillic o and l, rn to m, 0 to o, 1 to l. */
const skeleton = (s) =>
  s.normalize("NFKC").toLowerCase().replace(/о/g, "o").replace(/ӏ/g, "l").replace(/rn/g, "m").replace(/0/g, "o").replace(/1/g, "l");

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

export const MATCHERS = {
  exact: (r, a) => r === a,
  includes: (r, a) => r.includes(a) || a.includes(r),
  prefix: (r, a) => r.startsWith(a),
  suffix: (r, a) => r.endsWith(a),
  "edit-distance-1": (r, a) => editDistance(r, a) <= 1,
  "look-alike-folding": (r, a) => skeleton(r) === skeleton(a),
  "strip-network-suffix": (r, a) => r.replace(/\.(testnet|near)$/, "") === a,
  "separator-insensitive": (r, a) => r.replace(/[._]/g, "-") === a,
};

export function makeGuard(kind) {
  const matches = MATCHERS[kind];
  if (!matches) throw new Error(`unknown matcher ${kind}`);
  return ({ policyDocument }) => ({
    name: `${kind}-matcher`,
    capabilities: {},
    async propose(p) {
      const r = String(p.recipientId);
      return { decision: policyDocument.recipients.allowed.some((a) => matches(r, a)) ? "ALLOW" : "BLOCK" };
    },
  });
}
