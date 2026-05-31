#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const proofPath = path.join(runnerTemp, "cca-wif-env-proof.json");
const summaryPath = path.join(runnerTemp, "cca-wif-env-proof.txt");
const tokenPath = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE || "";

let token = "";
let tokenReadError = "";

try {
  token = fs.readFileSync(tokenPath, "utf8");
} catch (error) {
  tokenReadError = error instanceof Error ? error.message : String(error);
}

const proof = {
  env_has_identity_token_file: Boolean(tokenPath),
  identity_token_file: tokenPath,
  identity_token_read_ok: Boolean(token),
  identity_token_sha256: token
    ? crypto.createHash("sha256").update(token).digest("hex")
    : "",
  env_has_actions_id_token_request_url: Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  ),
  env_has_actions_id_token_request_token: Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  ),
  env_has_federation_rule_id: Boolean(process.env.ANTHROPIC_FEDERATION_RULE_ID),
  env_has_organization_id: Boolean(process.env.ANTHROPIC_ORGANIZATION_ID),
  token_read_error: tokenReadError,
};

fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
fs.writeFileSync(
  summaryPath,
  [
    `ENV_HAS_IDENTITY_TOKEN_FILE=${proof.env_has_identity_token_file}`,
    `IDENTITY_TOKEN_READ_OK=${proof.identity_token_read_ok}`,
    `IDENTITY_TOKEN_SHA256=${proof.identity_token_sha256}`,
    `ENV_HAS_ACTIONS_ID_TOKEN_REQUEST_URL=${proof.env_has_actions_id_token_request_url}`,
    `ENV_HAS_ACTIONS_ID_TOKEN_REQUEST_TOKEN=${proof.env_has_actions_id_token_request_token}`,
    `ENV_HAS_FEDERATION_RULE_ID=${proof.env_has_federation_rule_id}`,
    `ENV_HAS_ORGANIZATION_ID=${proof.env_has_organization_id}`,
    `TOKEN_READ_ERROR=${proof.token_read_error}`,
  ].join("\n") + "\n",
);

setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "fake-session",
      model: "fake-model",
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result: "fake-ok",
      session_id: "fake-session",
      total_cost_usd: 0,
    }) + "\n",
  );
  process.exit(0);
}, 50);
