import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkProjectPath, createProject, updateProject } from "../../api";
import type { ProjectManagerPathTools } from "./useProjectManagerPathTools";
import { useProjectSaveHandler } from "./useProjectSaveHandler";

vi.mock("../../api", () => ({
  checkProjectPath: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  isApiRequestError: vi.fn(() => false),
}));

describe("project review automation persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkProjectPath).mockResolvedValue({
      normalized_path: "/workspace/review",
      exists: true,
      is_directory: true,
      can_create: false,
      nearest_existing_parent: "/workspace",
    });
    vi.mocked(createProject).mockResolvedValue({ id: "project-1" } as Awaited<ReturnType<typeof createProject>>);
    vi.mocked(updateProject).mockResolvedValue({ id: "project-1" } as Awaited<ReturnType<typeof updateProject>>);
  });

  it.each([
    [null, null, null],
    [null, "on", "off"],
    ["project-1", "off", "on"],
    ["project-1", null, null],
  ] as const)("saves explicit and inherited overrides for %s (%s, %s)", async (editingProjectId, start, apply) => {
    const pathTools = {
      setFormFeedback: vi.fn(),
      resetPathHelperState: vi.fn(),
    } as unknown as ProjectManagerPathTools;
    const { result } = renderHook(() =>
      useProjectSaveHandler({
        canSave: true,
        saving: false,
        setSaving: vi.fn(),
        assignmentMode: "auto",
        mergePolicy: null,
        reviewAutomation: { review_auto_start: start, review_auto_apply: apply },
        getManualAssignmentWarning: () => null,
        setManualAssignmentWarning: vi.fn(),
        projectPath: "/workspace/review",
        setProjectPath: vi.fn(),
        pathTools,
        editingProjectId,
        name: "Review automation",
        coreGoal: "Start review automatically",
        selectedAgentIds: new Set(),
        loadProjects: vi.fn().mockResolvedValue(undefined),
        search: "",
        setSelectedProjectId: vi.fn(),
        setEditingProjectId: vi.fn(),
        setIsCreating: vi.fn(),
        t: (messages) => messages.en,
      }),
    );
    await act(async () => result.current());
    const payload = expect.objectContaining({
      review_auto_start: start,
      review_auto_apply: apply,
    });
    if (editingProjectId) {
      expect(updateProject).toHaveBeenCalledWith(editingProjectId, payload);
      expect(createProject).not.toHaveBeenCalled();
    } else {
      expect(createProject).toHaveBeenCalledWith(payload);
      expect(updateProject).not.toHaveBeenCalled();
    }
  });
});
