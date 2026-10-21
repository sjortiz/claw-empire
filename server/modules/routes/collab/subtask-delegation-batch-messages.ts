import type { Lang } from "../../../types/lang.ts";
import type { L10n } from "./language-policy.ts";

interface MessageDeps {
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
}

interface QueueProgressParams extends MessageDeps {
  lang: Lang;
  targetDeptName: string;
  queueIndex: number;
  queueTotal: number;
  itemCount: number;
}

interface OriginRequestParams extends MessageDeps {
  lang: Lang;
  crossLeaderName: string;
  parentTitle: string;
  itemCount: number;
  batchTitle: string;
}

interface CrossLeaderAckParams extends MessageDeps {
  lang: Lang;
  hasSubordinate: boolean;
  originLeaderName: string;
  itemCount: number;
  batchTitle: string;
  execName: string;
}

interface DelegatedDescriptionParams extends MessageDeps {
  lang: Lang;
  sourceDeptName: string;
  targetDeptName: string;
  parentTaskId: string;
  parentSummary: string;
  delegatedChecklist: string;
}

export const DELEGATED_PARENT_SUMMARY_MAX_CHARS = 500;
export const DELEGATED_CHECKLIST_MAX_CHARS = 12_000;

export function clipDelegationText(text: string, maxChars: number): string {
  const value = text.trim();
  return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}

export function buildDelegatedChecklist(
  subtasks: Array<{ id: string; title: string; description: string | null }>,
): string {
  return clipDelegationText(
    subtasks
      .map((st, idx) => {
        const title = clipDelegationText(st.title.replace(/\s+/g, " "), 240);
        const detail = st.description ? ` - ${clipDelegationText(st.description, 2_000)}` : "";
        return `${idx + 1}. ${title} [${st.id}]${detail}`;
      })
      .join("\n"),
    DELEGATED_CHECKLIST_MAX_CHARS,
  );
}

interface ExecutionStartParams extends MessageDeps {
  lang: Lang;
  targetDeptName: string;
  execName: string;
  itemCount: number;
  worktreeCeoNote: string;
}

export function teamLeadFallbackLabel(deps: MessageDeps, lang: Lang): string {
  return deps.pickL(deps.l(["팀장"], ["Team Lead"], ["チームリーダー"], ["组长"]), lang);
}

export function buildQueueProgressNotice(params: QueueProgressParams): string {
  const { l, pickL, lang, targetDeptName, queueIndex, queueTotal, itemCount } = params;
  return pickL(
    l(
      [`서브태스크 배치 위임 진행: ${targetDeptName} (${queueIndex + 1}/${queueTotal}, ${itemCount}건)`],
      [
        `Batched subtask delegation in progress: ${targetDeptName} (${queueIndex + 1}/${queueTotal}, ${itemCount} item(s))`,
      ],
      [`サブタスク一括委任進行中: ${targetDeptName} (${queueIndex + 1}/${queueTotal}, ${itemCount}件)`],
      [`批量 SubTask 委派进行中：${targetDeptName}（${queueIndex + 1}/${queueTotal}，${itemCount}项）`],
    ),
    lang,
  );
}

export function buildOriginRequestMessage(params: OriginRequestParams): string {
  const { l, pickL, lang, crossLeaderName, parentTitle, itemCount, batchTitle } = params;
  return pickL(
    l(
      [
        `${crossLeaderName}님, '${parentTitle}' 프로젝트의 서브태스크 ${itemCount}건(${batchTitle})을 순차 체크리스트로 일괄 처리 부탁드립니다! 🤝`,
      ],
      [
        `${crossLeaderName}, please process ${itemCount} subtasks (${batchTitle}) for '${parentTitle}' as one sequential checklist in a single run. 🤝`,
      ],
      [
        `${crossLeaderName}さん、'${parentTitle}' のサブタスク${itemCount}件（${batchTitle}）を順次チェックリストで一括対応お願いします！🤝`,
      ],
      [`${crossLeaderName}，请将'${parentTitle}'的 ${itemCount} 个 SubTask（${batchTitle}）按顺序清单一次性处理！🤝`],
    ),
    lang,
  );
}

export function buildCrossLeaderAckMessage(params: CrossLeaderAckParams): string {
  const { l, pickL, lang, hasSubordinate, originLeaderName, itemCount, batchTitle, execName } = params;
  if (hasSubordinate) {
    return pickL(
      l(
        [
          `네, ${originLeaderName}님! ${itemCount}건(${batchTitle})을 ${execName}에게 일괄 배정해 순차 처리하겠습니다 👍`,
        ],
        [
          `Got it, ${originLeaderName}! I'll assign ${itemCount} items (${batchTitle}) to ${execName} as one ordered batch. 👍`,
        ],
        [
          `了解です、${originLeaderName}さん！${itemCount}件（${batchTitle}）を${execName}に一括割り当てて順次対応します 👍`,
        ],
        [`收到，${originLeaderName}！将把 ${itemCount} 项（${batchTitle}）批量分配给 ${execName} 按顺序处理 👍`],
      ),
      lang,
    );
  }

  return pickL(
    l(
      [`네, ${originLeaderName}님! ${itemCount}건(${batchTitle})을 제가 직접 순차 처리하겠습니다 👍`],
      [`Understood, ${originLeaderName}! I'll handle ${itemCount} items (${batchTitle}) myself in order. 👍`],
      [`承知しました、${originLeaderName}さん！${itemCount}件（${batchTitle}）を私が順次対応します 👍`],
      [`明白，${originLeaderName}！这 ${itemCount} 项（${batchTitle}）由我按顺序亲自处理 👍`],
    ),
    lang,
  );
}

