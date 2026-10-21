# Headroom settings: UI specification

Design spec for the Headroom section in **Settings → General**. The routing policy, the `headroom` setting and the status endpoint are specified in `docs/plans/2026-10-21-headroom-support.md` (Planning, branch `climpire/b07b6c1a`). This document covers only what the user sees and does. Development builds it, and QA checks it against the acceptance list at the end.

Status: Design spec, 2026-10-21. Not implemented on this branch.

## Placement

A new `<section>` card, `HeadroomSettingsSection`, sits between the **Company** card and the Save row in `GeneralSettingsTab`. It uses the same card shell, heading style, input classes and `--th-*` theme variables as the Company card. It edits `form.headroom` through the existing `form`/`setForm`/`onSave` flow. There is no separate save button and no new UI dependency.

## Layout

```
┌ HEADROOM PROXY ─────────────────────────────────────────── [● Healthy · v0.37.0] ┐
│ Route agent model traffic through a local Headroom proxy to compress prompts     │
│ and save tokens. Claw-Empire does not install or start Headroom.                 │
│                                                                                  │
│ ┌ Enable Headroom ────────────────────────────────────────────────── [ ●── ] ┐   │
│ │ Off: every agent calls its provider directly, even if the server            │   │
│ │ environment sets ANTHROPIC_BASE_URL or OPENAI_BASE_URL.                     │   │
│ └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│ Proxy URL                                                                        │
│ [ http://127.0.0.1:8787                                        ]  Reset to default│
│ Root URL the Claw-Empire server can reach, without /v1.                          │
│                                                                                  │
│ ROUTE THESE AGENTS                                                               │
│ ┌ Claude Code ─────────────────────────────────────────────── [ ──● ] ┐          │
│ │ Task runs and meeting calls · via ANTHROPIC_BASE_URL                │          │
│ │ Next run: Headroom                                                  │          │
│ ├ Codex ───────────────────────────────────────────────────── [ ●── ] ┤          │
│ │ Task runs and meeting calls · per-run -c override;                  │          │
│ │ ~/.codex/config.toml is never edited                                │          │
│ │ Next run: direct · provider off                                     │          │
│ ├ API providers ─────────────────────────────────────────────── [ ──● ] ┤          │
│ │ Anthropic and OpenAI-compatible providers (e.g. Ollama) ·           │          │
│ │ original upstream kept                                              │          │
│ │ Next run: Headroom                                                  │          │
│ └─────────────────────────────────────────────────────────────────────┘          │
│ ⓘ Always direct: Gemini, OpenCode, Kimi, Copilot and Antigravity agents,          │
│   Google native API, model discovery and connection tests.                       │
│                                                                                  │
│ ┌ Status ────────────────────────────────────────────────────────────────────┐   │
│ │ ● Healthy · v0.37.0                          Checked 15:42:10 · [Check now] │   │
│ │ Proxy compression tokens saved: 1,284,301                                   │   │
│ │ Counts all traffic through this proxy, not only Claw-Empire.                │   │
│ └─────────────────────────────────────────────────────────────────────────────┘   │
│ Changes apply to the next agent run. Running agents are not interrupted. If the  │
│ proxy is unreachable, runs connect directly and the task log notes it.           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Below 640 px everything stacks into one column. The status pill in the heading moves under the title, and **Check now** wraps under the status line.

## Controls

### 1. Enable Headroom (master switch)

- A `ToggleSettingCard` labeled **Enable Headroom**. The help text below it always reads in its _Off_ meaning, so the user knows what turning it off does.
- Default `false`. Turning it on does not save. It changes the form, and Save persists it like every other General setting.
- Visual weight: the full-width card at the top of the section. The provider switches are visibly subordinate (indented group, smaller label).

### 2. Proxy URL

- A labeled `<input type="url" id="headroom-proxy-url">` with `aria-describedby` pointing at the help text and, when present, the error.
- It stays editable while Headroom is off, so the user can set it up before turning routing on.
- **Reset to default** is a text button that restores `http://127.0.0.1:8787`. It is shown only when the value differs from the default.

