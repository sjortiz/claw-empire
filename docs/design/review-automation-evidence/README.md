# Review automation: Design acceptance evidence

Design approves the reviewed UI with the nonblocking warnings below. Both assigned
UI-confirmation items are addressed in order: `400b5e93-5247-4377-a87e-63bace1a1843`,
then `5b49e502-fdee-4007-ae14-52c46dbf0f41`. No production code changes were needed.

Reviewed on 2026-10-21 at `01df587`, which integrates the selected Development
revision `b2da2b6`. This is a review record, not a replacement implementation or
feature specification.

## Evidence and result

| Acceptance point                               | Observation                                                                                                                                                                                                                  | Evidence                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Global auto-start defaults off                 | Production `DEFAULT_SETTINGS` supplies `false`; the rendered button exposes `aria-pressed=false` and its thumb is on the left. Auto-apply is also off.                                                                       | [Default controls](01-global-default-off-en.png)                                                 |
| Auto-start and auto-apply are independent      | Clicking only auto-start changes its pressed state to true while auto-apply remains false.                                                                                                                                   | [Start on, apply off](02-global-start-on-apply-off-en.png)                                       |
| Project offers all three choices               | Both native selects contain `Use global setting` (`inherit`), `On` (`on`), and `Off` (`off`). Each auto-start choice was selected and captured; auto-apply stayed inherited.                                                 | [Inherit](03-project-inherit-en.png), [On](04-project-on-en.png), [Off](05-project-off-en.png)   |
| Every UI language is represented               | Global labels, both project labels, all three options, and the informational inbox label/action render in English, Korean, Japanese, and Chinese.                                                                            | Language matrix below                                                                            |
| Auto-start notification is informational       | The modal shows “Review Meeting Auto-Started (Notice)” and one “Acknowledge” action, with no start-meeting approval action. Clicking the Chinese acknowledgement invokes the local callback and dismisses the fixture modal. | [English notice](inbox-en.png), language matrix below                                            |
| Already-waiting gates have documented guidance | The existing documentation says enabling the setting does not release an already-waiting gate; approve that gate in the Decision Inbox.                                                                                      | [Existing feature documentation](../../review-automation.md#start-review-meetings-automatically) |
| Narrow component layout remains usable         | The English global controls stack and their labels wrap; project controls remain inside the panel. The iframe viewport was 388 CSS pixels wide (390 including its border), with no horizontal document overflow.             | [Narrow layout](06-narrow-390-en.png)                                                            |

Native dropdown popups are omitted by the browser screenshot API. The three
selected-state captures above and the inspected native option lists establish
the choices without changing the production select into a custom menu.

| Language | Global default-off controls            | Project selectors                    | Informational inbox    |
| -------- | -------------------------------------- | ------------------------------------ | ---------------------- |
| English  | [Global](01-global-default-off-en.png) | [Project](03-project-inherit-en.png) | [Notice](inbox-en.png) |
| Korean   | [Global](global-ko.png)                | [Project](project-ko.png)            | [Notice](inbox-ko.png) |
| Japanese | [Global](global-ja.png)                | [Project](project-ja.png)            | [Notice](inbox-ja.png) |
| Chinese  | [Global](global-zh.png)                | [Project](project-zh.png)            | [Notice](inbox-zh.png) |

## Capture method and limits

Screenshots were taken in local Chrome through browser-act, serving this worktree
with Vite on loopback. A temporary preview imported the unchanged production
`GeneralSettingsTab`, `ProjectReviewAutomationSelector`, `DecisionInboxModal`,
`mapWorkflowDecisionItemsLocalized`, `DEFAULT_SETTINGS`, and application CSS.
The preview supplied local React state and no-op save handlers. The inbox used a
`review_auto_started` fixture with an acknowledgement option. Its English summary
is fixture content; the notice label and action use production localization.
The narrow capture embeds the same global and project previews in bordered
390-pixel frames; it is a component-layout check, not a complete mobile app review.

These are rendered component and interaction checks, not screenshots of persisted
live settings or proof that a backend gate started. Project persistence, effective
override precedence, gate safety, and the required automated checks remain in
Development's evidence. No live server checkout or database was accessed or
modified. No automated tests were run by Design, per department scope.

The settings modal and project editor source wiring were inspected to confirm the
captured components are used by the selected implementation. The older standalone
`ReviewAutomationSettings.tsx` component was not used for these captures.

## Nonblocking warnings

- **Medium — global help is hover-only.** The global controls put explanatory copy
  in a button `title`; touch users cannot reliably discover it. A future refinement
  should expose concise visible help and associate it with the control. The
  already-waiting-gate guidance is documented but absent beside the toggle.
- **Low — inheritance does not display the effective value.** “Use global setting”
  is clear as a choice, but the project selector does not show whether the current
  global value is on or off. Consider an effective-value hint in a future pass.

Neither finding is critical/high or prevents the requested controls from being
used. Under the MVP review policy they are reported without production edits.
Planning can consolidate this UI approval with Development's technical evidence.
