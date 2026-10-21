# First-class Headroom support: implementation specification

Status: Planning handoff, 2026-10-21. This document specifies proposed behavior; the feature is not implemented in this branch. Task: `96ad3e9f-b8a0-440b-a6e9-877389564c9e`.

## Outcome and boundaries

Make persisted Claw-Empire settings decide whether Claude Code, Codex, and API-provider agent model calls use Headroom. A proxy unavailable before a run must produce a direct run with a sanitized warning. Preserve the original provider, credentials, model, reasoning effort, streaming protocol, cancellation, and task lifecycle.

Development owns production changes; Design owns settings interaction review; QA owns test execution and real routing evidence. This Planning change supplies the specification and acceptance gates only.

All implementation, fixtures, logs, and temporary databases must stay in this checkout. Never access the live checkout at `~/projects/oss/claw-empire`, its `.env`, or its database. Do not stop/restart the existing proxy on 8787. Never modify global CLI configuration, run `headroom wrap`/`install`, push, publish a PR, or post GitHub comments.

## Confirmed baseline

| Surface | Evidence in this checkout | Consequence |
| --- | --- | --- |
| Task CLI launch | `server/modules/workflow/agents/cli-runtime.ts:245` copies `process.env`; only Claude nesting markers are removed | Server base-URL variables leak into children today |
| One-shot/meeting CLI | `server/modules/workflow/core/one-shot-runner.ts:211` repeats this env construction | Must share the same policy as task launches |
| Codex arguments | `server/modules/workflow/core/cli-tools.ts:49` already builds `-c` arguments for reasoning effort | Invocation-local routing can extend the existing argv builder |
| API agent execution | `server/modules/workflow/agents/providers/api-provider-tools.ts:228` builds the provider request and fetches its URL | One shared hook can cover task and one-shot API agents |
| Settings persistence | `server/modules/routes/ops/settings-stats.ts` reads JSON values and upserts keys at GET/PUT `/api/settings` | Reuse the settings table; validate Headroom before any write |
| Frontend settings | `src/types/index.ts:369`, `src/components/SettingsPanel.tsx`, `src/components/settings/GeneralSettingsTab.tsx` | Add a typed nested setting and a focused child component |
| Existing coverage | CLI-runtime, one-shot-effort, API-provider-tools, settings-stats-seed-init, and GeneralSettingsTab tests | Extend relevant suites and add routing-policy coverage |

This confirms the code-level inheritance problem. The live server's environment and database were deliberately not inspected, so its accidental current routing is user-supplied context, not independently verified here.

Read-only local observations:

- Installed `headroom --version`: 0.37.0. Installed `codex --version`: 0.163.0.
- `headroom proxy --help` documents Claude's `ANTHROPIC_BASE_URL`, compatible clients' `OPENAI_BASE_URL`, and custom upstream options.
- `codex exec --help` documents single-invocation `-c key=value` overrides with TOML values and dotted paths.
- GET `http://127.0.0.1:8787/health`: HTTP 200, `status: healthy`, `ready: true`, `version: 0.37.0`.
- GET `/stats`: HTTP 200. Fields include `tokens.proxy_compression_saved`, `tokens.all_layers_saved`, and `tokens.saved`. Request/history fields also exist and must not be relayed to the app.
- No model request, proxy mutation, outage simulation, or `headroom doctor` command was performed. The doctor's statement about global Codex config remains user-supplied context.

## Persisted contract and defaults

Use one JSON setting named `headroom` in the existing settings table:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Global opt-in |
| `proxyUrl` | string | `http://127.0.0.1:8787` | Proxy root URL, without `/v1` |
| `providers.claude` | boolean | `true` | Allow Claude Code routing when globally enabled |
| `providers.codex` | boolean | `false` | Opt-in only after supported auth/transport validation |
| `providers.api` | boolean | `true` | Allow supported API-provider model calls |

The API switch covers API-provider records as a group, including Anthropic and OpenAI-compatible types. This MVP does not add a per-record database column. Unsupported formats remain direct with an explanation. If individual API-record switches are required by product review, settle that before implementation rather than inventing inconsistent precedence.