Validation runs on blur and on Save, never on each keystroke. The client rules mirror the server's, so a value the UI accepts never gets an HTTP 400:

| Input                                                         | Result                          | Message                                                                  |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| Empty or only whitespace                                      | Error                           | Enter a proxy URL.                                                       |
| Not parseable, or scheme other than `http:`/`https:`          | Error                           | Use an http:// or https:// URL.                                          |
| Contains `user:pass@`                                         | Error                           | Do not put a username or password in the URL.                            |
| Contains `?query` or `#fragment`                              | Error                           | Remove the query string or # fragment.                                   |
| Leading or trailing whitespace, trailing `/`, `/v1` or `/v1/` | Accepted and normalized on blur | Saved as `http://127.0.0.1:8787` (the /v1 suffix is added per provider). |

Error presentation: red border (`border-red-500`), `aria-invalid="true"`, and the message in red under the field with `role="alert"`. The normalization note uses secondary text, not red. While the field has an error, the **Save** button is disabled and gets a `title` that names the field. The server rejects the whole settings payload when the URL is invalid, so the user should not be able to send one. The rule applies even when Headroom is off, because the server validates the stored value either way.

The URL is never shown with credentials, because they are rejected. Status text shows only `host:port`, never the path or query.

### 3. Provider switches: "Route these agents"

There are three `ToggleSettingCard` rows in one group with the heading **Route these agents**. Each row has a coverage line and a **Next run** line.

| Switch        | Default | Coverage line (what is routed and how)                                                  |
| ------------- | ------- | --------------------------------------------------------------------------------------- |
| Claude Code   | on      | Task runs and meeting calls · via ANTHROPIC_BASE_URL                                    |
| Codex         | off     | Task runs and meeting calls · per-run -c override; ~/.codex/config.toml is never edited |
| API providers | on      | Anthropic and OpenAI-compatible providers (e.g. Ollama) · original upstream kept        |

Below the group there is always an info line listing the traffic Headroom never handles: **Always direct: Gemini, OpenCode, Kimi, Copilot and Antigravity agents, Google native API, model discovery and connection tests.** Users should not have to guess what a switch covers.

**When the master switch is off**, the three switches are rendered `disabled` (`opacity-50`, `cursor-not-allowed`, `aria-disabled`). They keep their saved positions, so turning Headroom back on restores the user's choices. A single hint replaces the Next run lines: **Turn on Headroom to change. Your choices are kept.** `ToggleSettingCard` needs an optional `disabled` prop for this. That is the only change to the shared card.

**Codex not verified.** If the status endpoint reports that Codex routing is unsupported for the current auth or transport (`capabilities.codex = false`), the Codex switch is disabled even with the master switch on. Its Next run line then reads **Not available yet: Codex routing has not been verified for your sign-in method. Codex runs directly.** The saved value is kept, but the server treats Codex as direct.

### 4. Next run line (configured vs effective)

Each provider row shows the route the **next** run will take. The value comes from the status endpoint's per-provider effective route, not from the switch alone, so the user can see where the saved configuration and actual behavior differ:

| Saved config                                                                            | Proxy health | Next run line                         |
| --------------------------------------------------------------------------------------- | ------------ | ------------------------------------- |
| Headroom off                                                                            | any          | (hidden; group hint shown instead)    |
| On, provider off                                                                        | any          | Next run: direct · provider off       |
| On, provider on                                                                         | healthy      | Next run: Headroom                    |
| On, provider on                                                                         | unavailable  | Next run: direct · proxy unavailable  |
| On, provider on                                                                         | checking     | Next run: checked when the run starts |
| On, provider on, unsupported (e.g. Codex unverified, private API upstream not accepted) | any          | Next run: direct · not verified       |

Wording rule: the UI never says traffic **is** going through Headroom. It says where the next run is set to go, because every run re-checks health on its own before launching.

If the form has unsaved changes, the status card shows **Unsaved changes · status shows the saved URL** above the status line. The Next run lines describe the **saved** settings until the user saves.

## Status card

