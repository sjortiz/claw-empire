import { describe, expect, it } from "vitest";
import { MESSENGER_CHANNELS } from "../../../types";
import type { Locale } from "../types";
import { channelTargetHint } from "./constants";

const pick = (locale: Locale) => (messages: Record<Locale, string>) => messages[locale];

describe("channelTargetHint", () => {
  it("returns English hints without Hangul when language is en", () => {
    for (const channel of MESSENGER_CHANNELS) {
      expect(channelTargetHint(channel, pick("en"))).not.toMatch(/[가-힣]/);
    }
    expect(channelTargetHint("imessage", pick("en"))).toBe("Phone number/email (macOS Messages)");
  });

  it("keeps Korean hints when language is ko", () => {
    expect(channelTargetHint("imessage", pick("ko"))).toBe("전화번호/이메일 (macOS Messages)");
    expect(channelTargetHint("telegram", pick("ko"))).toBe("chat_id");
  });
});
