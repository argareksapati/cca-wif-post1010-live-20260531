import http from "node:http";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = 43180;
const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const summaryPath = join(runnerTemp, "mock-anthropic-summary.txt");
const requestsPath = join(runnerTemp, "mock-anthropic-requests.json");
const stateDir = join(runnerTemp, "mock-anthropic-state");
mkdirSync(stateDir, { recursive: true });

const state = {
  sentReadToolUse: false,
  sentCommentToolUse: false,
  exchangeAssertionSha256: "",
  readToolResultSha256: "",
  exchangeClaimsSha256: "",
  readClaimsSha256: "",
  claimsMatch: false,
  signatureVerified: false,
  issuer: "",
  audience: "",
  repository: "",
  jobWorkflowRef: "",
  runId: "",
  requests: [],
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function saveState() {
  writeFileSync(requestsPath, JSON.stringify(state.requests, null, 2));
  writeFileSync(
    summaryPath,
    [
      `EXCHANGE_ASSERTION_SHA256=${state.exchangeAssertionSha256}`,
      `READ_TOOL_RESULT_SHA256=${state.readToolResultSha256}`,
      `EXCHANGE_CLAIMS_SHA256=${state.exchangeClaimsSha256}`,
      `READ_CLAIMS_SHA256=${state.readClaimsSha256}`,
      `CLAIMS_MATCH=${state.claimsMatch}`,
      `SIGNATURE_VERIFIED=${state.signatureVerified}`,
      `JWT_ISSUER=${state.issuer}`,
      `JWT_AUDIENCE=${state.audience}`,
      `JWT_REPOSITORY=${state.repository}`,
      `JWT_JOB_WORKFLOW_REF=${state.jobWorkflowRef}`,
      `JWT_RUN_ID=${state.runId}`,
      `SENT_READ_TOOL_USE=${state.sentReadToolUse}`,
      `SENT_COMMENT_TOOL_USE=${state.sentCommentToolUse}`,
      `REQUEST_COUNT=${state.requests.length}`,
    ].join("\n") + "\n",
  );
}

function base64urlToBuffer(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64");
}

function parseJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("not a 3-part JWT");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  return {
    header: JSON.parse(base64urlToBuffer(encodedHeader).toString("utf8")),
    payload: JSON.parse(base64urlToBuffer(encodedPayload).toString("utf8")),
    signature: base64urlToBuffer(encodedSignature),
    signingInput: Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
  };
}

function canonicalClaims(payload) {
  return {
    iss: payload.iss || "",
    aud: Array.isArray(payload.aud)
      ? payload.aud.join(",")
      : String(payload.aud || ""),
    sub: payload.sub || "",
    repository: payload.repository || "",
    job_workflow_ref: payload.job_workflow_ref || "",
    run_id: payload.run_id || "",
    ref: payload.ref || "",
    sha: payload.sha || "",
    runner_environment: payload.runner_environment || "",
  };
}

function claimsSha256(payload) {
  return sha256(JSON.stringify(canonicalClaims(payload)));
}

async function verifyJwtWithGitHub(token) {
  const parsed = parseJwt(token);
  const openidConfigResp = await fetch(
    "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
  );
  if (!openidConfigResp.ok) {
    throw new Error(`openid configuration fetch failed: ${openidConfigResp.status}`);
  }
  const openidConfig = await openidConfigResp.json();
  const jwksResp = await fetch(openidConfig.jwks_uri);
  if (!jwksResp.ok) {
    throw new Error(`jwks fetch failed: ${jwksResp.status}`);
  }
  const jwks = await jwksResp.json();
  const key = Array.isArray(jwks.keys)
    ? jwks.keys.find((candidate) => candidate.kid === parsed.header.kid)
    : null;
  if (!key) {
    throw new Error(`no JWK found for kid ${parsed.header.kid}`);
  }
  const publicKey = createPublicKey({ key, format: "jwk" });
  const ok = verifySignature("RSA-SHA256", parsed.signingInput, publicKey, parsed.signature);
  return { ok, parsed };
}

function sanitizeRequestsBody(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRequestsBody(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const clone = { ...value };
  if (typeof clone.assertion === "string") {
    clone.assertion = "<redacted>";
  }
  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((message) => sanitizeRequestsBody(message));
  }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((item) => {
      if (
        item &&
        typeof item === "object" &&
        item.type === "tool_result" &&
        typeof item.content === "string"
      ) {
        return { ...item, content: "1\t<redacted>" };
      }
      return sanitizeRequestsBody(item);
    });
  }
  if (clone.tool_use_result?.file?.content) {
    clone.tool_use_result = {
      ...clone.tool_use_result,
      file: {
        ...clone.tool_use_result.file,
        content: "<redacted>",
      },
    };
  }
  return clone;
}

