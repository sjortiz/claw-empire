export const REVIEW_AUTOMATION_SETTINGS = [
  {
    key: "reviewMeetingAutoStart",
    label: {
      ko: "리뷰 회의 자동 시작",
      en: "Start review meetings automatically",
      ja: "レビュー会議を自動で開始",
      zh: "自动启动评审会议",
    },
    help: {
      ko: "프로젝트 리뷰 조건이 충족되면 CEO 승인을 기다리지 않고 회의를 시작하며, 의사결정 수신함에 안내를 남깁니다. 프로젝트별로 재정의할 수 있습니다.",
      en: "Start the meeting when project review conditions are met, without waiting for CEO approval. An informational inbox item remains available. Projects can override this setting.",
      ja: "プロジェクトのレビュー条件が満たされると、CEO の承認を待たずに会議を開始し、意思決定受信箱に通知を残します。プロジェクトごとに上書きできます。",
      zh: "满足项目评审条件后，无需等待 CEO 批准即可启动会议，并在决策收件箱保留通知。可按项目覆盖此设置。",
    },
  },
  {
    key: "reviewItemsAutoApply",
    label: {
      ko: "모든 리뷰 항목 자동 적용",
      en: "Apply all review items automatically",
      ja: "すべてのレビュー項目を自動で適用",
      zh: "自动应用所有评审项",
    },
    help: {
      ko: "켜면 수정 항목 선택 시 모든 리뷰 항목을 적용합니다. 끄면 회의가 자동 시작되어도 항목 선택은 수동으로 유지됩니다. 프로젝트별로 재정의할 수 있습니다.",
      en: "Apply every review item at revision selection. When off, item selection stays manual even if meetings start automatically. Projects can override this setting.",
      ja: "修正項目の選択時にすべてのレビュー項目を適用します。無効の場合、会議が自動開始されても項目は手動で選択します。プロジェクトごとに上書きできます。",
      zh: "选择修订项时应用所有评审项。关闭后，即使会议自动启动，仍需手动选择项目。可按项目覆盖此设置。",
    },
  },
] as const;