export function buildDelegatedTitle(deps: MessageDeps, lang: Lang, itemCount: number, batchTitle: string): string {
  return deps.pickL(
    deps.l(
      [`[서브태스크 일괄협업 x${itemCount}] ${batchTitle}`],
      [`[Batched Subtask Collaboration x${itemCount}] ${batchTitle}`],
      [`[サブタスク一括協業 x${itemCount}] ${batchTitle}`],
      [`[批量 SubTask 协作 x${itemCount}] ${batchTitle}`],
    ),
    lang,
  );
}

export function buildDelegatedDescription(params: DelegatedDescriptionParams): string {
  const { l, pickL, lang, sourceDeptName, targetDeptName, parentTaskId, parentSummary, delegatedChecklist } = params;
  const summary = clipDelegationText(parentSummary.replace(/\s+/g, " "), DELEGATED_PARENT_SUMMARY_MAX_CHARS);
  const checklist = clipDelegationText(delegatedChecklist, DELEGATED_CHECKLIST_MAX_CHARS);
  const reference = `GET /api/tasks/${parentTaskId}`;
  return pickL(
    l(
      [
        `[서브태스크 위임 from ${sourceDeptName}]\n[담당 범위: ${targetDeptName}]\n아래 담당 체크리스트만 수행하세요. 다른 부서의 업무는 해당 담당자와 조율하고 중복 수행하지 마세요.\n\n[순차 체크리스트]\n${checklist}\n\n[상위 업무 배경 — 참고 전용]\n${summary}\n전체 지시 및 생략된 체크리스트 상세: ${reference} (상위 업무 ${parentTaskId}). 전체 지시는 배경 참고이며 이 부서에 전체 업무를 배정하는 지시가 아닙니다.`,
      ],
      [
        `[Subtasks delegated from ${sourceDeptName}]\n[Department scope: ${targetDeptName}]\nExecute only the owned checklist below. Coordinate dependencies with other owners; do not duplicate their work.\n\n[Sequential checklist]\n${checklist}\n\n[Parent context — reference only]\n${summary}\nFull directive and any omitted checklist details: ${reference} (parent task ${parentTaskId}). The full directive is background reference; it does not assign the entire task to this department.`,
      ],
      [
        `[サブタスク委任元 ${sourceDeptName}]\n[担当範囲: ${targetDeptName}]\n以下の担当チェックリストのみ実行してください。他部門への依存事項は担当者と調整し、作業を重複しないでください。\n\n[順次チェックリスト]\n${checklist}\n\n[親タスクの背景 — 参照専用]\n${summary}\n完全な指示と省略されたチェックリストの詳細: ${reference} (親タスク ${parentTaskId})。完全な指示は背景資料であり、この部門に全作業を割り当てるものではありません。`,
      ],
      [
        `[SubTask 委派来源 ${sourceDeptName}]\n[负责范围：${targetDeptName}]\n仅执行以下负责清单。请与其他负责人协调依赖项，避免重复他们的工作。\n\n[顺序清单]\n${checklist}\n\n[父任务背景 — 仅供参考]\n${summary}\n完整指示及省略的清单详情：${reference}（父任务 ${parentTaskId}）。完整指示仅作背景参考，并非将全部任务分配给本部门。`,
      ],
    ),
    lang,
  );
}

export function buildWorktreeCeoNote(
  deps: MessageDeps,
  lang: Lang,
  delegatedTaskId: string,
  hasWorktree: boolean,
): string {
  if (!hasWorktree) return "";
  return deps.pickL(
    deps.l(
      [` (격리 브랜치: climpire/${delegatedTaskId.slice(0, 8)})`],
      [` (isolated branch: climpire/${delegatedTaskId.slice(0, 8)})`],
      [` (分離ブランチ: climpire/${delegatedTaskId.slice(0, 8)})`],
      [`（隔离分支: climpire/${delegatedTaskId.slice(0, 8)}）`],
    ),
    lang,
  );
}

export function buildExecutionStartNotice(params: ExecutionStartParams): string {
  const { l, pickL, lang, targetDeptName, execName, itemCount, worktreeCeoNote } = params;
  return pickL(
    l(
      [`${targetDeptName} ${execName}가 서브태스크 ${itemCount}건 일괄 작업을 시작했습니다.${worktreeCeoNote}`],
      [`${targetDeptName} ${execName} started one batched run for ${itemCount} subtasks.${worktreeCeoNote}`],
      [`${targetDeptName}の${execName}がサブタスク${itemCount}件の一括作業を開始しました。${worktreeCeoNote}`],
      [`${targetDeptName} 的 ${execName} 已开始 ${itemCount} 个 SubTask 的批量处理。${worktreeCeoNote}`],
    ),
    lang,
  );
}
