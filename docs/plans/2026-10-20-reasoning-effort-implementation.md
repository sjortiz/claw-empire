# Reasoning effort for Claude and API agents

## What changed and why

Claude now has a localized global effort control in Settings → CLI and a per-agent override in AgentDetail. The supported levels are `low`, `medium`, `high`, `xhigh`, and `max`. Resolution is valid agent override → valid global setting → no flag. Changing the Claude model keeps its effort setting. Task execution, direct spawning, delegated/cross-department tasks, and one-shot/meeting runs use the same resolver and pass `--effort` only when configured.

API agents can set effort in AgentDetail once a provider/model is assigned. A shared capability helper drives both UI availability and request construction. OpenAI, Ollama, OpenRouter, Together, Groq, Cerebras, and custom OpenAI-compatible endpoints receive `reasoning_effort` with `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Explicit `none` means thinking off; empty leaves the request unchanged. Anthropic and Google requests keep their existing bodies. Their effort controls are disabled with an explanation, and their logs explain that a saved effort was not sent. Compatible endpoints also display a model-support caution.

The implementation reuses nullable `agents.cli_reasoning_level`; it needs no new column, table rebuild, or data rewrite. Existing startup migration already adds that nullable column for older databases. An in-memory regression test verifies upgrading a database without the column and preserving an override over repeated startup. CRUD updates and provider/model changes no longer silently clear saved effort. Unsupported or future values stay visible as custom values; Claude/API runtime validation prevents emitting unsupported levels.

Run headers report the effort actually applied. API headers identify agent-sourced effort, annotate thinking off, and explain unsupported/invalid saved values. CLI headers append the resolved level; their existing launcher interface carries the resolved value rather than its source. Unset effort preserves existing request bodies, CLI arguments, and log headers. One-shot CLI headers are written only to the log, so meeting replies are not polluted.

All new user-facing controls and explanations follow the existing `t` pattern for Korean, English, Japanese, and Chinese.

## Design reference and alternatives

Saved overrides are kept when an agent's provider or model changes, rather than being reset on switch.

- A new API effort column was unnecessary: the existing nullable agent override provides the same persistence and avoids migration risk.
- API provider defaults remain optional and are deferred. The current API override has one explicit source; empty means the model decides.
- Native Anthropic thinking budgets/output effort and Gemini thinking configuration are deferred rather than guessed. Their requests remain unchanged.
- A separate thinking toggle could conflict with an effort selection. One dropdown keeps explicit `none` distinct from inheritance.
- Claude sub-agent model preferences retain their existing prompt hint. This round adds no separate sub-agent effort control; independently launched delegated agents use their own override/global resolution.

## Testing

Coverage includes all Claude flag levels and unset or invalid values, override precedence, normal and delegated launches, meeting runs, effective log headers, API bodies for every provider type, API thinking off, schema upgrade and restart safety, CRUD preservation, and the localized Settings and AgentDetail controls. CLI processes and provider fetches are mocked, and database tests use isolated in-memory databases. Whether a given model accepts an OpenAI-compatible effort value is up to the endpoint; the UI says so beside the control.
