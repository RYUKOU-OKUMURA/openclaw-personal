import type { ModelChoice, ModelsListResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { discussWorkboardCard, discussionSessionKey } from "../../lib/workboard/discussion.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { canMutate, type WorkboardProps } from "./view-helpers.ts";

const PREFERRED_MODEL = "openai/gpt-5.6-luna";

type DiscussionUiState = {
  open: boolean;
  loading: boolean;
  loadedAgentId: string | null;
  models: ModelChoice[];
  selectedModel: string;
  submitting: boolean;
  error: string | null;
  recoverySessionKey: string | null;
};

const discussionStates = new WeakMap<object, Map<string, DiscussionUiState>>();

function getDiscussionState(host: object, cardId: string): DiscussionUiState {
  let states = discussionStates.get(host);
  if (!states) {
    states = new Map();
    discussionStates.set(host, states);
  }
  let state = states.get(cardId);
  if (!state) {
    state = {
      open: false,
      loading: false,
      loadedAgentId: null,
      models: [],
      selectedModel: "",
      submitting: false,
      error: null,
      recoverySessionKey: null,
    };
    states.set(cardId, state);
  }
  return state;
}

function discussionAgentId(props: WorkboardProps, card: WorkboardCard): string {
  return (
    card.agentId?.trim() ||
    props.agentsList?.defaultId?.trim() ||
    props.defaultAgentId?.trim() ||
    "main"
  );
}

function isModelChoice(value: unknown): value is ModelChoice {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: value is an object; each consumed field is validated below.
  const candidate = value as Partial<ModelChoice>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.provider === "string" &&
    candidate.id.trim() !== "" &&
    candidate.provider.trim() !== "" &&
    candidate.available !== false &&
    !candidate.unavailableReason
  );
}

function modelValue(model: Pick<ModelChoice, "provider" | "id">): string {
  return `${model.provider.trim()}/${model.id.trim()}`;
}

function normalizedModelValue(value: string): string {
  return value.trim().toLowerCase();
}

function preferredModel(models: readonly ModelChoice[]): ModelChoice | undefined {
  const preferred = normalizedModelValue(PREFERRED_MODEL);
  return models.find((model) => normalizedModelValue(modelValue(model)) === preferred);
}

function modelLabel(model: ModelChoice): string {
  const name = model.name.trim();
  return name || modelValue(model);
}