Normalize missing settings identically on server and client. Missing nested fields use defaults; corrupted stored data must fall back safely to direct routing. Reject invalid new writes with HTTP 400 before writing any other settings in that request. Do not coerce strings such as `"false"` to booleans. A supplied `headroom` object replaces that object after normalization; omission leaves it unchanged.

Validate the URL as HTTP(S), with a hostname and valid port, without userinfo, query, or fragment. Trim whitespace/trailing slashes and normalize a terminal `/v1` to the root to avoid `/v1/v1`. Preserve a legitimate deployment prefix consistently for health, stats, and model endpoints. Never accept embedded credentials. Invalidate health state when the saved URL changes. Disabled children retain their saved choices.

Global off or provider off wins over inherited `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`. Settings changes apply to subsequent launches; do not interrupt active runs.

## Shared runtime policy

Create a small shared server module for settings normalization, bounded health checks, effective route selection, CLI env/argv shaping, API request transformation, and sanitized reason codes. Keep network policy out of React and avoid independent copies in the two runners.

Before a model run, read a settings snapshot and select the provider family. If disabled, sanitize inherited routing variables and choose direct without probing. Otherwise, GET `<proxyRoot>/health` with an abort deadline of 1 second. Require a valid Headroom health response indicating readiness; HTTP 200 alone or an unrelated HTML page is insufficient. Timeout, refusal, non-2xx, malformed JSON, explicit unhealthy, or not-ready means direct fallback. Stats availability never decides routing.

Deduplicate concurrent probes for the same URL, but every new run must await a current preflight rather than trust stale UI state. Bound response reads and reject redirects so a health request cannot unexpectedly forward to a different origin. Probe with no provider credentials, cookies, or inherited auth headers.

Return an effective route and a stable reason such as `disabled`, `provider_disabled`, `proxy_unavailable`, or `unsupported_provider`; callers should not reconstruct routing decisions. Log one warning per affected run, for example `Headroom unavailable; continuing directly (health_timeout).` Use existing task logs and websocket delivery. One-shot calls with a task association should log there; otherwise use their existing operation log. Never mix diagnostics into model reply text.

Do not log full env, raw errors/response bodies, model request URLs, authorization, proxy userinfo, or query strings. Google API credentials currently appear in URL queries. The status endpoint must also expose sanitized reason codes instead of raw fetch exceptions.

### Claude Code

Copy the parent env without mutating `process.env`; retain the existing nesting-marker and PATH handling. Remove both inherited base-URL variables before routing. Healthy opt-in sets `ANTHROPIC_BASE_URL=<proxyRoot>`; off/down leaves it absent so Claude uses its direct provider. Preserve existing authentication variables. Use this same builder for task, one-shot, delegated, and cross-department launches.

Do not set `OPENAI_BASE_URL` in Claude children. Additional client-specific env that can select an upstream must be inventoried before claiming the app is the sole routing authority. Direct non-default backends are not reconstructed from stripped shell variables; document that intentional migration change.

### Codex: no global config writes

