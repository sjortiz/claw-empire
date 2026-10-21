# Meeting verdicts: display spec

Display spec for structured planning and review verdicts. The parser, retry and fallback live in `src/lib/meeting-verdict.ts` and `server/modules/workflow/meeting-verdict.ts` (commit `0376573`). This document covers what the user sees. It responds to the two Design revision requests from review round 1: every planning and review verdict reads as an explicit APPROVE or REVISE, in the same way everywhere, kept apart from the rationale and residual risks. Missing or invalid verdicts are flagged for clarification instead of looking like real decisions.

The wire format is Development's choice: today it is a fenced JSON block, and a single verdict line would also work. The display below must not change if the format does.

## Gaps in `0376573`

1. **A fallback looks like a real decision.** When the reply and the one retry both lack a verdict, the server writes a synthesized block (`blocking_items: [whole reply]`) into the transcript. The minutes then show "Revise · 1 blocking" with the full reply repeated as the blocking item, so a keyword guess looks like an explicit REVISE. The `source` (`structured` / `retry` / `legacy`) is logged but not stored.
2. **Raw JSON in chat.** `speak()` sends the full content, verdict block included, through `sendAgentMessage`. `MessageContent` renders it as a JSON code block, so the chat shows a different thing from the minutes.
3. **Verdict mixed into rationale.** In `TerminalPanel` the blocking items and notes are plain lines inside the prose `<div>`. Nothing visually separates the decision, the blocking work and the informational residual risks.
4. **Summaries have no verdict.** The meeting header, the Decision Inbox options and the project memo items (`collectRevisionMemoItems` → `Dept Speaker: item`) don't say which verdict produced them.
5. **The downgrade is explained only in a tooltip.** A REVISE with no blocking items, counted as an approval, is explained only in a `title` tooltip. Touch and keyboard users never see it.
6. **Inconsistent ja wording.** The chip says ブロッキング, while the list and the server prompt say 阻害項目.

## Verdict states

Every leader entry in a planning or review meeting resolves to exactly one state. The chip always pairs an icon with a text label, so colour is never the only signal.

| State                    | When                                                                                  | Chip                                                                                                                        | Body                                                         |
| ------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **APPROVE**              | `approve`, from `structured` or `retry`                                               | emerald, `✓ APPROVE`                                                                                                        | rationale; notes if any                                      |
| **APPROVE (downgraded)** | `revise` with zero blocking items                                                     | emerald, `✓ APPROVE`, plus a visible muted suffix: "revise had no blocking items"                                           | rationale; notes if any                                      |
| **REVISE**               | `revise` with ≥1 blocking item                                                        | amber, `↻ REVISE · N`                                                                                                       | rationale; blocking list; notes if any                       |
| **NO VERDICT**           | `source = legacy` (retry also failed)                                                 | slate, dashed border, `? NO VERDICT` plus a suffix showing the guessed effect: "classifier: revise" / "classifier: approve" | rationale; a "Needs clarification" line instead of the lists |
| _(none)_                 | entries without a verdict block: CEO office notices, meetings from before this change | no chip                                                                                                                     | content as before                                            |

- `source = retry` gets the normal chip plus a muted "· on retry" suffix. It is a real verdict, but the trace stays visible.
- Amber always means work: it is used only for REVISE and blocking items. NO VERDICT must not be amber, because it marks uncertainty, not confirmed work.
- English labels are uppercase so they read like the requested APPROVE / REVISE words. Other locales use the table under "Copy".

## Entry layout (minutes and chat)

```
#4  Aria  Development · Leader                    [↻ REVISE · 2]
Rationale prose (verdict block stripped)
┃ Blocking items (2)                    ← amber left border, amber-300 text
┃ • Repair parser for trailing prose
┃ • Add planned-meeting regression test
▸ Notes (1) · informational, no work    ← muted, collapsible
```

- The order is fixed: **header chip → rationale → blocking items → notes**. The decision is scannable in the header row, and the rationale reads on its own.
- Blocking items: a `<ul>` with an amber left border, titled "Blocking items (N)". It appears only for REVISE.
- Notes hold the residual risks. They use muted text in a `<details>`, open when there are 3 notes or fewer and collapsed when there are more. They never use amber. The title includes "informational, no work" so nobody reads them as a hold.
- NO VERDICT: drop both lists (the synthesized blocking item is the reply itself) and show one slate line: "No explicit verdict. Outcome came from the keyword classifier; ask this leader to confirm."
- Chip accessibility: `aria-label="Verdict: Revise, 2 blocking items"` and equivalent labels for the other states. The downgrade and NO VERDICT suffixes are real text, not `title` tooltips.

