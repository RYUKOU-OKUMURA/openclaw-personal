import type {
  WorkboardPlanningBoard,
  WorkboardPlanningColumn,
  WorkboardPlanningMove,
  WorkboardPlanningUpdate,
} from "@openclaw/workboard-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";

type PlanningClient = Pick<GatewayBrowserClient, "request">;
export type PlanningUiState = {
  boardId: string | null;
  data: WorkboardPlanningBoard | null;
  draft: WorkboardPlanningColumn[] | null;
  deletedColumnDestinations: Record<string, string>;
  error: string | null;
  loading: boolean;
  saving: boolean;
  mode: "execution" | "planning";
  canWrite: boolean;
  ready: boolean;
  needsReload: boolean;
};
type PlanningContext = {
  state: PlanningUiState;
  client: PlanningClient | null;
  boardId: string | null;
  onUpdate: () => void;
  modeInitialized: boolean;
  load: Promise<void> | null;
  pendingRefresh: boolean;
};

// This cache and edit draft belong to one mounted view. SQLite remains authoritative.
const contexts = new WeakMap<object, PlanningContext>();

function context(host: object): PlanningContext {
  let value = contexts.get(host);
  if (!value) {
    value = {
      state: {
        boardId: null,
        data: null,
        draft: null,
        deletedColumnDestinations: {},
        error: null,
        loading: false,
        saving: false,
        mode: "execution",
        canWrite: false,
        ready: false,
        needsReload: false,
      },
      client: null,
      boardId: null,
      onUpdate: () => {},
      modeInitialized: false,
      load: null,
      pendingRefresh: false,
    };
    contexts.set(host, value);
  }
  return value;
}

