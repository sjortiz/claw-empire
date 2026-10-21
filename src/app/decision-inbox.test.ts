import { describe, expect, it } from "vitest";
import type { DecisionInboxRouteItem } from "../api";
import { mapWorkflowDecisionItemsLocalized } from "./decision-inbox";

const notice: DecisionInboxRouteItem = {
  id: "review-auto-started:n1",
  kind: "review_auto_started",
  created_at: 1,
  summary: "Review meeting started automatically",
  project_id: "project-1",
  project_name: "Empire",
  project_path: "/project",
  task_id: "task-1",
  task_title: "Backend",
  options: [{ number: 1, action: "acknowledge_review_auto_start" }],
};

describe("review auto-start notice items", () => {
  it.each([
    ["en", "Acknowledge"],
    ["ko", "확인"],
    ["ja", "確認"],
    ["zh", "确认"],
  ])("shows the project and a localized acknowledge option in %s", (language, label) => {
    const [item] = mapWorkflowDecisionItemsLocalized([notice], language);
    expect(item).toMatchObject({
      kind: "review_auto_started",
      agentName: "Empire",
      projectId: "project-1",
      options: [{ number: 1, label, action: "acknowledge_review_auto_start" }],
    });
  });
});
