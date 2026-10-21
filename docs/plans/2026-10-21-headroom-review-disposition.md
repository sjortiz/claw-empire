# Headroom review disposition — 2026-10-21

Full feature acceptance remains open. The refreshed branch contains substantial implementation, but the original Ollama routing goal and active-run outage guarantee are not delivered. The settings UI also overstates effective API routing. Documentation of these limits is useful evidence; it does not itself waive the CEO requirements.

This is a Planning review of baseline `b171593`, incorporating Development `c8dbe31` and Design `5581d9f`. It supersedes the initial specification's statement that implementation is absent. Planning inspected source and test definitions without running production code, tests, or model traffic. Runtime remediation belongs to Development; execution evidence belongs to QA.

## Requirement disposition

| Requirement / review item | Delivered evidence | Disposition |
| --- | --- | --- |
| Explicit global setting, URL and provider choices | `src/lib/headroom.ts`; settings GET/PUT normalization and validation in `settings-stats.ts` | Present in source. Default off; missing fields receive defaults; invalid input rejected before other settings writes. |
| Claude task and one-shot routing | Shared `prepareHeadroomCli` consumed by `cli-runtime.ts` and `one-shot-runner.ts` | Present for the Anthropic backend. Alternate backend selectors remain outside this claim. |
| Disabled/provider-off behavior | Child environments strip inherited Anthropic/OpenAI base URLs and Headroom custom headers; server environment is copied | Requested inherited-env behavior is present. Custom CLI configuration can still independently route through a proxy; see H4. |
| Codex invocation-local support | Built-in direct override supplied through argv; proxy opt-in disabled | Safe conservative behavior, but routing remains unverified. The CEO's exception requires evidence about feasibility without global config changes, not merely a disabled switch. See H3. |
| API-provider model traffic | Shared route hook and original direct request retained | Official OpenAI chat completions and Anthropic messages only. Ollama/custom endpoints remain direct with `upstream_unverified`; see H2. |
| Proxy down before launch | Bounded current health check, stable warnings, direct route; API retry on refused connection | Present in source. No completed health result reused across later launches. |
| Stopped proxy must not fail agent runs | No CLI replay; no retry for ambiguous API failures or partial streams | Active-run guarantee remains unmet; see H1. Avoiding unsafe replay is correct but does not complete this requirement. |
| Clearly labeled multilingual controls | `HeadroomSettingsSection.tsx`, `headroom-copy.ts`, shared URL normalization, accessible disabled switches | Present in source for en/ko/ja/zh; visual and language-quality approval remains with Design. |
| Effective next-run status | Status returns broad capabilities; UI calculates route from saved switches and health | Design contract not met for destination-specific API routing; see H5. |
| Health and optional savings | Authenticated status endpoint returns normalized fields and proxy-wide numeric compression savings | Present in source. Zero preserved; stats failure does not change health; no task-specific savings claim. |
| Credential protection | Health/stats carry no provider auth; route diagnostics use stable reasons; raw upstream error bodies suppressed | Source reviewed. Tests use fake credentials; no real credential or request-history inspection performed. |
| Setup and provider docs | `docs/headroom.md`, README provider subsection, OpenAPI contract | Present and candid about unavailable routes and preflight-only fallback. |

## Required remediation and ownership

### H1 — High: active-run outage guarantee is unresolved

Development confirms that a proxy lost after readiness can interrupt a CLI session or stream. The source deliberately does not replay those requests. Do not add blind retries: prior tool calls and upstream processing can make replay destructive or duplicate work.

Development must propose the smallest viable transport/relay approach and state its exact recovery boundary, including whether state can be preserved after the proxy accepted a request. QA must exercise a disposable proxy disappearing between preflight and first connection, after request acceptance, and after partial output. Verify task lifecycle, cancellation, tools and duplicate-side-effect behavior. Keep the real 8787 proxy unchanged. If the original guarantee is not feasible within this integration, obtain an explicit CEO scope decision; leads cannot silently convert it to a preflight-only requirement.

### H2 — High: the requested Ollama route remains direct

`prepareHeadroomRoute` permits only two exact official endpoint URLs. Ollama at `http://localhost:11434/v1` therefore never uses Headroom. This prevents accidental redirection to a default public upstream, but the primary local-provider use case remains unfulfilled.

Development must establish a trustworthy exact-upstream acceptance mechanism before enabling custom/private routing. Preserve destination origin, path, model, credentials and abort behavior; never trust a silently ignored header or infer proxy policy from the application's environment. QA must prove the request reaches an isolated synthetic upstream with no request to a default public service, and prove rejected/unverified upstreams remain direct. If this requires an upstream Headroom capability change, record that dependency and retain direct fallback until it exists. Do not change the running proxy's configuration to manufacture acceptance evidence.

### H3 — High: Codex exception needs a compatibility conclusion

Leaving Codex opt-in unavailable protects unsupported auth/transport combinations. Existing argv assertions establish command construction, not successful proxy routing. They do not prove routing is impossible without modifying the user's configuration.