Status is polled from `GET /api/headroom/status` (authenticated Claw-Empire endpoint). The browser never calls the proxy directly. Polling runs every 15 s only while the section is mounted and the page is visible (`document.visibilityState`). It stops on unmount, restarts after Save, and aborts in-flight requests when the saved URL changes. **Check now** makes an immediate request and is disabled while one is in flight.

| State        | Dot           | Text                                       | Detail line                                            |
| ------------ | ------------- | ------------------------------------------ | ------------------------------------------------------ |
| Off          | slate         | Off · agents connect directly              | (none; no polling while off)                           |
| Checking     | blue, pulsing | Checking proxy…                            | (none)                                                 |
| Healthy      | green         | Healthy · v{version}                       | Checked {time}                                         |
| Unavailable  | amber         | Proxy unavailable; agents connect directly | {reason} · Checked {time}                              |
| Status error | red           | Could not load Headroom status.            | Retry with Check now. Routing still falls back safely. |

Unavailable is **amber, not red**. Runs still succeed through direct fallback, so it is a warning, not a failure. Red is reserved for the case where the app itself cannot load status.

Reason codes from the server map to short text. An unknown code shows the generic **Proxy unavailable** text without a detail, and raw errors are never shown:

| Code                 | Text                             |
| -------------------- | -------------------------------- |
| `health_timeout`     | No response within 1 second      |
| `connection_refused` | Connection refused               |
| `http_error`         | Proxy returned an HTTP error     |
| `invalid_response`   | Not a Headroom health response   |
| `not_ready`          | Headroom reports it is not ready |

Development owns the final code list. If it differs, update this table and the four locale strings together.

The heading pill repeats the dot and the short state (Off / Checking / Healthy / Unavailable), so the state is visible with the card scrolled.

### Savings

- Shown only in the Healthy state. Label: **Proxy compression tokens saved**, from `tokens.proxy_compression_saved`. Numbers use `Intl.NumberFormat(locale)`.
- Sub-line: **Counts all traffic through this proxy, not only Claw-Empire.** The counter is global to the proxy, and the UI must not attribute it to tasks.
- If the field is missing, negative or not a number: **Savings not reported by this proxy**. A failed stats read does not change the health state or disable any control.
- No percentages and no "you saved X%" claims.

## Save feedback

The existing **✅ Saved** text next to the Save button gets a Headroom-aware variant whenever the saved payload changed any `headroom` field: **✅ Saved · applies to the next agent run**. Running tasks are never interrupted, and nothing else in the save flow changes.

## Task log warning (reference)

The fallback warning appears in the existing task log, not in Settings. Settings copy points to it ("the task log notes it"). The log line format is owned by Development (`Headroom unavailable; continuing directly (health_timeout).`). Design only asks that it uses the same reason code as the status card, so users can match the two.

## Accessibility

- Every switch has an accessible name equal to its visible label (`aria-label` on the `ToggleSettingCard` button, as today) and `aria-pressed`. The coverage and Next run lines are linked with `aria-describedby`.
- Disabled switches stay focusable through `aria-disabled` instead of `disabled`, so screen-reader users still hear the "Turn on Headroom to change" hint. Clicks are ignored while disabled.
- The status line is a polite live region (`aria-live="polite"`) and is announced only when the state changes, not on every poll.
- Color is never the only signal. Each dot is paired with its state word.
- Tab order: master switch → URL → Reset → Claude → Codex → API → Check now → Save.

## Copy (en / ko / ja / zh)

All strings go through `t({ en, ko, ja, zh })`. `{url}`, `{version}` and `{time}` are interpolated. `{time}` uses `toLocaleTimeString(locale)`.

