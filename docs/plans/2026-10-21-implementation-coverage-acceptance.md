# Implementation coverage: Planning acceptance criteria

Status: requirements established; implementation and verification evidence pending.

Planning item: `PLN-01` / `bad7764e-0f51-4233-a990-ae3357c4e475`.
Parent: `5b948211-0b00-47b1-91f8-9f96a4ecb8ff`.

This is the acceptance contract for the existing departmental work, not an
additional implementation plan. Development owns production changes and test
execution. Planning's later acceptance/evidence consolidation item remains
dependent on the implementation verification report.

## Required outcome

A directive that requests code changes must retain actionable implementation work
owned by a department that can write code, Development (`dev`) by default, from
planning through execution. Selecting Development in a pre-check, assigning a
document to Development, or mentioning an absent implementation owner does not
satisfy this requirement. Completion requires the requested implementation and
verification evidence.

The Nexo failure is the reference case: the request covered fixes for issues #84
and #85, tests, and one branch per issue. Seven Planning/Operations process tasks
could not cover those deliverables. This project fixes the planning system; it
does not repeat the Nexo fixes or modify Nexo's repository.

## Acceptance and ownership matrix

The item names and keys below refer to the existing parent checklist. Overlapping
Development items may share production changes and evidence under Aria's
coordination; their distinct requirements and prerequisite keys must survive.

| ID | Observable acceptance criterion | Existing implementation owner/item | Required verification evidence |
| --- | --- | --- | --- |
| AC-01 | Requested implementation intent includes Development in planning inputs even when department keywords initially select only Operations or Planning. Keep other genuinely relevant departments. Evaluate the requested action in context, across supported UI languages; keywords alone are insufficient. | Development: fix implementation participation in planning inputs (`DEV-01`); detect code-change intent and implementation units (`DEV-1`); include Development in the department pre-check (`DEV-2`). | Pre-check/input regression for the English Nexo-style request without the word “Development”; representative Korean, Japanese, and Chinese implementation requests; selected departments and reasons in logs. |
| AC-02 | Every requested implementation unit is traceable to actionable code-writing work with code and appropriate tests as deliverables. At least one implementation item is mandatory; a generic item cannot silently omit a separately requested issue, test, or branch requirement. | Development: enforce implementation coverage before graph acceptance (`DEV-02`); detect code-change intent and implementation units (`DEV-1`); validate and repair missing implementation items (`DEV-3`). | Requirement-to-plan mapping for both #84 and #85, tests, and separate issue branches. Plan snapshots identify `dev` implementation items and retain each unit's constraints. |
| AC-03 | A code-change plan containing only specifications, documentation, readiness checks, observability setup, or evidence consolidation is invalid, including when those items are assigned to `dev`. Process work is permitted when requested or when it supports identifiable implementation work; it cannot substitute for that work. | Development: enforce implementation coverage before graph acceptance (`DEV-02`); validate and repair missing implementation items (`DEV-3`); strengthen drafting and consolidation prompts. | Negative cases for process-only graphs and a misleading Development-owned specification; a valid mixed implementation/support graph. |
| AC-04 | Missing implementation coverage is repaired automatically and validated again, or approval is blocked with a clear log and CEO notification. Invalid plans remain unaccepted after unsuccessful repair. A prompt instruction alone is not enforcement. | Development: enforce implementation coverage before graph acceptance (`DEV-02`); validate and repair missing implementation items (`DEV-3`); strengthen drafting and consolidation prompts. | Before/after repair snapshot plus validation result, or blocked approval and notification evidence. Repeated invalid repair never reaches accepted execution. |
| AC-05 | Seeding, materialization, department analysis, rerouting, and execution preserve the implementation item's deliverables and a code-writing owner. An unavailable developer delays or reassigns eligible implementation work without converting it into Planning/Operations process work. | Development: preserve implementation ownership through execution (`DEV-03`). | Routing/materialization regressions inspect executable children and final owner, not just the draft text. Availability case retains pending implementation. |
| AC-06 | Preserve distinct departmental draft items and `depends_on` keys. Independent work remains parallel; verification that requires implementation waits for its implementation prerequisites. Readiness and test planning may run independently. Invalid graphs cannot become independent work by losing dependencies. | Development: enforce implementation coverage before graph acceptance (`DEV-02`); preserve implementation ownership through execution (`DEV-03`); strengthen drafting and consolidation prompts. | Existing parallel planning, full-draft retention, and dependency checks pass; repair does not drop unrelated items, produce dangling keys/cycles, or release dependent verification early. |
| AC-07 | Docs-only and meeting-only directives remain valid without forced implementation. Quoted code requests or instructions to document a fix/PR workflow do not alone mean the user requested that fix/PR. Mixed requests retain the actual code work. | Development: detect code-change intent and implementation units (`DEV-1`); implementation participation (`DEV-01`). | Positive code-change and mixed-request cases plus docs-only/meeting-only negative controls, including code-related words in documentation context. |
| AC-08 | Logs explain which departments were chosen and why, plus any missing unit/owner, repair, or approval block. The accepted plan and executable children expose the same implementation coverage. | Development: planning inputs (`DEV-01`), graph acceptance (`DEV-02`), execution ownership (`DEV-03`); Design: specify implementation coverage presentation. | Captured log lines with intent/selection rationale and an accepted-plan-to-child ownership comparison; Design supplies presentation requirements separately. |
| AC-09 | Neither process-task completion nor Planning's criteria delivery completes a code-change directive. Every required implementation unit has production changes and reported verification results before final completion. Failed, missing, blocked, or unrun required verification remains an explicit gap. | Development verification: verify implementation and required checks (`QA-02`); complete required verification and report results; Planning: review acceptance and consolidate CEO evidence. | Per-unit production diff and verification results tied to the tested revision/branch; all five required project check outcomes; final requirement-to-evidence reconciliation. |

