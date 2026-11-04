// A deliberately naive, hand-rolled spending guard of the kind often written inline in
// agent tool code. AgentGuard's scenario suite finds its bugs:
//  - parseFloat amounts (accepts "-50", "1e1", 5.5; precision is lost)
//  - case-insensitive, trimmed recipient matching (equates distinct identities)
//  - no daily accounting, no idempotency, no network or asset checks
//  - trusts an `approved` flag supplied by the agent itself
export function createTarget({ policyDocument }) {
  const asset = policyDocument.assets[0];
  const allowed = policyDocument.recipients.allowed.map((r) => r.toLowerCase());
  return {
    name: "naive-guard",
    capabilities: {}, // no reason codes, approvals, lifecycle or ledger inspection
    async propose(p) {
      const amount = parseFloat(p.amount ?? p.amountAtomic);
      if (!allowed.includes(String(p.recipientId).toLowerCase().trim())) return { decision: "BLOCK" };
      if (amount > parseFloat(asset.max_transaction_amount)) return { decision: "BLOCK" };
      if (amount > parseFloat(asset.approval_required_above) && p.approved !== true) return { decision: "REQUIRE_APPROVAL" };
      return { decision: "ALLOW" };
    },
  };
}
