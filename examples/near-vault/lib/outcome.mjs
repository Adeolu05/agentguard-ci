// Reading NEAR transaction results: return values, logs, NEP-297 events, failures and gas.
// Used by the sandbox harness and by the testnet scripts.

/** Collects the logs of a transaction and of every receipt it produced. */
export function logsOf(tx) {
  const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome ?? [])];
  return outcomes.flatMap((o) => o?.outcome?.logs ?? []);
}

/** NEP-297 events (`EVENT_JSON:` log lines), parsed. */
export function eventsOf(tx) {
  return logsOf(tx)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
}

/** The function call's JSON return value, if any. */
export function decodeReturn(status) {
  const b64 = status?.SuccessValue;
  if (b64 === undefined || b64 === "") return undefined;
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** The panic message of a failed transaction or receipt, if any. */
export function failureMessage(tx) {
  const failure = tx.status?.Failure ?? tx.receipts_outcome?.find((r) => r.outcome?.status?.Failure)?.outcome.status.Failure;
  if (!failure) return undefined;
  const exec = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return typeof exec === "string" ? exec : JSON.stringify(failure);
}

/** Total gas burnt by a transaction and all its receipts. */
export function gasBurnt(tx) {
  const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome ?? [])];
  return outcomes.reduce((s, o) => s + BigInt(o?.outcome?.gas_burnt ?? 0), 0n);
}