| Key                 | en                                                                                                                                                     | ko                                                                                                                                                  | ja                                                                                                                                                               | zh                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Section title       | Headroom proxy                                                                                                                                         | Headroom 프록시                                                                                                                                     | Headroom プロキシ                                                                                                                                                | Headroom 代理                                                                                                    |
| Section intro       | Route agent model traffic through a local Headroom proxy to compress prompts and save tokens. Claw-Empire does not install or start Headroom.          | 에이전트 모델 트래픽을 로컬 Headroom 프록시로 보내 프롬프트를 압축하고 토큰을 절약합니다. Claw-Empire는 Headroom을 설치하거나 실행하지 않습니다.    | エージェントのモデル通信をローカルの Headroom プロキシ経由にして、プロンプトを圧縮しトークンを節約します。Claw-Empire は Headroom をインストール・起動しません。 | 将智能体的模型流量经由本地 Headroom 代理发送，以压缩提示词并节省令牌。Claw-Empire 不会安装或启动 Headroom。      |
| Master switch       | Enable Headroom                                                                                                                                        | Headroom 사용                                                                                                                                       | Headroom を有効にする                                                                                                                                            | 启用 Headroom                                                                                                    |
| Master help         | Off: every agent calls its provider directly, even if the server environment sets ANTHROPIC_BASE_URL or OPENAI_BASE_URL.                               | 끄면 서버 환경에 ANTHROPIC_BASE_URL 또는 OPENAI_BASE_URL이 설정되어 있어도 모든 에이전트가 프로바이더를 직접 호출합니다.                            | オフの場合、サーバー環境に ANTHROPIC_BASE_URL や OPENAI_BASE_URL が設定されていても、すべてのエージェントがプロバイダーへ直接接続します。                        | 关闭时，即使服务器环境设置了 ANTHROPIC_BASE_URL 或 OPENAI_BASE_URL，所有智能体也会直接调用提供方。               |
| URL label           | Proxy URL                                                                                                                                              | 프록시 URL                                                                                                                                          | プロキシ URL                                                                                                                                                     | 代理 URL                                                                                                         |
| URL help            | Root URL the Claw-Empire server can reach, without /v1.                                                                                                | Claw-Empire 서버가 접근할 수 있는 루트 URL(/v1 제외).                                                                                               | Claw-Empire サーバーから到達できるルート URL（/v1 なし）。                                                                                                       | Claw-Empire 服务器可访问的根 URL（不含 /v1）。                                                                   |
| Reset               | Reset to default                                                                                                                                       | 기본값으로 재설정                                                                                                                                   | 既定値に戻す                                                                                                                                                     | 恢复默认值                                                                                                       |
| Error: empty        | Enter a proxy URL.                                                                                                                                     | 프록시 URL을 입력하세요.                                                                                                                            | プロキシ URL を入力してください。                                                                                                                                | 请输入代理 URL。                                                                                                 |
| Error: scheme       | Use an http:// or https:// URL.                                                                                                                        | http:// 또는 https:// URL을 사용하세요.                                                                                                             | http:// または https:// の URL を使用してください。                                                                                                              | 请使用 http:// 或 https:// URL。                                                                                 |
| Error: credentials  | Do not put a username or password in the URL.                                                                                                          | URL에 사용자 이름이나 비밀번호를 넣지 마세요.                                                                                                       | URL にユーザー名やパスワードを含めないでください。                                                                                                               | URL 中不要包含用户名或密码。                                                                                     |
| Error: query        | Remove the query string or # fragment.                                                                                                                 | 쿼리 문자열이나 # 조각을 제거하세요.                                                                                                                | クエリ文字列や # フラグメントを削除してください。                                                                                                                | 请移除查询字符串或 # 片段。                                                                                      |
| Normalized          | Saved as {url} (the /v1 suffix is added per provider).                                                                                                 | {url}(으)로 저장됩니다. /v1은 프로바이더별로 자동 추가됩니다.                                                                                       | {url} として保存されます（/v1 はプロバイダーごとに自動付与）。                                                                                                   | 将保存为 {url}（/v1 会按提供方自动添加）。                                                                       |
| Save blocked        | Fix the proxy URL before saving.                                                                                                                       | 저장하기 전에 프록시 URL을 수정하세요.                                                                                                              | 保存する前にプロキシ URL を修正してください。                                                                                                                    | 保存前请修正代理 URL。                                                                                           |
| Group heading       | Route these agents                                                                                                                                     | 라우팅할 에이전트                                                                                                                                   | 経由させるエージェント                                                                                                                                           | 要路由的智能体                                                                                                   |
| Claude coverage     | Task runs and meeting calls · via ANTHROPIC_BASE_URL                                                                                                   | 작업 실행과 회의 호출 · ANTHROPIC_BASE_URL 사용                                                                                                     | タスク実行と会議呼び出し · ANTHROPIC_BASE_URL 経由                                                                                                               | 任务运行与会议调用 · 通过 ANTHROPIC_BASE_URL                                                                     |
| Codex coverage      | Task runs and meeting calls · per-run -c override; ~/.codex/config.toml is never edited                                                                | 작업 실행과 회의 호출 · 실행별 -c 재정의, ~/.codex/config.toml은 수정하지 않음                                                                      | タスク実行と会議呼び出し · 実行ごとの -c 上書き。~/.codex/config.toml は変更しません                                                                             | 任务运行与会议调用 · 每次运行的 -c 覆盖；绝不修改 ~/.codex/config.toml                                           |
| API coverage        | Anthropic and OpenAI-compatible providers (e.g. Ollama) · original upstream kept                                                                       | Anthropic 및 OpenAI 호환 프로바이더(예: Ollama) · 원래 업스트림 유지                                                                                | Anthropic と OpenAI 互換プロバイダー（例: Ollama）· 元のアップストリームを維持                                                                                   | Anthropic 与 OpenAI 兼容提供方（如 Ollama）· 保留原始上游                                                        |
| Always direct       | Always direct: Gemini, OpenCode, Kimi, Copilot and Antigravity agents, Google native API, model discovery and connection tests.                        | 항상 직접 연결: Gemini, OpenCode, Kimi, Copilot, Antigravity 에이전트, Google 네이티브 API, 모델 조회 및 연결 테스트                                | 常に直接接続: Gemini・OpenCode・Kimi・Copilot・Antigravity エージェント、Google ネイティブ API、モデル一覧取得と接続テスト                                       | 始终直连：Gemini、OpenCode、Kimi、Copilot 和 Antigravity 智能体、Google 原生 API、模型发现与连接测试             |
| Off hint            | Turn on Headroom to change. Your choices are kept.                                                                                                     | 변경하려면 Headroom을 켜세요. 선택한 값은 유지됩니다.                                                                                               | 変更するには Headroom を有効にしてください。選択内容は保持されます。                                                                                             | 开启 Headroom 后才能更改。你的选择会被保留。                                                                     |
| Codex unverified    | Not available yet: Codex routing has not been verified for your sign-in method. Codex runs directly.                                                   | 아직 사용할 수 없음: 현재 로그인 방식에서 Codex 라우팅이 검증되지 않았습니다. Codex는 직접 연결합니다.                                              | まだ利用できません: 現在のサインイン方式で Codex のルーティングは未検証です。Codex は直接接続します。                                                            | 暂不可用：尚未针对当前登录方式验证 Codex 路由。Codex 将直接连接。                                                |
| Next: Headroom      | Next run: Headroom                                                                                                                                     | 다음 실행: Headroom                                                                                                                                 | 次回実行: Headroom                                                                                                                                               | 下次运行：Headroom                                                                                               |
| Next: direct        | Next run: direct                                                                                                                                       | 다음 실행: 직접 연결                                                                                                                                | 次回実行: 直接接続                                                                                                                                               | 下次运行：直连                                                                                                   |
| · provider off      | · provider off                                                                                                                                         | · 프로바이더 꺼짐                                                                                                                                   | · プロバイダーがオフ                                                                                                                                             | · 提供方已关闭                                                                                                   |
| · proxy unavailable | · proxy unavailable                                                                                                                                    | · 프록시 사용 불가                                                                                                                                  | · プロキシ利用不可                                                                                                                                               | · 代理不可用                                                                                                     |
| · not verified      | · not verified                                                                                                                                         | · 검증되지 않음                                                                                                                                     | · 未検証                                                                                                                                                         | · 未验证                                                                                                         |
| Next: checking      | Next run: checked when the run starts                                                                                                                  | 다음 실행: 실행 시작 시 확인                                                                                                                        | 次回実行: 実行開始時に確認                                                                                                                                       | 下次运行：在运行开始时检查                                                                                       |
| Status: off         | Off · agents connect directly                                                                                                                          | 꺼짐 · 에이전트가 직접 연결                                                                                                                         | オフ · エージェントは直接接続                                                                                                                                    | 已关闭 · 智能体直接连接                                                                                          |
| Status: checking    | Checking proxy…                                                                                                                                        | 프록시 확인 중…                                                                                                                                     | プロキシを確認中…                                                                                                                                                | 正在检查代理…                                                                                                    |
| Status: healthy     | Healthy · v{version}                                                                                                                                   | 정상 · v{version}                                                                                                                                   | 正常 · v{version}                                                                                                                                                | 正常 · v{version}                                                                                                |
| Status: unavailable | Proxy unavailable; agents connect directly                                                                                                             | 프록시를 사용할 수 없어 직접 연결합니다                                                                                                             | プロキシを利用できないため直接接続します                                                                                                                         | 代理不可用，使用直连                                                                                             |
| Status: error       | Could not load Headroom status.                                                                                                                        | Headroom 상태를 불러오지 못했습니다.                                                                                                                | Headroom の状態を読み込めませんでした。                                                                                                                          | 无法加载 Headroom 状态。                                                                                         |
| Status error help   | Retry with Check now. Routing still falls back safely.                                                                                                 | 지금 확인으로 다시 시도하세요. 라우팅은 여전히 안전하게 직접 연결로 전환됩니다.                                                                     | 「今すぐ確認」で再試行してください。ルーティングは引き続き安全に直接接続へ切り替わります。                                                                       | 请点击“立即检查”重试。路由仍会安全回退为直连。                                                                   |
| Reason: timeout     | No response within 1 second                                                                                                                            | 1초 안에 응답 없음                                                                                                                                  | 1 秒以内に応答なし                                                                                                                                               | 1 秒内无响应                                                                                                     |
| Reason: refused     | Connection refused                                                                                                                                     | 연결 거부됨                                                                                                                                         | 接続が拒否されました                                                                                                                                             | 连接被拒绝                                                                                                       |
| Reason: http        | Proxy returned an HTTP error                                                                                                                           | 프록시가 HTTP 오류를 반환함                                                                                                                         | プロキシが HTTP エラーを返しました                                                                                                                               | 代理返回了 HTTP 错误                                                                                             |
| Reason: invalid     | Not a Headroom health response                                                                                                                         | Headroom 상태 응답이 아님                                                                                                                           | Headroom のヘルス応答ではありません                                                                                                                              | 不是 Headroom 健康检查响应                                                                                       |
| Reason: not ready   | Headroom reports it is not ready                                                                                                                       | Headroom이 준비되지 않았다고 보고함                                                                                                                 | Headroom が準備未完了と報告しています                                                                                                                            | Headroom 报告尚未就绪                                                                                            |
| Checked at          | Checked {time}                                                                                                                                         | {time} 확인                                                                                                                                         | {time} に確認                                                                                                                                                    | 检查于 {time}                                                                                                    |
| Check now           | Check now                                                                                                                                              | 지금 확인                                                                                                                                           | 今すぐ確認                                                                                                                                                       | 立即检查                                                                                                         |
| Unsaved             | Unsaved changes · status shows the saved URL                                                                                                           | 저장되지 않은 변경 사항 · 상태는 저장된 URL 기준                                                                                                    | 未保存の変更あり · 状態は保存済み URL のものです                                                                                                                 | 有未保存的更改 · 状态基于已保存的 URL                                                                            |
| Savings label       | Proxy compression tokens saved                                                                                                                         | 프록시 압축으로 절약한 토큰                                                                                                                         | プロキシ圧縮による節約トークン数                                                                                                                                 | 代理压缩节省的令牌数                                                                                             |
| Savings scope       | Counts all traffic through this proxy, not only Claw-Empire.                                                                                           | Claw-Empire뿐 아니라 이 프록시를 거친 모든 트래픽 기준입니다.                                                                                       | Claw-Empire だけでなく、このプロキシを通過したすべての通信の合計です。                                                                                           | 统计经过此代理的所有流量，不仅限于 Claw-Empire。                                                                 |
| Savings missing     | Savings not reported by this proxy                                                                                                                     | 이 프록시는 절약량을 보고하지 않습니다                                                                                                              | このプロキシは節約量を報告していません                                                                                                                           | 此代理未报告节省量                                                                                               |
| Applies next run    | Changes apply to the next agent run. Running agents are not interrupted. If the proxy is unreachable, runs connect directly and the task log notes it. | 변경 사항은 다음 에이전트 실행부터 적용되며 실행 중인 에이전트는 중단되지 않습니다. 프록시에 연결할 수 없으면 직접 연결하고 작업 로그에 기록합니다. | 変更は次回のエージェント実行から適用され、実行中のエージェントは中断されません。プロキシに到達できない場合は直接接続し、タスクログに記録します。                 | 更改从下一次智能体运行开始生效，正在运行的智能体不会被中断。如果无法访问代理，运行将直接连接并在任务日志中记录。 |
| Saved variant       | Saved · applies to the next agent run                                                                                                                  | 저장 완료 · 다음 에이전트 실행부터 적용                                                                                                             | 保存完了 · 次回のエージェント実行から適用                                                                                                                        | 已保存 · 从下一次智能体运行开始生效                                                                              |

