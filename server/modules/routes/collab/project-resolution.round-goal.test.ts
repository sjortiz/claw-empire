import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeProjectResolution } from "./project-resolution.ts";

const HANGUL = /[가-힣ㄱ-ㆎ]/;

describe("buildRoundGoal", () => {
  const db = new DatabaseSync(":memory:");
  const { buildRoundGoal } = initializeProjectResolution({ db });

  it("returns English round goals without Hangul when lang is en", () => {
    expect(buildRoundGoal("Ship v2", "Fix login", "en")).toBe(
      'Keep the project core goal ("Ship v2") while delivering this request ("Fix login") as actionable output in this round',
    );
    expect(buildRoundGoal(null, "Fix login", "en")).not.toMatch(HANGUL);
  });

  it("keeps the original Korean wording for ko and when lang is omitted", () => {
    const expected =
      '프로젝트 핵심목표("Ship v2")를 유지하면서 이번 요청("Fix login")을 이번 라운드에서 실행 가능한 산출물로 완수';
    expect(buildRoundGoal("Ship v2", "Fix login", "ko")).toBe(expected);
    expect(buildRoundGoal("Ship v2", "Fix login")).toBe(expected);
  });
});
