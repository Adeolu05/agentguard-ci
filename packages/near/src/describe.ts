import type { NearExecutionResult, StatusCheck } from "./executor.js";
import { testnetExplorerTxUrl } from "./explorer.js";

const FINAL_STATUS: Record<"confirmed" | "failed" | "pending", string> = {
  confirmed: "Final status: CONFIRMED. The transfer executed on testnet.",
  failed: "Final status: FAILED on-chain. The transfer did not execute, and its budget was released.",
  pending:
    "Final status: NOT FINAL YET. The network accepted the transaction but it has not finished executing. The reservation stays submitted and keeps counting toward limits; re-check it with the explorer link.",
};

/**
 * Human-readable lines for one execution attempt. The hash is printed exactly as the
 * network returned it, an explorer link is only built for a well-formed hash, and an
 * ambiguous outcome is always called ambiguous.
 */
export function describeExecution(result: NearExecutionResult, check?: StatusCheck): string[] {
  if (result.status === "refused") {
    return [`Refused before signing (${result.reasonCode ?? "REFUSED"}): ${result.message}. Nothing was signed or sent.`];
  }
  const lines: string[] = [];
  if (result.transactionHash !== undefined) {
    lines.push(`Transaction hash (exactly as returned by the network): ${result.transactionHash}`);
    const url = testnetExplorerTxUrl(result.transactionHash);
    lines.push(url ? `Explorer: ${url}` : "Explorer: no link (the returned value is not a well-formed transaction hash)");
  } else {
    lines.push("Transaction hash: none was returned by the network, so there is no explorer link.");
  }
  if (result.status === "unknown") {
    lines.push(
      `Final status: UNKNOWN. The outcome is ambiguous (${result.message}): the transfer may or may not have executed. The reservation stays submitted and keeps counting toward limits. Check the sender's history in the explorer before trying again.`,
    );
  } else {
    lines.push(FINAL_STATUS[result.status]);
  }
  if (check) {
    const verdict =
      check.status === "unknown"
        ? `UNKNOWN (${check.message})`
        : check.status === result.status
          ? `${check.status.toUpperCase()} (matches)`
          : `${check.status.toUpperCase()} (differs from the broadcast result, ${result.status})`;
    lines.push(`Re-read from the RPC by hash: ${verdict}`);
  }
  return lines;
}