The ko/ja/zh strings for "Enable Headroom", "Proxy URL", "Healthy", the fallback text and the savings label match the Planning copy table. Everything else is new and should get a native-speaker pass before release if one is available.

## Acceptance checklist (Design review)

These items close Design Pixel's two review revisions. QA can test each one through accessible names, without screenshots.

1. **Clearly labeled controls.** Section heading "Headroom proxy". Switches named "Enable Headroom", "Claude Code", "Codex", "API providers". A labeled "Proxy URL" input.
2. **Enable toggle.** It defaults to off, saves through the General Save button, and survives a reload.
3. **Validated proxy URL.** Each error row in the validation table shows its message, sets `aria-invalid`, and blocks Save. `/v1` and trailing `/` are normalized with the note shown. The field stays editable while Headroom is off.
4. **Provider coverage.** Each switch shows its coverage line. The "Always direct" line is always visible. Codex shows the unverified reason when `capabilities.codex` is false.
5. **Disabled behavior.** With the master switch off, the provider switches are `aria-disabled` and keep their saved values after save and reload. The status reads "Off · agents connect directly" and no status polling happens.
6. **Unreachable behavior.** With a fake unavailable status, the pill is amber, the text says agents connect directly, the reason text is mapped, every enabled provider's Next run line reads "direct · proxy unavailable", and no control is disabled because of it.
7. **Configured vs effective.** The Next run lines come from the status endpoint. The unsaved-changes notice appears after editing and clears after Save.
8. **Savings.** The value is shown with locale formatting and the scope note. Zero, missing and malformed values are handled. A stats failure leaves health and the controls unaffected.
9. **Polling hygiene.** It polls every 15 s only while mounted and visible, aborts on unmount and on a saved-URL change, and **Check now** is disabled while a check is in flight.
10. **Four locales.** Every string in the copy table renders in en, ko, ja and zh.

## Alternatives considered

- **A dedicated "Headroom" settings tab.** Rejected. There are only five controls, and the Planning contract puts them in General. A tab would also need its own save flow.
- **Hide the provider switches while Headroom is off.** Rejected. Users would lose sight of what turning Headroom on will route. Disabled-but-visible switches show the saved choices.
- **Red for "unavailable".** Rejected. Runs still succeed through direct fallback, so a red alarm would overstate it. Amber matches "degraded, still working".
- **Per-API-provider switches.** Out of scope for this MVP, per the Planning contract. The single API switch names its coverage instead.
