import type { Lang } from "../../../types/lang.ts";

// The "[VIDEO_FINAL_RENDER]" marker is matched by title/description elsewhere; keep it in every language.
const VIDEO_FINAL_RENDER_TITLE: Record<Lang, string> = {
  ko: "[VIDEO_FINAL_RENDER] 최종 영상 렌더링",
  en: "[VIDEO_FINAL_RENDER] Final video render",
  ja: "[VIDEO_FINAL_RENDER] 最終動画レンダリング",
  zh: "[VIDEO_FINAL_RENDER] 最终视频渲染",
};

const VIDEO_FINAL_RENDER_BODY: Record<Lang, (taskTitle: string) => string[]> = {
  ko: (taskTitle) => [
    `상위 업무: ${taskTitle}`,
    "모든 문서/협업 산출물을 취합해 최종 소개 영상을 1회 렌더링하세요.",
    "최종 렌더링 엔진은 반드시 Remotion만 사용하세요. Python(moviepy/Pillow) 기반 렌더링은 금지됩니다.",
    "산출물 경로 규칙(project_department_final.mp4)을 지키고, 결과 파일 경로/용량 검증을 보고하세요.",
  ],
  en: (taskTitle) => [
    `Parent task: ${taskTitle}`,
    "Collect all documents and collaboration outputs and render the final intro video once.",
    "The final rendering engine must be Remotion only. Python (moviepy/Pillow) rendering is prohibited.",
    "Follow the output path rule (project_department_final.mp4) and report the result file path/size check.",
  ],
  ja: (taskTitle) => [
    `上位タスク: ${taskTitle}`,
    "すべての文書/協業成果物を取りまとめ、最終紹介動画を1回レンダリングしてください。",
    "最終レンダリングエンジンは必ず Remotion のみを使用してください。Python(moviepy/Pillow) ベースのレンダリングは禁止です。",
    "成果物パス規則(project_department_final.mp4)を守り、結果ファイルのパス/サイズ検証を報告してください。",
  ],
  zh: (taskTitle) => [
    `上级任务: ${taskTitle}`,
    "汇总所有文档/协作产出物，渲染一次最终介绍视频。",
    "最终渲染引擎必须只使用 Remotion。禁止基于 Python(moviepy/Pillow) 的渲染。",
    "遵守产出物路径规则(project_department_final.mp4)，并报告结果文件路径/大小的校验。",
  ],
};

const VIDEO_FINAL_RENDER_QUALITY: Record<Lang, string[]> = {
  ko: [
    "- 목표 길이 55~65초, 8~12 샷 이상 구성",
    "- 시작 2~4초는 브랜드/마스코트 키비주얼 인트로",
    "- 정적인 장면 3초 초과 금지, 샷별 모션(카메라/텍스트/레이아웃) 분리",
    "- 자막/텍스트 safe area(좌우 8%, 상하 10%) 준수",
  ],
  en: [
    "- Target length 55-65 seconds, at least 8-12 shots",
    "- First 2-4 seconds: brand/mascot key-visual intro",
    "- No static scene longer than 3 seconds; separate motion per shot (camera/text/layout)",
    "- Keep subtitles/text inside the safe area (8% horizontal, 10% vertical)",
  ],
  ja: [
    "- 目標尺 55~65秒、8~12ショット以上で構成",
    "- 冒頭2~4秒はブランド/マスコットのキービジュアルイントロ",
    "- 静止シーンは3秒以内、ショットごとにモーション(カメラ/テキスト/レイアウト)を分離",
    "- 字幕/テキストは safe area(左右8%、上下10%)を遵守",
  ],
  zh: [
    "- 目标时长 55~65 秒，至少 8~12 个镜头",
    "- 开头 2~4 秒为品牌/吉祥物主视觉开场",
    "- 静态画面不超过 3 秒，按镜头区分运动(镜头/文字/布局)",
    "- 字幕/文字遵守 safe area(左右 8%，上下 10%)",
  ],
};

const VIDEO_FINAL_RENDER_TEXT_SANITIZE: Record<Lang, string> = {
  ko: "- 화면 텍스트에서 \\n/\\t/백틱/마크다운 태그 문자 노출 금지 (정제 후 렌더)",
  en: "- Never show \\n/\\t/backticks/markdown tokens in on-screen text (sanitize before rendering)",
  ja: "- 画面テキストに \\n/\\t/バッククォート/マークダウン記号を表示しない (整形してからレンダリング)",
  zh: "- 画面文字中禁止出现 \\n/\\t/反引号/markdown 标记字符 (清洗后再渲染)",
};

const VIDEO_FINAL_RENDER_TIMELINE: Record<Lang, string> = {
  ko: "- 결과 보고에 초 단위 씬 타임라인과 품질 체크리스트 포함",
  en: "- Include a second-by-second scene timeline and a quality checklist in the result report",
  ja: "- 結果報告に秒単位のシーンタイムラインと品質チェックリストを含める",
  zh: "- 结果报告中包含按秒的场景时间线和质量检查清单",
};

function resolveLang(lang: string): Lang {
  return lang === "ko" || lang === "ja" || lang === "zh" ? lang : "en";
}

export function buildVideoFinalRenderTitle(lang: string): string {
  return VIDEO_FINAL_RENDER_TITLE[resolveLang(lang)];
}

export function buildVideoFinalRenderDescription(
  taskTitle: string,
  lang: string,
  options: { includeTextSanitizeRule?: boolean } = {},
): string {
  const resolved = resolveLang(lang);
  return [
    "[VIDEO_FINAL_RENDER]",
    ...VIDEO_FINAL_RENDER_BODY[resolved](taskTitle),
    "",
    "[QUALITY]",
    ...VIDEO_FINAL_RENDER_QUALITY[resolved],
    ...(options.includeTextSanitizeRule ? [VIDEO_FINAL_RENDER_TEXT_SANITIZE[resolved]] : []),
    VIDEO_FINAL_RENDER_TIMELINE[resolved],
  ].join("\n");
}