## Where it appears

All of these surfaces use one shared component (suggested name: `MeetingVerdictView`, exporting the chip and the body) so they cannot drift.

1. **Meeting minutes** (`TerminalPanel`, minutes tab): the entry layout above, for both `review` and `planned` meetings.
2. **Meeting header summary.** After the status pill, a counts pill built from each speaker's **latest** verdict in that meeting (review leaders speak twice), e.g. `✓ 3 · ↻ 1 · ? 1`. Leave out zero counts. Hide the pill when no entry has a verdict.
3. **Chat** (`MessageContent` / `ChatMessageList`): if a message ends in a valid verdict block, render the prose plus the same chip and lists rather than the JSON code block. Other code blocks render as before.
4. **Office meeting bubble.** Strip the verdict block before `summarizeForMeetingBubble`, so the 96-character preview is prose and never `"verdict": …`. The seat badge already follows the parsed verdict for review. The `planned` phase should pass the same decision, so both meetings show a badge. NO VERDICT shows the `?` badge, not the hold badge.
5. **Decision summaries** (Decision Inbox options and project memo lines): prefix each item with the speaker's verdict, e.g. `Development Aria · REVISE: Repair parser…`. Items from a fallback read `Development Aria · NO VERDICT (classifier: revise): <clipped reply>`, so the CEO can see the item was guessed before picking it. The non-blocking memo header added in `0376573` stays as it is.

## Data contract needed from Development

- Store the source with the verdict: add an optional `"source": "structured" | "retry" | "legacy"` field to the stored block (or to the minute entry), and have `parseMeetingVerdict` return it, defaulting to `structured`. Without it, the UI cannot tell an explicit REVISE from a classifier guess (gap 1).
- Keep `blocking_items` as it is for legacy entries, since the revision memo still needs it. The UI hides the list when `source = legacy`.
- No new endpoint is needed. Everything comes from the existing minutes and messages payloads.

## Copy (ko / en / ja / zh)

| Key                 | ko                                                                      | en                                                                                         | ja                                                                               | zh                                                   |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| approve             | 승인                                                                    | APPROVE                                                                                    | 承認                                                                             | 批准                                                 |
| revise              | 수정 요청                                                               | REVISE                                                                                     | 修正依頼                                                                         | 需修改                                               |
| no verdict          | 판정 없음                                                               | NO VERDICT                                                                                 | 判定なし                                                                         | 无判定                                               |
| downgraded          | 차단 항목 없는 수정 요청                                                | revise had no blocking items                                                               | 阻害項目のない修正依頼                                                           | 无阻塞项的修订请求                                   |
| on retry            | 재요청으로 확인                                                         | on retry                                                                                   | 再要求で確認                                                                     | 重试后确认                                           |
| classifier          | 분류기: {승인\|수정 요청}                                               | classifier: {approve\|revise}                                                              | 分類器: {承認\|修正依頼}                                                         | 分类器: {批准\|需修改}                               |
| blocking items      | 차단 항목                                                               | Blocking items                                                                             | 阻害項目                                                                         | 阻塞项                                               |
| notes               | 참고 사항 · 정보용, 작업 없음                                           | Notes · informational, no work                                                             | 参考情報 · 作業化しない                                                          | 备注 · 仅供参考，不转为工作                          |
| needs clarification | 명시적 판정 없음. 키워드 분류기 결과이며 해당 팀장의 확인이 필요합니다. | No explicit verdict. Outcome came from the keyword classifier; ask this leader to confirm. | 明示的な判定なし。キーワード分類器の結果のため、このリーダーに確認してください。 | 无明确判定。结果来自关键词分类器，请向该负责人确认。 |

ja uses 阻害項目 everywhere, which matches the server prompt (gap 6).

## Acceptance evidence Design will check

- Screenshots of the minutes tab showing all five states, in one review meeting and one planned meeting, including the header counts pill.
- A screenshot of a chat message with a verdict: no JSON visible, the same chip as the minutes.
- A screenshot of the Decision Inbox with a REVISE item and a NO VERDICT item, prefixed as specified.
- Web tests extending `TerminalPanel.verdict.test.tsx`: the downgrade suffix is visible text, a legacy entry shows NO VERDICT with no blocking list, notes collapse when there are more than 3, and the header counts use the latest verdict per speaker.

## Out of scope

- Parser, retry and round-limit behaviour (`REVIEW_MAX_ROUNDS` and the final-round rules are unchanged).
- Restyling the meeting minutes beyond the verdict pieces.
