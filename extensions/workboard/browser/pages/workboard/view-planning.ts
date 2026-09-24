import type { WorkboardPlanningColumn } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { t } from "../../i18n/index.ts";
import { getWorkboardState, type WorkboardCard } from "../../lib/workboard/index.ts";
import {
  getPlanningState,
  setPlanningMode,
  beginPlanningEdit,
  cancelPlanningEdit,
  savePlanningColumns,
  movePlanningCard,
  resizePlanningColumn,
  refreshPlanning,
} from "../../lib/workboard/planning.ts";
import { renderCard } from "./view-card.ts";
import { canMutate, type WorkboardProps } from "./view-helpers.ts";

const label = (key: string) => t(`workboard.planning.${key}`);
const clampWidth = (width: number) => Math.max(200, Math.min(800, Math.round(width)));

function editable(props: WorkboardProps) {
  const state = getPlanningState(props.host);
  return (
    props.connected &&
    Boolean(props.client) &&
    canMutate(props) &&
    state.ready &&
    state.canWrite &&
    !state.saving &&
    !state.loading
  );
}

export function renderPlanningToolbar(props: WorkboardProps) {
  const state = getPlanningState(props.host);
  if (!state.boardId) {
    return nothing;
  }
  return html`
    <div class="workboard-planning-toolbar">
      <div class="workboard-layout-toggle" role="group" aria-label=${label("view")}>
        ${(["planning", "execution"] as const).map(
          (mode) => html`
            <button
              type="button"
              class="btn ${state.mode === mode ? "active" : ""}"
              aria-pressed=${state.mode === mode}
              ?disabled=${state.saving || Boolean(state.draft)}
              @click=${() => setPlanningMode(props.host, mode)}
            >
              ${label(mode)}
            </button>
          `,
        )}
      </div>
      <span class="workboard-planning-hint">${label("hint")}</span>
      ${
        state.mode === "planning"
          ? html`
              <button
                type="button"
                class="btn"
                ?disabled=${!editable(props) || !state.data || Boolean(state.draft)}
                @click=${() => beginPlanningEdit(props.host)}
              >
                ${label("edit")}
              </button>
            `
          : nothing
      }
    </div>
    ${
      state.error
        ? html`<div class="callout danger" role="alert">
            ${state.error}
            <button
              type="button"
              class="btn"
              ?disabled=${state.saving || state.loading}
              @click=${() => refreshPlanning(props.host, { discardDraft: true })}
            >
              ${label("reload")}
            </button>
          </div>`
        : nothing
    }
    ${state.draft ? renderEditor(props) : nothing}
  `;
}