## Minimum implementation item contract

Use the current planning graph fields (`key`, `title`, `description`,
`department_id`, `depends_on`); this document does not require a schema change.
An implementation item's title/description must make the following reviewable:

- The requested issue, behavior, or implementation unit it covers.
- The concrete code change and test deliverables, with preserved user constraints.
- A code-writing department (`dev` by default); execution must resolve to an
  eligible implementation owner rather than leave “the implementation owner” undefined.
- Real prerequisites, if any. Developer availability is a scheduling condition,
  not a fabricated dependency on unrelated process work.
- What observable behavior and verification evidence will establish completion.

For Nexo, the coverage record must separately identify #84 and #85, each issue's
implementation owner/item, code diff, tests/results, and distinct branch. A plan
may group work only if both units and all constraints stay explicit and executable;
a vague “fix issues” task without those obligations is insufficient. Shared
directive integration infrastructure must not erase the requested per-issue
branches. Evidence consolidation waits for both implementation units and their
verification, rather than only supporting documents.

Keep coverage states distinct: **Specified** means the item, owner, constraints,
and verification are defined; **Implemented** requires the code diff;
**Verified** requires the reported check results. This follows Design's handoff
at `docs/design/implementation-coverage-presentation.md`. Operations owns the
manual checklist at `docs/procedures/directive-planning-checklist.md` and handling
procedure at `docs/procedures/code-change-directives.md`; those owners supply
their documents separately. No edits to their files are required by PLN-01.

## Verification handoff

Development verification owns regression definition (`QA-01`), routing and
materialization regressions (`DEV-04`), the Nexo API replay, and execution of the
checks below. Retain the parent's existing prerequisite graph; this handoff adds
no dependencies on Planning documentation and creates no duplicate coding tasks.

The verification report must cover AC-01 through AC-09, identifying the input,
expected outcome, observed result, and evidence location for each scenario.
Include the original failure shape (Operations-only inference and process-only
draft), valid repair or explicit block, execution ownership, multilingual intent,
negative controls, and unchanged parallel/dependency behavior. The Nexo replay
uses an isolated test environment in this project's checkout, never the live
server checkout or database.

Required parent checks, all pending Development execution:

| Command | Required report |
| --- | --- |
| `pnpm run format:check` | Revision, result, and relevant failure output if any. |
| `pnpm run lint` | Revision, result, and relevant failure output if any. |
| `pnpm run build` | Revision, result, and relevant failure output if any. |
| `pnpm run test:web` | Revision, result, and relevant failure output if any. |
| `pnpm run test:api` | Revision, result, and relevant failure output if any. |

An unrun command is not a pass. Existing unrelated failures must be distinguished
from regressions and left visible for final review; Planning cannot infer success
from a completed documentation task or a proposed test list.

## Review boundaries and evidence state

Source review confirmed the current graph contract in
`server/modules/workflow/agents/planning-graph.ts`: structural validation checks
items, keys, and dependency integrity. Structural validity alone does not establish
implementation coverage. The parent points Development to department inference,
subtask routing/seeding, and meeting prompts; Development confirms and changes the
appropriate production paths.

PLN-01 is satisfied by this requirements/ownership/evidence mapping. It does not
establish that AC-01 through AC-09 currently pass. Implementation diffs, executed
regressions, API replay results, and all five command results remain pending the
assigned Development work. The later Planning acceptance review remains pending.

All work stays focused on planning coverage in this project's isolated checkout.
Do not touch `~/projects/oss/claw-empire` or its database. Do not push, open a PR,
or comment on GitHub; the CEO handles publication. This acceptance document and
the existing Operations checklist/documentation and Design specification are
supporting deliverables, not replacements for implementation.
