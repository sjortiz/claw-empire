# Headroom proxy support

Headroom is an optional, separately managed context-optimization proxy. Claw-Empire does not install, start, restart, or change its configuration. Install it using the [Headroom project instructions](https://github.com/chopratejas/headroom), then inspect `headroom proxy --help` and `headroom doctor` for your version. The integration targets the readiness response and upstream headers in Headroom 0.37.

## Setup

1. Start your proxy under your own supervision. Its usual root is `http://127.0.0.1:8787`.
2. Open **Settings → General → Headroom proxy**, enter the server-reachable root URL, enable Headroom and the desired supported provider switches, then Save. In containers, loopback refers to the Claw-Empire server container.
3. Check the saved configuration's health and optional savings. Unsaved form changes do not change the displayed status. Controls are available in English, Korean, Japanese, and Chinese.

The global default is **off**. Claude and API-provider choices default on, subordinate to the global switch. Codex defaults off and cannot be enabled through the UI while its compatibility is unverified. Turning Headroom off retains provider choices. A supplied `headroom` setting replaces the normalized object; omitting it preserves the stored object. Missing fields receive defaults, corrupt stored data fails closed, and invalid new configuration is rejected before any other settings in that request are written.

Proxy URLs must be HTTP(S), with a host and valid port, without embedded credentials, query strings, or fragments. Whitespace, trailing slashes, and a terminal `/v1` are normalized. Deployment prefixes are retained for `/health`, `/stats`, and model endpoints. Do not include API keys in the URL.

## What is routed

| Agent traffic | Behavior when enabled and healthy |
| --- | --- |
| Claude Code using its Anthropic backend | Task runs, delegated/cross-department runs, and one-shot meeting calls use `ANTHROPIC_BASE_URL=<proxy root>`, with the official Anthropic upstream explicitly selected through a Headroom header |
| API providers using `https://api.openai.com/v1/chat/completions` | Agent task and meeting requests use the proxy, retaining payload, model, effort, auth, and streaming |
| API providers using `https://api.anthropic.com/v1/messages` | Agent task and meeting requests use the proxy, retaining payload, auth, and streaming |
| Codex | Opt-in unavailable: API-key/ChatGPT authentication and Responses HTTP/WebSocket transport have not been verified end to end |
| Ollama, OpenRouter, custom and other non-default API endpoints | Direct with `upstream_unverified`; no proxy upstream-acceptance handshake is available |
| Claude Bedrock, Vertex, or Foundry backend selectors | Existing selected backend retained; outside the Anthropic routing claim |
| Gemini, OpenCode, Kimi, Copilot, Antigravity, native Google API | Direct; outside this integration |
| API model discovery and connection tests | Direct control-plane calls |

The API switch applies to API-provider records as a group. It does not modify any record's `base_url`. Every proxied API request selects its original official upstream explicitly; custom/private destinations are never silently substituted with the proxy's default upstream.

Headroom 0.37 supports `X-Headroom-Base-Url` and `X-Headroom-Original-Path`, but its upstream guard can reject or silently ignore private destinations. An operator's `HEADROOM_ALLOWED_BASE_URLS` declaration is not proof of the running service's acceptance. Ollama/custom routing stays direct until exact upstream acceptance and path composition can be verified through a trustworthy proxy capability contract. Claw-Empire never changes or restarts the proxy to establish that contract.

## Environment and CLI configuration

Each CLI child receives a fresh environment. Both inherited `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` are removed, as are inherited `x-headroom-*` lines in `ANTHROPIC_CUSTOM_HEADERS`; other headers and authentication variables are retained. Healthy supported Claude opt-in then adds its explicit proxy root and official upstream header. The server's own environment is never changed. This intentionally replaces accidental routing through shell exports. Non-default Claude backends selected through dedicated backend flags remain selected.

Codex uses an invocation-local `-c 'openai_base_url="https://api.openai.com/v1"'` direct override for its built-in OpenAI provider, including when the saved global CLI base URL points at Headroom. Its selected custom `model_provider` identity and authentication configuration are preserved; a custom provider can still follow its own CLI configuration, including an independently configured proxy. Claw-Empire does not claim to override such custom configuration. No global `~/.codex/config.toml` or other user CLI config file is edited or read for this feature. [Codex configuration reference](https://developers.openai.com/codex/config-reference/) describes invocation configuration and provider keys.

## Health, fallback, and active-run limits

Every supported launch awaits a current `/health` preflight, bounded to one second. Concurrent checks for the same root share only the in-flight request; no completed health result is reused for a later run. Readiness requires Headroom's service identity, ready flag, healthy status, and version. Redirects, oversized or malformed responses, non-success status, refusal, and timeout select the direct route. No provider credentials are sent to health or stats. Canceling/reassigning a task during preflight prevents the old CLI launch from proceeding.

Unavailable-at-launch routing continues directly and writes a stable reason to the operation/task log and task output stream. Diagnostics do not become the meeting model's reply. Native provider credentials and a reachable upstream are still required for direct calls. Settings changes affect subsequent launches and do not interrupt active agents.

**Preflight does not guarantee continuous outage tolerance.** A proxy that stops after readiness, or during an active CLI session or partial stream, can interrupt that run. CLI sessions are never replayed automatically because tools may already have changed project files. API requests retry direct once only on `ECONNREFUSED`, proving the proxy connection was never established. Ambiguous network errors, HTTP errors, and partial streams are not replayed. A stronger guarantee requires a transport/relay architecture and separate review; it is not provided by this implementation.

`GET /api/headroom/status` uses the existing authenticated app API. It exposes only normalized readiness, version, check time, capability flags, a sanitized reason, and optional savings. It does not relay proxy configuration, request history, raw responses, credentials, or fetch errors. Savings use only a finite non-negative integer `tokens.proxy_compression_saved`; zero is valid, and missing/invalid stats show unavailable. These totals include **all traffic through the proxy**, not only Claw-Empire, and do not prove savings for an individual task. Stats failures do not change health or routing. The UI polls saved settings every 15 seconds while visible and aborts requests on URL changes or unmount.

## Verification and release gates

Automated regressions use in-memory settings/databases and mocked processes/transports. They cover explicit on/off/down routing for task and meeting launches, environment isolation, cancellation before spawn, official API destination/header/body preservation, safe connection-refusal fallback, no replay after ambiguous/partial failure, persisted-setting validation, and UI behavior/poll cleanup. They do not claim real paid model traffic or savings attribution.

Before enabling more routes, independently verify Codex API-key and ChatGPT authentication/Responses transports, custom/private upstream acceptance, deployment-prefix behavior against the installed proxy, and any stronger active-run outage requirement. A healthy proxy alone proves none of those. Do not collect unrelated request history or expose secrets while gathering evidence.