Official [advanced configuration](https://developers.openai.com/codex/config-advanced/) documents single-run `-c` overrides, custom providers, and `openai_base_url`. The [configuration reference](https://developers.openai.com/codex/config-reference/) describes provider base URLs and auth. Project-local `.codex/config.toml` cannot set credential-redirecting provider keys; it is not a substitute for invocation-local argv.

For installed Codex 0.163.0, first validate the least invasive candidate: `-c 'openai_base_url="http://127.0.0.1:8787/v1"'` for the built-in OpenAI provider. Do not override a reserved `model_providers.openai` table. If an isolated named provider is needed, define `model_provider="claw_headroom"` and its provider fields entirely through `-c` arguments; preserve `wire_api="responses"` and the correct auth mode. Build an argv array, never a shell-interpolated command or an argument containing a literal secret.

Headroom's installed `providers/codex/install.py` distinguishes ChatGPT OAuth from API-key users when setting `requires_openai_auth`; blindly enabling it can break API-key users. Its runtime recognizes ChatGPT account headers/token claims. This establishes an auth compatibility risk, not proof that either candidate works end to end. Prefer preserving the built-in authentication path; do not read or print credential-file contents merely to guess a mode.

Required Codex gates:

1. Demonstrate API-key and ChatGPT-auth behavior separately where available, including Responses streaming. Inspect whether HTTP versus WebSocket needs a supported per-run override; do not claim both based on health.
2. Apply argv policy to task and meeting execution and preserve existing model/effort flags.
3. Remove inherited base-URL variables for off/down. If existing global CLI config points at Headroom, a direct invocation-local override must beat it without editing that file; test this with an isolated synthetic configuration, not the user's config.
4. Preserve a supported explicit non-Headroom custom upstream. If its direct route/auth cannot be determined safely, expose the limitation and keep Codex opt-in disabled; do not silently redirect a custom provider to OpenAI.
5. If routing requires a global config mutation or remains unsupported for the installed CLI/auth combination, keep the switch off with a localized reason and document exactly what was not verified.

### API-provider agents

Transform requests inside `executeApiProviderAgent`, which is used by task and one-shot API runs. Construct the direct request first and retain it for fallback. Supported initial protocols are Anthropic messages and OpenAI-compatible chat completions. Native Google format, Copilot/Antigravity HTTP agents, and other CLI families are outside the initial routing claim and remain direct.

Proxy selection must preserve the provider's original upstream origin and path, payload, model, reasoning effort, auth, provider-specific headers, stream decoding, and abort signal. Do not update `api_providers.base_url` to the proxy and lose the direct destination.

Installed Headroom 0.37 source confirms `x-headroom-base-url` and `x-headroom-original-path` in `proxy/handlers/openai.py`. Its Anthropic handler also consumes the upstream-base override. These are candidates to preserve Ollama, OpenRouter `/api/v1`, and custom endpoint prefixes. Verify each protocol's path composition with a synthetic upstream before release; do not assume the same slash/version behavior in both handlers. Strip routing headers on direct fallback.

**Ollama release gate:** installed `proxy/upstream_guard.py` rejects loopback/private upstreams unless the operator sets `HEADROOM_ALLOWED_BASE_URLS`. The OpenAI handler may silently ignore an unsafe override and use its configured default upstream. Therefore adding the header plus checking `/health` is insufficient and can send local-model traffic to the wrong service. Before routing a private/custom upstream, establish that the proxy accepts that exact upstream, using an explicit capability/configuration handshake or equivalent verified contract. If not established, call the original provider directly and report `upstream_unverified`; never infer acceptance from the Claw-Empire server's own environment. An operator-declared setup alone is not evidence of the running proxy's policy. Do not change/restart the existing proxy to establish it.

Model discovery and provider connection checks remain direct control-plane operations in this MVP. Document this distinction so the API switch is not advertised as routing all HTTP traffic.

### Async launch and outage behavior

`spawnCliAgent` currently returns `ChildProcess` synchronously. Do not add a floating asynchronous health check after spawn. Choose one consistent async preflight design and update the runtime context types and all callsites:

- `server/modules/routes/core/tasks/execution-run.ts:627`
- `server/modules/routes/core/agents/spawn.ts:289`
- `server/modules/workflow/orchestration/execution-start-task.ts:325`
- `server/modules/routes/collab/subtask-delegation-batch.ts:660`
- `server/modules/routes/collab/coordination/cross-dept-cooperation.ts:674`

Recheck task cancellation/run ownership after awaiting health; preserve process registration, stdio, worktree, and timeout behavior.

**Outage release gate:** health-before-launch guarantees fallback only for a proxy already unavailable at preflight. It does not guarantee success if Headroom stops immediately afterward or midway through a CLI session. Development must demonstrate safe handling of connection failure before the first model response, without replaying tools or duplicating task side effects. API code may retry the original request once only when failure is known to precede an upstream response; do not replay arbitrary 4xx, 5xx, partial streams, or completed tool turns. If the stronger promise that a stopped proxy never fails an active run requires a local transport/relay, escalate that architectural scope explicitly. Do not label a preflight-only implementation as satisfying continuous outage tolerance.

## Settings/status UI contract

Add a Headroom section to General settings with a dedicated child component, following the existing theme and save flow. No new UI dependency or unrelated redesign is required.

- Global toggle, labeled proxy URL input, and Claude Code/Codex/API providers switches.
- Accessible labels, keyboard interaction, inline URL validation, and help text. Children are disabled when global off while retaining their values; URL stays editable.
- Explain that enabling routing applies on the next run and that unavailable/unsupported routes run directly.
- Live states: disabled, checking, healthy, unavailable/direct fallback, and unsupported. Show last check time and refresh action. Do not describe the proxy as serving a run solely because it is healthy.
- Probe through an authenticated Claw-Empire endpoint, proposed GET `/api/headroom/status`; never call a loopback proxy from the browser. Poll every 15 seconds only while the section is mounted/visible; abort and clean up on unmount and URL changes. Status reflects the saved URL, with unsaved changes clearly indicated.
- Expose only `checkedAt`, normalized health state/version, sanitized reason, supported route capabilities, and optional numeric savings. Do not relay the raw `/health` config or `/stats` request/history data.
- Prefer `tokens.proxy_compression_saved` for a label specifically describing proxy compression. Broader `tokens.saved`/`tokens.all_layers_saved` can include tool-schema savings; label that scope separately if used. Validate finite, non-negative numbers, preserve zero, and show unavailable when missing. Do not sum overlapping fields or claim these totals are Claw-Empire/task savings: the proxy serves other clients too.
- Stats errors must leave health and toggles usable. Initial/loading/error states must be visible and localized. Keep persisted configuration separate from transient health/statistics.

All new controls, status text, fallback help, validation, capability reasons, and number formatting must support en/ko/ja/zh using existing `t({ en, ko, ja, zh })` conventions. Representative copy for review:

| Meaning | en | ko | ja | zh |
| --- | --- | --- | --- | --- |
| Global control | Enable Headroom | Headroom 사용 | Headroom を有効にする | 启用 Headroom |
| URL | Proxy URL | 프록시 URL | プロキシ URL | 代理 URL |
| Ready | Healthy | 정상 | 正常 | 正常 |
| Fallback | Proxy unavailable; using direct connections | 프록시를 사용할 수 없어 직접 연결합니다 | プロキシを利用できないため直接接続します | 代理不可用，使用直连 |
| Savings | Proxy compression tokens saved | 프록시 압축으로 절약한 토큰 | プロキシ圧縮による節約トークン数 | 代理压缩节省的令牌数 |

## Delivery work packages

| Owner | Deliverable | Dependencies / evidence |
| --- | --- | --- |
| Development A | Shared settings/policy module, validation, status endpoint, typed client contract | Resolve Codex auth and upstream-acceptance gates first; no schema rewrite |
| Development B | CLI task/meeting env and argv, async caller integration, API request routing | Consume A's policy; preserve direct destination and lifecycle |
| Design + Development | Settings child component, switches, live status/savings, localization | Use stable status/settings contract; no fabricated savings |
| Documentation | `docs/headroom.md` with setup, route matrix, fallback and limits; README provider subsection | Describe shipped capabilities only; note default off and env precedence |
| QA | Isolated routing/settings/UI tests and full requested verification | No live DB, production server, config mutation, or 8787 restart |

Suggested sequencing: settle high-risk compatibility gates; freeze settings/status contracts; implement shared policy and consumers; integrate UI/docs; run focused then required checks; inspect the focused diff for upstream publication by the CEO. These are proposed work packages, not tasks registered with the live orchestration server.

## Acceptance matrix and release evidence

| Scenario | Required evidence |
| --- | --- |
| Claude on/off/down | Task and meeting env assertions; inherited values cannot override saved settings; parent env unchanged; auth retained |
| Codex on/off/down | Task and meeting argv/env assertions, existing reasoning/model flags retained, supported auth/Responses transport verified or switch disabled with reason |
| API on/off/down | Anthropic and compatible request URL/path/header/body/stream/abort assertions; direct destination restored on fallback |
| Provider isolation | Global off and each provider off independently; unsupported families direct; per-request custom upstreams do not bleed between parallel agents |
| Ollama/custom upstream | Exact origin/path preserved and accepted by proxy policy; unverified private route runs directly instead of reaching default OpenAI upstream |
| Health failure | Refused connection, timeout, non-2xx, malformed/unhealthy/not-ready response; bounded delay, sanitized task warning, direct continuation |
| Health race | Proxy disappears after healthy preflight; demonstrate behavior before response and after partial output without replaying side effects; report limits |
| Persistence | In-memory DB GET/PUT round trip, missing/legacy defaults, partial settings updates, invalid payload rejected before unrelated writes |
| UI | Global/provider toggles, URL editing/validation, save/reload, off-state retained choices, poll cleanup, fallback status, zero/missing/malformed stats, four locales |
| Isolation/secrets | Fake credentials never in logs/status; no writes to parent env/global CLI config/live DB; direct fallback strips internal routing headers |
| Runtime integration | All five task-spawn callsites await policy, cancellation during preflight, no regression to one-shot or task process lifecycle |

Use mock fetch/process spawn and in-memory SQLite for automated coverage. Use an ephemeral fake proxy/upstream on an automatically assigned port for outage and policy scenarios; do not kill the real proxy. Avoid starting the full server with ambient `.env` or default DB paths; any integration server must use explicit checkout-local fixtures and isolated ports.

QA must run and report these commands, exit codes, failures, and relevant existing baseline issues:

1. `pnpm run format:check`
2. `pnpm run lint`
3. `pnpm run build`
4. `pnpm run test:web` (use `CI=1` to avoid watch mode)
5. `pnpm run test:api` (use `CI=1` to avoid watch mode)

`format:check` currently excludes Markdown, so a green result alone does not validate this document's layout. Update `docs/openapi.json` and run the existing contract check if adding a status endpoint; do not leave the documented API stale.

Real-proxy verification must distinguish: health/stats observed, invocation construction checked, model traffic actually received by Headroom, correct upstream response received, and measurable savings attributed to that traffic. Shared global counters alone cannot prove attribution. Report unavailable credentials/auth modes, unverified private-upstream allowance, and mid-run outage limits honestly. Do not expose request logs or unrelated client traffic while collecting evidence.

## Proposed operator guide content

The implementation's `docs/headroom.md` should cover:

1. Install Headroom separately, inspect `headroom proxy --help`, and start a proxy under the operator's control. Claw-Empire does not install/manage/restart it. For this task, reuse the running service unchanged.
2. Open Settings → General → Headroom, enter the server-reachable root URL (default `http://127.0.0.1:8787`), enable global/provider switches, save, and review live status. In containers, loopback refers to the server container.
3. Explain the route matrix above, default-off migration, server-env stripping, invocation-local Codex overrides, and supported auth/transport combinations. Explain excluded native Google/other provider traffic and direct discovery calls.
4. For private custom upstreams such as Ollama, document Headroom's `HEADROOM_ALLOWED_BASE_URLS` requirement and the implementation's verified-acceptance/direct-fallback behavior. Configuration changes belong to the proxy operator, outside this task.
5. Explain preflight fallback, sanitized warnings, any proven safe connection retry, and explicit limits during an active stream/session. Direct fallback still requires valid provider credentials and a reachable upstream.
6. Explain the scope of displayed savings and troubleshooting health/stats separately from model routing. Do not promise a token-reduction percentage.

## Planning review and outstanding gates

The baseline, installed CLI help, installed Headroom routing implementation, and live health/stats shape have been inspected. No production changes or tests have been performed. Required implementation gates remain Codex auth/transport compatibility, provable private-upstream acceptance, and the meaning/implementation of continuous outage tolerance. These gates must be resolved or explicitly reported before the overall feature is marked complete.
