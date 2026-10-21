import { describe, expect, it } from "vitest";
import { buildVideoFinalRenderDescription, buildVideoFinalRenderTitle } from "./video-final-render.ts";

const HANGUL = /[가-힣ㄱ-ㆎ]/;

describe("video final render subtask copy", () => {
  it("keeps the original Korean wording", () => {
    expect(buildVideoFinalRenderTitle("ko")).toBe("[VIDEO_FINAL_RENDER] 최종 영상 렌더링");
    expect(buildVideoFinalRenderDescription("데모", "ko", { includeTextSanitizeRule: true })).toBe(
      [
        "[VIDEO_FINAL_RENDER]",
        "상위 업무: 데모",
        "모든 문서/협업 산출물을 취합해 최종 소개 영상을 1회 렌더링하세요.",
        "최종 렌더링 엔진은 반드시 Remotion만 사용하세요. Python(moviepy/Pillow) 기반 렌더링은 금지됩니다.",
        "산출물 경로 규칙(project_department_final.mp4)을 지키고, 결과 파일 경로/용량 검증을 보고하세요.",
        "",
        "[QUALITY]",
        "- 목표 길이 55~65초, 8~12 샷 이상 구성",
        "- 시작 2~4초는 브랜드/마스코트 키비주얼 인트로",
        "- 정적인 장면 3초 초과 금지, 샷별 모션(카메라/텍스트/레이아웃) 분리",
        "- 자막/텍스트 safe area(좌우 8%, 상하 10%) 준수",
        "- 화면 텍스트에서 \\n/\\t/백틱/마크다운 태그 문자 노출 금지 (정제 후 렌더)",
        "- 결과 보고에 초 단위 씬 타임라인과 품질 체크리스트 포함",
      ].join("\n"),
    );
    expect(buildVideoFinalRenderDescription("데모", "ko")).not.toContain("화면 텍스트");
  });

  it("produces English copy without Hangul and keeps the render marker", () => {
    const title = buildVideoFinalRenderTitle("en");
    const description = buildVideoFinalRenderDescription("Demo", "en", { includeTextSanitizeRule: true });
    expect(title).toBe("[VIDEO_FINAL_RENDER] Final video render");
    expect(title).not.toMatch(HANGUL);
    expect(description).not.toMatch(HANGUL);
    expect(description.startsWith("[VIDEO_FINAL_RENDER]\nParent task: Demo")).toBe(true);
  });
});
