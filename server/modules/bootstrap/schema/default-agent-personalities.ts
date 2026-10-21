import type { DatabaseSync } from "node:sqlite";
import { syncOfficePackLocales } from "./office-pack-localization.ts";

type DbLike = Pick<DatabaseSync, "prepare">;
type PersonalityLang = "ko" | "en" | "ja" | "zh";
type LocalizedPersonality = Record<PersonalityLang, string>;

const PERSONALITY_LANGS: readonly PersonalityLang[] = ["ko", "en", "ja", "zh"];

// Default seeded agent personalities. The ko text is the original seed value and must stay unchanged.
export const DEFAULT_AGENT_PERSONALITIES = {
  Aria: {
    ko: "꼼꼼한 시니어 개발자",
    en: "Meticulous senior developer",
    ja: "几帳面なシニア開発者",
    zh: "严谨细致的资深开发者",
  },
  Bolt: {
    ko: "빠른 코딩 전문가",
    en: "Fast coding specialist",
    ja: "高速コーディングのスペシャリスト",
    zh: "快速编码专家",
  },
  Nova: {
    ko: "창의적인 주니어",
    en: "Creative junior",
    ja: "クリエイティブなジュニア",
    zh: "富有创意的初级成员",
  },
  Pixel: {
    ko: "디자인 리더",
    en: "Design leader",
    ja: "デザインリーダー",
    zh: "设计负责人",
  },
  Luna: {
    ko: "감성적인 UI 디자이너",
    en: "Expressive UI designer",
    ja: "感性豊かなUIデザイナー",
    zh: "富有感性的 UI 设计师",
  },
  Sage: {
    ko: "전략 분석가",
    en: "Strategy analyst",
    ja: "戦略アナリスト",
    zh: "战略分析师",
  },
  Clio: {
    ko: "데이터 기반 기획자",
    en: "Data-driven planner",
    ja: "データドリブンなプランナー",
    zh: "数据驱动的策划者",
  },
  Atlas: {
    ko: "운영의 달인",
    en: "Operations master",
    ja: "運営の達人",
    zh: "运营达人",
  },
  Turbo: {
    ko: "자동화 전문가",
    en: "Automation specialist",
    ja: "自動化スペシャリスト",
    zh: "自动化专家",
  },
  Hawk: {
    ko: "날카로운 품질 감시자",
    en: "Sharp-eyed quality watchdog",
    ja: "鋭い目を持つ品質の番人",
    zh: "目光敏锐的质量把关者",
  },
  Lint: {
    ko: "꼼꼼한 테스트 전문가",
    en: "Meticulous testing specialist",
    ja: "几帳面なテストスペシャリスト",
    zh: "严谨细致的测试专家",
  },
  Vault: {
    ko: "보안 아키텍트",
    en: "Security architect",
    ja: "セキュリティアーキテクト",
    zh: "安全架构师",
  },
  Pipe: {
    ko: "CI/CD 파이프라인 전문가",
    en: "CI/CD pipeline specialist",
    ja: "CI/CDパイプラインスペシャリスト",
    zh: "CI/CD 流水线专家",
  },
  DORO: {
    ko: "꼼꼼한 품질관리 주니어",
    en: "Meticulous QA junior",
    ja: "几帳面な品質管理ジュニア",
    zh: "严谨细致的质量管理初级成员",
  },
} as const satisfies Record<string, LocalizedPersonality>;

function normalizePersonalityLang(value: unknown): PersonalityLang {
  const raw = typeof value === "string" ? value.trim().toLowerCase().slice(0, 2) : "";
  return (PERSONALITY_LANGS as readonly string[]).includes(raw) ? (raw as PersonalityLang) : "en";
}

export function readLanguageSetting(db: DbLike): PersonalityLang {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'language' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  const raw = typeof row?.value === "string" ? row.value : "";
  try {
    return normalizePersonalityLang(JSON.parse(raw));
  } catch {
    return normalizePersonalityLang(raw);
  }
}

/**
 * Rewrites agents that still carry a default seed personality into the target language.
 * Personalities the user edited (anything that is not an exact default in some language) are left untouched.
 */
export function syncDefaultAgentPersonalities(db: DbLike, language: unknown): number {
  const lang = normalizePersonalityLang(language);
  const update = db.prepare("UPDATE agents SET personality = ? WHERE personality IN (?, ?, ?, ?) AND personality <> ?");
  let changed = 0;
  for (const personality of Object.values(DEFAULT_AGENT_PERSONALITIES)) {
    const target = personality[lang];
    const result = update.run(target, personality.ko, personality.en, personality.ja, personality.zh, target);
    changed += Number(result.changes ?? 0);
  }
  syncOfficePackLocales(db, lang);
  return changed;
}