Development/QA must distinguish invocation-local override support from end-to-end API-key and ChatGPT-auth compatibility, including supported Responses transports and custom provider identity. Use isolated synthetic CLI configuration; never edit the user's global files. Record each tested and unavailable combination. Enable only proven combinations, or explain the specific blocker supporting the CEO's requested exception. Keep unavailable modes off with localized reasons.

### H4 — High: direct/off behavior has a custom-configuration exception

`prepareHeadroomCli` strips inherited routing variables but deliberately retains selected custom CLI provider configuration. `docs/headroom.md` and the UI acknowledge that such configuration may independently point at a proxy. Thus a broad claim that the app's switch guarantees direct traffic would be inaccurate.

Development must demonstrate invocation-local precedence for supported configurations using temporary fixtures, preserve the intended custom upstream/auth identity, and identify configurations whose direct destination cannot safely be determined. Never replace a legitimate custom upstream with an unrelated official endpoint. Provide an explicit unsupported/unknown route indication for unresolved cases and seek a scope decision if strict direct control cannot be delivered. Test inherited exports separately from custom CLI configuration; do not treat one as proof of the other.

### H5 — High: API next-run status can contradict actual routing

`getHeadroomStatus` reports `capabilities.api = true` without consulting a provider destination. `HeadroomSettingsSection.nextRoute` combines that capability, the saved API switch, and health to show **Next run: Headroom**. At the same time, an Ollama/custom request returns `upstream_unverified` and runs directly. The coverage paragraph describes the exclusion, but the next-run assertion still contradicts it. `HeadroomSettingsSection.test.tsx` currently expects two Headroom next-run labels for a generic healthy status, so that test does not guard against this mismatch.

Development and Design must make the server the authority for route policy. Expose a sanitized effective route/reason for each supported CLI family and, where showing an API-provider route, evaluate its exact destination. A group without destination context must show localized conditional coverage rather than a concrete next-run promise. Avoid exposing stored credentials or raw provider URLs through status. Include a mixed official-API/Ollama fixture, provider-off and health-down cases, and prove the UI matches the same policy that constructs requests. Update the status type, OpenAPI, all four locales and UI assertions together. This implements Design spec section 4 and acceptance item 7.

The current reason union is `disabled`, `provider_disabled`, `unsupported_provider`, `codex_unverified`, `upstream_unverified`, `health_timeout`, `connection_refused`, `http_error`, `invalid_response`, `not_ready`, and `invalid_settings`. Compared with Design note 157, it adds `disabled`, `codex_unverified`, and `invalid_settings`. The UI maps six health/settings reasons and handles Codex separately; it does not consume destination-specific effective route/reason data. Unknown effective reasons must use safe generic localized text when H5 is implemented.

## Verification record and limits

Development inbox note 186 reports the following for `c8dbe31`. These are owner-reported results, not fresh Planning execution or independent QA certification:

| Check | Reported result |
| --- | --- |
| `pnpm run format:check` | Exit 0 |
| `pnpm run lint` | Exit 0; 0 errors, 40 existing warnings |
| `pnpm run build` | Exit 0; bundle-size warning |
| `pnpm run test:web` | Exit 0; 197 passed |
| `pnpm run test:api` | Exit 0; 551 passed after fixing a new-test cleanup race |
| `pnpm run openapi:check` | Exit 0; 114 operations |

Source inspection found policy on/off/down tests, task/meeting process assertions, cancellation coverage, settings persistence/invalid-write coverage, official API routing and refusal fallback, no replay after ambiguous/partial failures, and UI toggle/validation/polling tests. This establishes that test cases exist; it does not replace their execution. After runtime remediation, QA must rerun all five CEO commands and the OpenAPI contract check and attach results for the exact candidate revision.

Both the initial Planning investigation and Development report read-only HTTP 200 health/stats observations from the real proxy, version 0.37.0, with a numeric compression counter. No model request through that proxy, correct-upstream response, Codex auth/transport success, real Ollama routing, deployment-prefix behavior, controlled real outage, or attributable token reduction is proven. Shared counters cannot establish Claw-Empire savings. Do not claim current proxy health from an earlier observation.

## Review decision

The explicit settings, shared policy, multilingual controls and documentation revisions are present. Conditional approvals remain conditional: H1–H5 require implementation/evidence or an explicit CEO scope decision. Planning does not certify the overall feature complete and does not authorize publication.

This continuation changes planning documentation only. No tests, model calls, live checkout/env/database access, global CLI configuration edits, proxy restarts, merges, pushes, PRs or GitHub comments are part of this review. Task-local coordination uses only the supplied agent-message capability.

Inbox notes 157, 174, 181 and 186 were read and acknowledged through 186 (HTTP 200). Handoff attempts to the completed Development and Design tasks returned HTTP 409 `recipient_unavailable`; no delivery is claimed and no tasks were reopened. The owner/action/evidence requirements above remain the review handoff for the next remediation assignment. Documentation whitespace checks passed; no runtime checks were executed in this Planning continuation.
