import type { WorkboardPlanningBoard } from "@openclaw/workboard-contract";

export class WorkboardPlanningConflictError extends Error {
  constructor(readonly current: WorkboardPlanningBoard) {
    super("Planning changed while you were editing. Reload the board and retry.");
    this.name = "WorkboardPlanningConflictError";
  }
}