function renderEditor(props: WorkboardProps) {
  const state = getPlanningState(props.host);
  const columns = state.draft!;
  const changed = () => props.onRequestUpdate?.();
  const reorder = (index: number, delta: number) => {
    const current = columns[index];
    const next = columns[index + delta];
    if (!current || !next) {
      return;
    }
    [columns[index], columns[index + delta]] = [next, current];
    columns.forEach((column, order) => {
      column.order = order;
    });
    changed();
  };
  const valid = columns.every(
    (column) =>
      column.name.trim().length > 0 &&
      column.name.length <= 80 &&
      Number.isFinite(column.width) &&
      column.width >= 200 &&
      column.width <= 800,
  );
  return html`
    <section class="workboard-planning-editor" aria-label=${label("edit")}>
      <p>${label("editHint")}</p>
      <fieldset ?disabled=${!editable(props)}>
        ${repeat(
          columns,
          (column) => column.id,
          (column, index) => html`
            <div class="workboard-planning-editor__row">
              <label
                >${label("name")}<input
                  class="input"
                  maxlength="80"
                  .value=${column.name}
                  @input=${(event: InputEvent) => {
                    column.name = (event.currentTarget as HTMLInputElement).value;
                    changed();
                  }}
              /></label>
              <label
                >${label("width")}<input
                  class="input"
                  type="number"
                  min="200"
                  max="800"
                  step="10"
                  .value=${String(column.width)}
                  @input=${(event: InputEvent) => {
                    column.width = (event.currentTarget as HTMLInputElement).valueAsNumber;
                    changed();
                  }}
              /></label>
              <button
                type="button"
                class="btn"
                aria-label=${label("left")}
                ?disabled=${index === 0}
                @click=${() => reorder(index, -1)}
              >
                ←
              </button>
              <button
                type="button"
                class="btn"
                aria-label=${label("right")}
                ?disabled=${index === columns.length - 1}
                @click=${() => reorder(index, 1)}
              >
                →
              </button>
              ${
                column.id === "inbox"
                  ? html`<span class="workboard-planning-hint">${label("inboxHint")}</span>`
                  : html`
                      <label
                        >${label("deleteTo")}<select
                          class="input"
                          aria-label=${`${label("deleteTo")}: ${column.name}`}
                          .value=${state.deletedColumnDestinations[column.id] ?? ""}
                          @change=${(event: Event) => {
                            state.deletedColumnDestinations[column.id] = (
                              event.currentTarget as HTMLSelectElement
                            ).value;
                            changed();
                          }}
                        >
                          <option value="">${label("chooseDestination")}</option>
                          ${columns.filter((target) => target.id !== column.id).map((target) => html`<option value=${target.id}>${target.name}</option>`)}
                        </select></label
                      >
                      <button
                        type="button"
                        class="btn"
                        ?disabled=${!state.deletedColumnDestinations[column.id]}
                        @click=${() => {
                          const destination = state.deletedColumnDestinations[column.id];
                          if (!destination) {
                            return;
                          }
                          for (const id of Object.keys(state.deletedColumnDestinations)) {
                            if (state.deletedColumnDestinations[id] === column.id) {
                              state.deletedColumnDestinations[id] = destination;
                            }
                          }
                          state.draft = columns.filter((item) => item.id !== column.id);
                          state.draft.forEach((item, order) => {
                            item.order = order;
                          });
                          changed();
                        }}
                      >
                        ${label("delete")}
                      </button>
                    `
              }
            </div>
          `,
        )}
        <div class="workboard-planning-editor__actions">
          <button
            type="button"
            class="btn"
            ?disabled=${columns.length >= 32}
            @click=${() => {
              columns.push({
                id: crypto.randomUUID(),
                name: label("newColumn"),
                width: 300,
                order: columns.length,
              });
              changed();
            }}
          >
            ＋ ${label("add")}
          </button>
          <button
            type="button"
            class="btn primary"
            ?disabled=${!valid}
            @click=${() => savePlanningColumns(props.host)}
          >
            ${t("common.save")}
          </button>
        </div>
      </fieldset>
      <button
        type="button"
        class="btn"
        ?disabled=${state.saving || state.loading}
        @click=${() => cancelPlanningEdit(props.host)}
      >
        ${t("common.cancel")}
      </button>
    </section>
  `;
}

function resizeHandle(props: WorkboardProps, column: WorkboardPlanningColumn) {
  const state = getPlanningState(props.host);
  const disabled = !editable(props) || Boolean(state.draft);
  return html`<div
    class="workboard-planning-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label=${`${label("resize")}: ${column.name}`}
    aria-valuenow=${column.width}
    aria-valuemin="200"
    aria-valuemax="800"
    tabindex=${disabled ? "-1" : "0"}
    aria-disabled=${disabled}
    @keydown=${(event: KeyboardEvent) => {
      if (disabled || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      void resizePlanningColumn(
        props.host,
        column.id,
        clampWidth(column.width + (event.key === "ArrowLeft" ? -20 : 20)),
      );
    }}
    @pointerdown=${(event: PointerEvent) => {
      if (disabled || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      const element = handle.closest<HTMLElement>(".workboard-planning-column")!;
      const startX = event.clientX;
      const initialWidth = column.width;
      const boardId = state.boardId;
      const revision = state.data?.revision;
      let width = initialWidth;
      handle.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        width = clampWidth(initialWidth + next.clientX - startX);
        element.style.width = `${width}px`;
        handle.setAttribute("aria-valuenow", String(width));
      };
      const finish = (next: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        element.style.width = `${initialWidth}px`;
        handle.setAttribute("aria-valuenow", String(initialWidth));
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
        if (
          next.type === "pointerup" &&
          width !== initialWidth &&
          getPlanningState(props.host).boardId === boardId &&
          getPlanningState(props.host).data?.revision === revision
        ) {
          void resizePlanningColumn(props.host, column.id, width);
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    }}
  ></div>`;
}

