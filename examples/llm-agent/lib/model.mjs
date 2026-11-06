// The two model clients: LIVE (NEAR AI Cloud, OpenAI-compatible Chat Completions) and
// RECORDED (replays the exact bytes of an earlier run; no network).
//
// Sources (fetched 2026-11-06): docs.near.ai/cloud/quickstart, docs.near.ai/api-reference/introduction,
// docs.near.ai/api-reference/chat/create-chat-completion, docs.near.ai/cloud/verification/cloud-api/response-signatures.
//
// The API key is only read from NEAR_AI_API_KEY, sent only in the Authorization header to the
// configured base URL, and never printed or written to a recording.
import { checkResponseSignature } from "./signature.mjs";

export const OFFICIAL_BASE_URL = "https://cloud-api.near.ai/v1";
/** A NEAR AI-hosted (Confidential TEE) model with tool support, per GET /v1/models on 2026-11-06. */
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
export const RECORDING_FORMAT = "agentguard-llm-recording/1";

/** Only https, or http on the loopback interface (for the offline tests' local stub). */
export function checkBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `NEAR_AI_BASE_URL is not a URL: ${raw}` };
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, reason: "NEAR_AI_BASE_URL must use https (http is allowed only for 127.0.0.1 or localhost)" };
  }
  return { ok: true, url: url.toString().replace(/\/$/, "") };
}

/** Replaces every occurrence of the secret in a string. */
export function redact(text, secret) {
  const s = String(text);
  return secret ? s.split(secret).join("[REDACTED]") : s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Live client. `complete(body)` sends one Chat Completions request built from `body` and returns
 * the parsed message plus the exact bytes, the response signature (if any) and its check.
 */
export function liveModel({ apiKey, baseUrl = OFFICIAL_BASE_URL, model = DEFAULT_MODEL, fetchImpl = fetch, signatureRetries = 3, signatureDelayMs = 1_000 }) {
  if (!apiKey) throw new Error("NEAR_AI_API_KEY is not set");
  const checked = checkBaseUrl(baseUrl);
  if (!checked.ok) throw new Error(checked.reason);
  const base = checked.url;
  const turns = [];

  async function getSignature(id) {
    // 404 can mean "not recorded yet": retry a few times, then report it as unavailable.
    for (let attempt = 0; attempt <= signatureRetries; attempt++) {
      const res = await fetchImpl(`${base}/signature/${encodeURIComponent(id)}?signing_algo=ed25519`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          return { unavailable: true, message: "the signature response is not JSON" };
        }
      }
      if (res.status !== 404) return { unavailable: true, message: `HTTP ${res.status}` };
      if (attempt < signatureRetries) await sleep(signatureDelayMs);
    }
    return { unavailable: true, message: "HTTP 404 (no signature found)" };
  }

  return {
    mode: "live",
    model,
    label: base === OFFICIAL_BASE_URL ? `LIVE: NEAR AI Cloud (${base}), model ${model}` : `LIVE: OpenAI-compatible endpoint ${base} (not NEAR AI Cloud), model ${model}`,
    source: base === OFFICIAL_BASE_URL ? "near-ai-cloud" : `other endpoint: ${base}`,
    turns,
    async complete(body) {
      const requestBody = JSON.stringify({ model, ...body });
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "identity", // the signature covers the uncompressed body
          "x-no-aliasing": "true", // keep the canonical model ID, which a provider_tee signature covers
        },
        body: requestBody,
        signal: AbortSignal.timeout(180_000),
      });
      const responseBytes = Buffer.from(await res.arrayBuffer());
      const responseBody = responseBytes.toString("utf8");
      if (!res.ok) throw new Error(redact(`the model endpoint returned HTTP ${res.status}: ${responseBody.slice(0, 500)}`, apiKey));
      if (!Buffer.from(responseBody, "utf8").equals(responseBytes)) throw new Error("the response is not valid UTF-8, so it cannot be recorded exactly");
      const parsed = JSON.parse(responseBody);
      const signature = typeof parsed.id === "string" ? await getSignature(parsed.id) : null;
      const signatureCheck = checkResponseSignature({ signature, requestBytes: Buffer.from(requestBody, "utf8"), responseBytes, model });
      turns.push({ requestBody, responseBody, signature });
      return { id: parsed.id, message: parsed.choices?.[0]?.message, signatureCheck };
    },
  };
}

/** Replays a recording. Fails if the agent sends a request that differs from the recorded one. */
export function replayModel(recording) {
  if (recording?.format !== RECORDING_FORMAT || !Array.isArray(recording.turns)) throw new Error(`not a ${RECORDING_FORMAT} recording`);
  let i = 0;
  return {
    mode: "recorded",
    model: recording.model,
    label: `RECORDED: replaying ${recording.turns.length} model responses (source: ${recording.sourceDescription}). No network request is made.`,
    source: recording.source,
    turns: recording.turns,
    async complete(body) {
      const turn = recording.turns[i++];
      if (!turn) throw new Error("the recording has no more model responses");
      const requestBody = JSON.stringify({ model: recording.model, ...body });
      if (requestBody !== turn.requestBody) {
        throw new Error(`request ${i} differs from the recorded one, so the recording does not match this code; record it again (see README)`);
      }
      const parsed = JSON.parse(turn.responseBody);
      const signatureCheck = checkResponseSignature({
        signature: turn.signature,
        requestBytes: Buffer.from(turn.requestBody, "utf8"),
        responseBytes: Buffer.from(turn.responseBody, "utf8"),
        model: recording.model,
      });
      return { id: parsed.id, message: parsed.choices?.[0]?.message, signatureCheck };
    },
  };
}

/** Builds the recording file content from a finished live run. Refuses if the key appears in it. */
export function buildRecording(liveClient, { apiKey, sourceDescription }) {
  const recording = {
    format: RECORDING_FORMAT,
    source: liveClient.source,
    sourceDescription,
    recordedAt: new Date().toISOString(),
    model: liveClient.model,
    note: "Exact request and response bodies of one run of examples/llm-agent. No headers are stored, so no API key. Replay with: pnpm --filter @agentguard/example-llm-agent demo",
    turns: liveClient.turns,
  };
  const text = `${JSON.stringify(recording, null, 2)}\n`;
  if (apiKey && text.includes(apiKey)) throw new Error("refusing to write a recording that contains the API key");
  return text;
}
