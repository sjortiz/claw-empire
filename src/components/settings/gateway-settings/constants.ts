import { WORKFLOW_PACK_KEYS, type MessengerChannelType, type WorkflowPackKey } from "../../../types";
import type { Locale, TFunction } from "../types";

export const CHANNEL_META: Record<
  MessengerChannelType,
  {
    label: string;
    targetHint: string | Record<Locale, string>;
    transportReady: boolean;
  }
> = {
  telegram: { label: "Telegram", targetHint: "chat_id", transportReady: true },
  whatsapp: {
    label: "WhatsApp",
    targetHint: {
      ko: "phone_number_id:recipient (예: 1234567890:+8210...)",
      en: "phone_number_id:recipient (e.g. 1234567890:+8210...)",
      ja: "phone_number_id:recipient (例: 1234567890:+8210...)",
      zh: "phone_number_id:recipient (例如: 1234567890:+8210...)",
    },
    transportReady: true,
  },
  discord: { label: "Discord", targetHint: "channel_id", transportReady: true },
  googlechat: {
    label: "Google Chat",
    targetHint: {
      ko: "spaces/AAA... (token은 webhook URL 또는 key|token)",
      en: "spaces/AAA... (token is a webhook URL or key|token)",
      ja: "spaces/AAA... (token は webhook URL または key|token)",
      zh: "spaces/AAA... (token 为 webhook URL 或 key|token)",
    },
    transportReady: true,
  },
  slack: { label: "Slack", targetHint: "channel_id", transportReady: true },
  signal: { label: "Signal", targetHint: "+8210..., group:<id>, username:<id>", transportReady: true },
  imessage: {
    label: "iMessage",
    targetHint: {
      ko: "전화번호/이메일 (macOS Messages)",
      en: "Phone number/email (macOS Messages)",
      ja: "電話番号/メール (macOS Messages)",
      zh: "电话号码/邮箱 (macOS Messages)",
    },
    transportReady: true,
  },
};

const WORKFLOW_PACK_KEY_SET = new Set<string>(WORKFLOW_PACK_KEYS as readonly string[]);

export function isWorkflowPackKey(value: unknown): value is WorkflowPackKey {
  return typeof value === "string" && WORKFLOW_PACK_KEY_SET.has(value);
}

export function channelTargetHint(channel: MessengerChannelType, t: TFunction): string {
  const hint = CHANNEL_META[channel].targetHint;
  return typeof hint === "string" ? hint : t(hint);
}