export function renderPlanningBoard(props: WorkboardProps, cards: WorkboardCard[]) {
  const state = getPlanningState(props.host);
  const data = state.data;
  if (!data) {
    return html`<div class="callout" role="status">
      ${state.loading ? label("loading") : label("unavailable")}
    </div>`;
  }
  const columns = data.columns.toSorted((a, b) => a.order - b.order);
  const columnIds = new Set(columns.map((column) => column.id));
  const placements = new Map(data.cards.map((card) => [card.cardId, card]));
  const columnOf = (card: WorkboardCard) => {
    const id = placements.get(card.id)?.columnId;
    return id && columnIds.has(id) ? id : "inbox";
  };
  const fallbackOrder = new Map(cards.map((card, index) => [card.id, index * 1024]));
  const orderOf = (card: WorkboardCard) =>
    placements.get(card.id)?.order ?? fallbackOrder.get(card.id) ?? 0;
  const writable = editable(props) && !state.draft;
  const drop = (
    event: DragEvent,
    columnId: string,
    ordered: WorkboardCard[],
    before?: WorkboardCard,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const workboard = getWorkboardState(props.host);
    const cardId = workboard.draggedCardId;
    if (
      !writable ||
      !cardId ||
      !cards.some((card) => card.id === cardId) ||
      before?.id === cardId
    ) {
      return;
    }
    const remaining = ordered.filter((card) => card.id !== cardId);
    const index = before ? remaining.findIndex((card) => card.id === before.id) : remaining.length;
    const next = remaining[index];
    const previous = remaining[index - 1];
    const order = next
      ? previous
        ? (orderOf(previous) + orderOf(next)) / 2
        : orderOf(next) - 1024
      : previous
        ? orderOf(previous) + 1024
        : 0;
    workboard.draggedCardId = null;
    void movePlanningCard(props.host, cardId, columnId, order);
  };
  return html`<div class="workboard-planning-board" aria-label=${label("planning")}>
    ${repeat(
      columns,
      (column) => column.id,
      (column) => {
        const ordered = cards
          .filter((card) => columnOf(card) === column.id)
          .toSorted((a, b) => orderOf(a) - orderOf(b) || a.id.localeCompare(b.id));
        return html`<section
          class="workboard-planning-column"
          style=${styleMap({ width: `${column.width}px` })}
          @dragover=${(event: DragEvent) => {
            if (writable) {
              event.preventDefault();
            }
          }}
          @drop=${(event: DragEvent) => drop(event, column.id, ordered)}
        >
          <header class="workboard-planning-column__header">
            <h2>${column.name}</h2>
            <span>${ordered.length}</span>
          </header>
          <div class="workboard-planning-column__cards">
            ${
              ordered.length
                ? repeat(
                    ordered,
                    (card) => card.id,
                    (card) => html`
                      <div
                        class="workboard-planning-card"
                        @drop=${(event: DragEvent) => drop(event, column.id, ordered, card)}
                      >
                        ${renderCard(props, card, "planning")}
                        <label class="workboard-planning-card__move"
                          >${label("moveTo")}
                          <select
                            class="input"
                            aria-label=${`${label("moveTo")}: ${card.title}`}
                            .value=${live(column.id)}
                            ?disabled=${!writable || Boolean(card.metadata?.archivedAt)}
                            @change=${(event: Event) => {
                              const destination = (event.currentTarget as HTMLSelectElement).value;
                              const last = cards
                                .filter((item) => columnOf(item) === destination)
                                .reduce((max, item) => Math.max(max, orderOf(item)), 0);
                              void movePlanningCard(props.host, card.id, destination, last + 1024);
                            }}
                          >
                            ${columns.map((item) => html`<option value=${item.id} ?selected=${item.id === column.id}>${item.name}</option>`)}
                          </select>
                        </label>
                      </div>
                    `,
                  )
                : html`<p class="workboard-planning-empty">${label("drop")}</p>`
            }
          </div>
          ${resizeHandle(props, column)}
        </section>`;
      },
    )}
  </div>`;
}