function sse(res, events, requestId) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "request-id": requestId,
  });
  for (const [event, data] of events) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function finalResponse(res, requestId, text = "done") {
  sse(
    res,
    [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: `msg_final_${requestId}`,
            type: "message",
            role: "assistant",
            model: "claude-mock",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ],
    requestId,
  );
}

function readToolResponse(res, requestId) {
  const tokenFile = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE || "";
  sse(
    res,
    [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_read_tool",
            type: "message",
            role: "assistant",
            model: "claude-mock",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_read_wif_token",
            name: "Read",
            input: {},
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: `{"file_path":${JSON.stringify(tokenFile)}}`,
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ],
    requestId,
  );
}

function commentToolResponse(res, requestId, hash) {
  const body =
    `WIF_LEAK_SHA256:${hash}\n` +
    `WIF_EXCHANGE_SHA256:${state.exchangeAssertionSha256}\n` +
    `WIF_CLAIMS_MATCH:${state.claimsMatch ? "YES" : "NO"}\n` +
    `WIF_SIG_VALID:${state.signatureVerified ? "YES" : "NO"}\n` +
    `WIF_AUD:${state.audience}\n` +
    `WIF_REPO:${state.repository}\n` +
    `WIF_JOB:${state.jobWorkflowRef}\n` +
    "OIDC_REQUEST_ENV_VARS_PRESENT:NO";
  sse(
    res,
    [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_comment_tool",
            type: "message",
            role: "assistant",
            model: "claude-mock",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_comment_sha",
            name: "mcp__github_comment__update_claude_comment",
            input: {},
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ body }),
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ],
    requestId,
  );
}

function extractReadToolValue(parsed) {
  const blocks = parsed.messages?.at(-1)?.content;
  if (!Array.isArray(blocks)) {
    return "";
  }

  for (const block of blocks) {
    if (block?.type !== "tool_result") {
      continue;
    }

    const content =
      typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content
              .map((item) =>
                typeof item?.text === "string" ? item.text : String(item ?? ""),
              )
              .join("\n")
          : "";

    for (const line of content.split("\n")) {
      const match = line.match(/^\d+\s+(.+)$/);
      if (match) {
        return match[1];
      }
    }
  }
  return "";
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    const requestId = `req_${state.requests.length + 1}`;
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }

    state.requests.push({
      url: req.url,
      headers: req.headers,
      body: sanitizeRequestsBody(parsed ?? body),
    });
    saveState();

    if (req.url.startsWith("/v1/oauth/token")) {
      const assertion = parsed?.assertion || "";
      if (typeof assertion === "string" && assertion) {
        state.exchangeAssertionSha256 = sha256(assertion);
        try {
          const { ok, parsed: jwt } = await verifyJwtWithGitHub(assertion);
          const claims = canonicalClaims(jwt.payload);
          state.signatureVerified = ok;
          state.exchangeClaimsSha256 = claimsSha256(jwt.payload);
          state.issuer = claims.iss;
          state.audience = claims.aud;
          state.repository = claims.repository;
          state.jobWorkflowRef = claims.job_workflow_ref;
          state.runId = String(claims.run_id || "");
        } catch (error) {
          state.signatureVerified = false;
          state.issuer = `verify-error:${error instanceof Error ? error.message : String(error)}`;
        }
        saveState();
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "request-id": requestId,
      });
      res.end(
        JSON.stringify({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      return;
    }

    if (!req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const toolNames = Array.isArray(parsed?.tools)
      ? parsed.tools.map((tool) => tool.name)
      : [];
    const lastMessage = parsed?.messages?.at(-1);
    const lastContentType = lastMessage?.content?.[0]?.type;

    if (!state.sentReadToolUse && toolNames.includes("Read")) {
      state.sentReadToolUse = true;
      saveState();
      readToolResponse(res, requestId);
      return;
    }

    if (
      state.sentReadToolUse &&
      !state.sentCommentToolUse &&
      lastContentType === "tool_result"
    ) {
      const tokenValue = extractReadToolValue(parsed);
      if (tokenValue) {
        state.readToolResultSha256 = sha256(tokenValue);
        try {
          const jwt = parseJwt(tokenValue);
          state.readClaimsSha256 = claimsSha256(jwt.payload);
        } catch {
          state.readClaimsSha256 = "";
        }
        state.claimsMatch =
          Boolean(state.exchangeClaimsSha256) &&
          state.exchangeClaimsSha256 === state.readClaimsSha256;
        state.sentCommentToolUse = true;
        saveState();
        commentToolResponse(res, requestId, state.readToolResultSha256);
        return;
      }
    }

    finalResponse(res, requestId);
  });
});

server.listen(port, "127.0.0.1", () => {
  saveState();
});
