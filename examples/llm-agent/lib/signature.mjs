// Checks a NEAR AI Cloud response signature (GET /v1/signature/{id}) against the exact
// request and response bytes, following docs.near.ai/cloud/verification/cloud-api/response-signatures
// and docs.near.ai/cloud/verification/reference/response-signature-verification.
//
// Only Ed25519 is checked here (node:crypto verifies it without extra dependencies).
// IMPORTANT: a valid signature shows that the holder of `signing_address` signed these exact
// bytes. It does NOT show that this key belongs to an attested TEE: that needs the gateway or
// model attestation report, verified before the request (not done by this demo).
import { createHash, createPublicKey, verify } from "node:crypto";

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The text NEAR AI Cloud signs, by signature_kind. */
export function expectedSignatureText(kind, model, requestBytes, responseBytes) {
  const hashes = `${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
  if (kind === "provider_tee") return `${model}:${hashes}`;
  if (kind === "gateway") return hashes;
  return undefined;
}

function hexBytes(value, length) {
  if (typeof value !== "string") return undefined;
  const hex = value.replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== length * 2) return undefined;
  return Buffer.from(hex, "hex");
}

/**
 * @returns {{ status: "valid" | "invalid" | "unchecked", detail: string, kind?: string, signingAddress?: string }}
 */
export function checkResponseSignature({ signature, requestBytes, responseBytes, model }) {
  if (!signature) return { status: "unchecked", detail: "no signature available" };
  if (signature.error_code || signature.unavailable) {
    return { status: "unchecked", detail: `signature unavailable: ${String(signature.message ?? signature.error_code).slice(0, 200)}` };
  }
  const kind = signature.signature_kind;
  const base = { kind, signingAddress: signature.signing_address };
  const expected = expectedSignatureText(kind, model, requestBytes, responseBytes);
  if (expected === undefined) return { ...base, status: "unchecked", detail: `signature_kind ${JSON.stringify(kind)} is not one this demo knows` };
  if (signature.signing_algo !== "ed25519") {
    return { ...base, status: "unchecked", detail: `signing_algo ${JSON.stringify(signature.signing_algo)} is not checked by this demo (only ed25519)` };
  }
  if (signature.text !== expected) {
    return { ...base, status: "invalid", detail: "the signed text does not match the SHA-256 of the exact request and response bytes" };
  }
  const key = hexBytes(signature.signing_address, 32);
  const sig = hexBytes(signature.signature, 64);
  if (!key || !sig) return { ...base, status: "invalid", detail: "signing_address or signature is not the expected hex length" };
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" });
  if (!verify(null, Buffer.from(signature.text, "utf8"), publicKey, sig)) {
    return { ...base, status: "invalid", detail: "the Ed25519 signature does not verify with signing_address" };
  }
  return { ...base, status: "valid", detail: `Ed25519 signature by ${signature.signing_address} (${kind}) over the SHA-256 of the exact request and response bytes` };
}