function availableModels(result: ModelsListResult | null | undefined): ModelChoice[] {
  if (!Array.isArray(result?.models)) {
    return [];
  }
  const seen = new Set<string>();
  return result.models.filter((model) => {
    if (!isModelChoice(model)) {
      return false;
    }
    const value = normalizedModelValue(modelValue(model));
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

async function loadDiscussionModels(
  props: WorkboardProps,
  card: WorkboardCard,
  state: DiscussionUiState,
) {
  const client = props.client;
  if (!client || !props.connected || state.loading) {
    return;
  }
  const agentId = discussionAgentId(props, card);
  if (state.loadedAgentId === agentId) {
    return;
  }
  state.models = [];
  state.selectedModel = "";
  state.loadedAgentId = null;
  state.loading = true;
  state.error = null;
  props.onRequestUpdate?.();
  try {
    const result = await client.request<ModelsListResult>("models.list", {
      view: "configured",
      agentId,
      preparedOnly: true,
    });
    const models = availableModels(result);
    state.models = models;
    const preferred = preferredModel(models);
    state.loadedAgentId = models.length ? agentId : null;
    if (preferred) {
      state.selectedModel = modelValue(preferred);
    } else {
      state.selectedModel = "";
      state.error = models.length
        ? t("workboard.discussionPreferredModelUnavailable")
        : t("workboard.discussionNoModels");
    }
  } catch (error) {
    state.error = formatUiError(error, t("workboard.discussionModelsLoadFailed"));
  } finally {
    state.loading = false;
    props.onRequestUpdate?.();
  }
}

function openDiscussion(props: WorkboardProps, card: WorkboardCard, state: DiscussionUiState) {
  const linked = discussionSessionKey(card);
  if (linked) {
    props.onOpenSession({ sessionKey: linked });
    return;
  }
  state.open = !state.open;
  state.error = null;
  props.onRequestUpdate?.();
  if (state.open && state.loadedAgentId !== discussionAgentId(props, card)) {
    void loadDiscussionModels(props, card, state);
  }
}

async function submitDiscussion(
  props: WorkboardProps,
  card: WorkboardCard,
  state: DiscussionUiState,
) {
  if (
    state.submitting ||
    !props.client ||
    !props.connected ||
    !state.selectedModel ||
    state.loadedAgentId !== discussionAgentId(props, card) ||
    state.recoverySessionKey
  ) {
    return;
  }
  state.submitting = true;
  state.error = null;
  props.onRequestUpdate?.();
  try {
    const preferred =
      normalizedModelValue(state.selectedModel) === normalizedModelValue(PREFERRED_MODEL);
    const key = await discussWorkboardCard({
      host: props.host,
      client: props.client,
      card,
      agentId: discussionAgentId(props, card),
      model: state.selectedModel,
      onUnlinkedSession: (unlinkedKey) => {
        state.recoverySessionKey = unlinkedKey;
      },
      ...(preferred ? { thinkingLevel: "max", fastMode: true } : {}),
      requestUpdate: props.onRequestUpdate,
    });
    if (key) {
      state.open = false;
      props.onOpenSession({ sessionKey: key });
    } else {
      state.error = getWorkboardState(props.host).error ?? t("workboard.discussionStartFailed");
    }
  } catch (error) {
    state.error = formatUiError(error, t("workboard.discussionStartFailed"));
  } finally {
    state.submitting = false;
    props.onRequestUpdate?.();
  }
}

function renderDiscussionSettings(
  props: WorkboardProps,
  card: WorkboardCard,
  state: DiscussionUiState,
) {
  if (!state.open || discussionSessionKey(card)) {
    return nothing;
  }
  return html`
    <div class="workboard-discussion__settings">
      <p>${t("workboard.discussionDescription")}</p>
      ${
        state.loading
          ? html`<p role="status">${t("workboard.discussionLoadingModels")}</p>`
          : nothing
      }
      ${
        state.models.length
          ? html`
              <label class="workboard-field">
                <span>${t("workboard.discussionModel")}</span>
                <select
                  class="settings-select workboard-native-select"
                  aria-label=${t("workboard.discussionModel")}
                  .value=${state.selectedModel}
                  ?disabled=${state.loading || state.submitting}
                  @change=${(event: Event) => {
                    // SAFETY: this change handler is attached directly to the select element.
                    const value = (event.currentTarget as HTMLSelectElement).value;
                    state.selectedModel = value;
                    state.error = null;
                    props.onRequestUpdate?.();
                  }}
                >
                  <option
                    value=""
                    ?selected=${state.selectedModel === ""}
                    .selected=${state.selectedModel === ""}
                  >
                    ${t("workboard.discussionChooseModel")}
                  </option>
                  ${state.models.map(
                    (entry) => html`
                      <option
                        value=${modelValue(entry)}
                        ?selected=${modelValue(entry) === state.selectedModel}
                        .selected=${modelValue(entry) === state.selectedModel}
                      >
                        ${modelLabel(entry)} (${entry.provider})
                      </option>
                    `,
                  )}
                </select>
              </label>
              <button
                class="btn"
                type="button"
                aria-label=${t("workboard.discussionStart")}
                ?disabled=${state.loading || state.submitting || !state.selectedModel || Boolean(state.recoverySessionKey) || state.loadedAgentId !== discussionAgentId(props, card)}
                @click=${() => void submitDiscussion(props, card, state)}
              >
                ${icons.messageSquare} <span>${t("workboard.discussionStart")}</span>
              </button>
            `
          : nothing
      }
    </div>
  `;
}

export function renderWorkboardDiscussion(props: WorkboardProps, card: WorkboardCard) {
  const linked = discussionSessionKey(card);
  if (card.metadata?.archivedAt && !linked) {
    return nothing;
  }
  const state = getDiscussionState(props.host, card.id);
  const recoverySessionKey = state.recoverySessionKey;
  const label = linked ? t("workboard.discussionContinue") : t("workboard.discussCard");
  return html`
    <section class="workboard-detail__section workboard-discussion">
      <h3>${t("workboard.discussionTitle")}</h3>
      <button
        class="btn"
        type="button"
        aria-label=${label}
        ?disabled=${
          state.submitting ||
          (!linked && Boolean(state.recoverySessionKey)) ||
          (!linked &&
            (!props.connected || !props.client || props.canWrite === false || !canMutate(props)))
        }
        @click=${() => openDiscussion(props, card, state)}
      >
        ${icons.messageSquare} <span>${label}</span>
      </button>
      ${state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      ${
        recoverySessionKey && !linked
          ? html`<button
              class="btn"
              type="button"
              aria-label=${t("workboard.discussionOpenCreated")}
              @click=${() => props.onOpenSession({ sessionKey: recoverySessionKey })}
            >
              ${t("workboard.discussionOpenCreated")}
            </button>`
          : nothing
      }
      ${renderDiscussionSettings(props, card, state)}
    </section>
  `;
}
