import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { hasWorkboardRejection, rejectWorkboardIdea } from "../../lib/workboard/rejection.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { canMutate, type WorkboardProps } from "./view-helpers.ts";

type RejectionState = { open: boolean; reason: string; detail: string; error: string | null };
const states = new WeakMap<object, Map<string, RejectionState>>();

export function renderWorkboardRejection(props: WorkboardProps, card: WorkboardCard) {
  if (card.status !== "triage") {
    return nothing;
  }
  const rejected = hasWorkboardRejection(card);
  if (card.metadata?.archivedAt) {
    return rejected ? html`<p role="status">${t("workboard.rejectionSaved")}</p>` : nothing;
  }
  let cards = states.get(props.host);
  if (!cards) {
    cards = new Map();
    states.set(props.host, cards);
  }
  let draft = cards.get(card.id);
  if (!draft) {
    draft = { open: false, reason: "", detail: "", error: null };
    cards.set(card.id, draft);
  }
  const state = draft;
  const boardState = getWorkboardState(props.host);
  const busy = boardState.dispatching || boardState.busyCardIds.has(card.id);
  const disabled = !props.connected || !props.client || !canMutate(props) || busy;
  const reasons = [
    ["uninteresting", t("workboard.rejectionUninteresting")],
    ["unprofitable", t("workboard.rejectionUnprofitable")],
    ["other", t("workboard.rejectionOther")],
  ];
  const reasonLabel = reasons.find(([value]) => value === state.reason)?.[1];
  const submit = async () => {
    if (
      disabled ||
      !props.client ||
      (!rejected && (!reasonLabel || (state.reason === "other" && !state.detail.trim())))
    ) {
      return;
    }
    state.error = null;
    try {
      await rejectWorkboardIdea({
        host: props.host,
        client: props.client,
        card,
        reason:
          `${t("workboard.rejectionHeading")}: ${reasonLabel ?? ""}\n${state.detail.trim()}`.trim(),
        requestUpdate: props.onRequestUpdate,
      });
      state.open = false;
    } catch (error) {
      state.error = formatUiError(error, t("workboard.rejectionFailed"));
    }
    props.onRequestUpdate?.();
  };
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.rejectionHeading")}</h3>
      ${state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}
      ${
        rejected
          ? html`
              <p>${t("workboard.rejectionArchivePending")}</p>
              <button class="btn" type="button" ?disabled=${disabled} @click=${() => void submit()}>
                ${t("workboard.rejectionRetryArchive")}
              </button>
            `
          : html`
              <button
                class="btn"
                type="button"
                ?disabled=${disabled}
                aria-expanded=${state.open}
                @click=${() => {
                  state.open = !state.open;
                  props.onRequestUpdate?.();
                }}
              >
                ${t("workboard.rejectIdea")}
              </button>
              ${
                state.open
                  ? html`
                      <p>${t("workboard.rejectionDescription")}</p>
                      <label class="workboard-field">
                        <span>${t("workboard.rejectionReason")}</span>
                        <select
                          class="settings-select workboard-native-select"
                          .value=${state.reason}
                          ?disabled=${disabled}
                          @change=${(event: Event) => {
                            // SAFETY: the handler belongs to this select.
                            state.reason = (event.currentTarget as HTMLSelectElement).value;
                            props.onRequestUpdate?.();
                          }}
                        >
                          <option value="">${t("workboard.rejectionChoose")}</option>
                          ${reasons.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
                        </select>
                      </label>
                      <label class="workboard-field">
                        <span
                          >${state.reason === "other" ? t("workboard.rejectionDetailRequired") : t("workboard.rejectionDetail")}</span
                        >
                        <textarea
                          class="input workboard-detail__note"
                          rows="3"
                          maxlength="1200"
                          .value=${state.detail}
                          ?disabled=${disabled}
                          @input=${(event: Event) => {
                            // SAFETY: the handler belongs to this textarea.
                            state.detail = (event.currentTarget as HTMLTextAreaElement).value;
                            props.onRequestUpdate?.();
                          }}
                        ></textarea>
                      </label>
                      <button
                        class="btn danger"
                        type="button"
                        ?disabled=${disabled || !reasonLabel || (state.reason === "other" && !state.detail.trim())}
                        @click=${() => void submit()}
                      >
                        ${t("workboard.rejectionConfirm")}
                      </button>
                    `
                  : nothing
              }
            `
      }
    </section>
  `;
}