function notify(value: PlanningContext) {
  value.state.ready = Boolean(
    value.client &&
    value.boardId &&
    value.state.data &&
    !value.state.loading &&
    !value.state.saving &&
    !value.state.needsReload,
  );
  value.onUpdate();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getPlanningState(host: object): PlanningUiState {
  return context(host).state;
}

export function syncPlanningContext(
  host: object,
  client: PlanningClient | null,
  boardId: string | null,
  onUpdate: () => void,
  canWrite: boolean,
): void {
  let value = context(host);
  if (value.client !== client || value.boardId !== boardId) {
    contexts.delete(host);
    value = context(host);
    value.client = client;
    value.boardId = boardId;
    value.state.boardId = boardId;
  }
  value.onUpdate = onUpdate;
  value.state.canWrite = canWrite;
  if (client && boardId && !value.state.data && !value.load && !value.state.error) {
    void refreshPlanning(host);
  }
}

export async function refreshPlanning(
  host: object,
  options: { discardDraft?: boolean } = {},
): Promise<void> {
  const value = context(host);
  const { state, client, boardId } = value;
  value.pendingRefresh = true;
  if (!client || !boardId || state.saving) {
    return;
  }
  if (options.discardDraft) {
    state.draft = null;
    state.deletedColumnDestinations = {};
  } else if (state.draft || state.needsReload) {
    return;
  }
  if (value.load) {
    return value.load;
  }
  state.loading = true;
  state.error = null;
  const load = async () => {
    // Calls queued before this request starts are covered by this same GET.
    value.pendingRefresh = false;
    try {
      const result = await client.request<{ planning: WorkboardPlanningBoard }>(
        "workboard.planning.get",
        { boardId },
      );
      if (contexts.get(host) !== value) {
        return;
      }
      if (result.planning.boardId !== boardId) {
        throw new Error(t("workboard.planning.responseMismatch"));
      }
      state.data = result.planning;
      state.needsReload = false;
      if (!value.modeInitialized) {
        state.mode = result.planning.revision > 0 ? "planning" : "execution";
        value.modeInitialized = true;
      }
    } catch (error) {
      if (contexts.get(host) === value) {
        state.error = errorMessage(error);
      }
    } finally {
      if (contexts.get(host) === value) {
        state.loading = false;
        value.load = null;
        notify(value);
        if (value.pendingRefresh && !state.draft && !state.needsReload) {
          await refreshPlanning(host);
        }
      }
    }
  };
  value.load = Promise.resolve().then(load);
  notify(value);
  return value.load;
}

export function disposePlanning(host: object): void {
  contexts.delete(host);
}

export function setPlanningMode(host: object, mode: PlanningUiState["mode"]): void {
  const value = context(host);
  value.state.mode = mode;
  value.modeInitialized = true;
  notify(value);
}

export function beginPlanningEdit(host: object): void {
  const value = context(host);
  if (!value.state.canWrite || !value.state.ready || value.state.draft) {
    return;
  }
  value.state.draft = value.state.data!.columns.map((column) => Object.assign({}, column));
  value.state.deletedColumnDestinations = {};
  value.state.error = null;
  notify(value);
}

export async function cancelPlanningEdit(host: object): Promise<void> {
  await refreshPlanning(host, { discardDraft: true });
}

async function writePlanning(
  host: object,
  method: "workboard.planning.update" | "workboard.planning.move",
  params: WorkboardPlanningUpdate | WorkboardPlanningMove,
): Promise<boolean> {
  const value = context(host);
  const { state, client } = value;
  if (!client || !state.canWrite || !state.ready) {
    return false;
  }
  state.saving = true;
  state.error = null;
  notify(value);
  try {
    const result = await client.request<{ planning: WorkboardPlanningBoard }>(method, params);
    if (contexts.get(host) !== value) {
      return false;
    }
    if (result.planning.boardId !== value.boardId) {
      throw new Error(t("workboard.planning.responseMismatch"));
    }
    state.data = result.planning;
    state.draft = null;
    state.deletedColumnDestinations = {};
    return true;
  } catch (error) {
    if (contexts.get(host) === value) {
      // A failure may be a CAS conflict or an unknown write result. Never auto-rebase/retry.
      state.needsReload = true;
      state.error = `${errorMessage(error)} ${t("workboard.planning.reloadRequired")}`;
    }
    return false;
  } finally {
    if (contexts.get(host) === value) {
      state.saving = false;
      notify(value);
      if (value.pendingRefresh && !state.draft && !state.needsReload) {
        await refreshPlanning(host);
      }
    }
  }
}

export async function savePlanningColumns(host: object): Promise<boolean> {
  const { state, boardId } = context(host);
  if (!boardId || !state.data || !state.draft) {
    return false;
  }
  const remainingIds = new Set(state.draft.map((column) => column.id));
  const deletedIds = new Set(
    state.data.columns.filter((column) => !remainingIds.has(column.id)).map((column) => column.id),
  );
  return writePlanning(host, "workboard.planning.update", {
    boardId,
    expectedRevision: state.data.revision,
    columns: state.draft.map((column) => Object.assign({}, column)),
    deletedColumnDestinations: Object.fromEntries(
      Object.entries(state.deletedColumnDestinations).filter(([id]) => deletedIds.has(id)),
    ),
  });
}

export async function movePlanningCard(
  host: object,
  cardId: string,
  columnId: string,
  order: number,
): Promise<boolean> {
  const { state, boardId } = context(host);
  if (!boardId || !state.data || state.draft) {
    return false;
  }
  return writePlanning(host, "workboard.planning.move", {
    boardId,
    expectedRevision: state.data.revision,
    cardId,
    columnId,
    order,
  });
}

export async function resizePlanningColumn(
  host: object,
  columnId: string,
  width: number,
): Promise<boolean> {
  const { state, boardId } = context(host);
  if (!boardId || !state.data || state.draft) {
    return false;
  }
  if (!state.data.columns.some((column) => column.id === columnId)) {
    return false;
  }
  return writePlanning(host, "workboard.planning.update", {
    boardId,
    expectedRevision: state.data.revision,
    columns: state.data.columns.map((column) =>
      Object.assign({}, column, { width: column.id === columnId ? width : column.width }),
    ),
  });
}
