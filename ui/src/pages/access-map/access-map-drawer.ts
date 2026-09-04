import { html, nothing } from "lit";
import type {
  FsListDirResult,
  SandboxExplainResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { AccessMapDraft } from "./access-map-draft.ts";

export type AccessMapDrawerProps = {
  draft: AccessMapDraft;
  report: SandboxExplainResult;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (patch: Partial<AccessMapDraft>) => void;
  onSubmit: () => void;
};

export function renderAccessMapDrawer(p: AccessMapDrawerProps) {
  const create = p.draft.source.kind === "create";
  const title = t(create ? "accessMap.createNew" : "accessMap.drawerTitle");
  const pathSource = p.draft.source.kind === "path";
  return html` <openclaw-modal-dialog
    class="drawer access-map-modal"
    label=${title}
    @modal-cancel=${(event: Event) => {
      if (p.busy) {
        event.preventDefault();
      } else {
        p.onClose();
      }
    }}
  >
    <form
      class="access-map-drawer"
      @submit=${(event: Event) => {
        event.preventDefault();
        p.onSubmit();
      }}
    >
      <header class="access-map-drawer__header">
        <h2>${title}</h2>
        <button
          class="access-map-icon-button"
          type="button"
          aria-label=${t("common.close")}
          ?disabled=${p.busy}
          @click=${p.onClose}
        >
          ${icon("x")}
        </button>
      </header>
      <div class="access-map-drawer__body">
        ${create
          ? html` <label class="access-map-field"
                >${t("accessMap.entryKind")}
                <select
                  .value=${p.draft.kind}
                  ?disabled=${p.busy}
                  @change=${(e: Event) => {
                    // SAFETY: this change handler is bound directly to the select below.
                    const select = e.currentTarget as HTMLSelectElement;
                    p.onChange({ kind: select.value === "directory" ? "directory" : "file" });
                  }}
                >
                  <option value="file">${t("accessMap.file")}</option>
                  <option value="directory">${t("accessMap.folder")}</option>
                </select>
              </label>
              <label class="access-map-field"
                >${t("accessMap.entryName")}
                <input
                  autofocus
                  required
                  maxlength="255"
                  .value=${p.draft.name}
                  ?disabled=${p.busy}
                  @input=${(e: Event) => {
                    // SAFETY: this input handler is bound directly to the name input.
                    const input = e.currentTarget as HTMLInputElement;
                    p.onChange({ name: input.value });
                  }}
                />
              </label>`
          : html` <div class="access-map-selected-file">
                ${icon(p.draft.kind === "directory" ? "folder" : "fileText")}
                <div>
                  <strong>${p.draft.name}</strong
                  ><small
                    >${p.draft.kind === "directory"
                      ? t("accessMap.folder")
                      : t("accessMap.file")}${p.draft.size === undefined
                      ? nothing
                      : ` · ${(p.draft.size / 1024).toFixed(1)} KB`}</small
                  >
                </div>
              </div>
              <fieldset class="access-map-modes" ?disabled=${p.busy}>
                <legend>${t("accessMap.modePrompt")}</legend>
                ${(["copy", "ro", "rw"] as const).map(
                  (mode) => html` <label
                    class="access-map-mode ${p.draft.mode === mode ? "is-selected" : ""}"
                  >
                    <input
                      type="radio"
                      name="access-map-mode"
                      value=${mode}
                      .checked=${p.draft.mode === mode}
                      ?disabled=${!pathSource && mode !== "copy"}
                      @change=${() => p.onChange({ mode })}
                    />
                    <span
                      ><strong
                        >${t(
                          mode === "copy"
                            ? "accessMap.modeCopy"
                            : mode === "ro"
                              ? "accessMap.modeReadOnly"
                              : "accessMap.modeReadWrite",
                        )}</strong
                      >
                      <small
                        >${t(
                          mode === "copy"
                            ? "accessMap.modeCopyHint"
                            : mode === "ro"
                              ? "accessMap.modeReadOnlyHint"
                              : "accessMap.modeReadWriteHint",
                        )}</small
                      ></span
                    >
                    ${mode === "copy"
                      ? html`<span class="access-map-recommended"
                          >${t("accessMap.recommended")}</span
                        >`
                      : nothing}
                  </label>`,
                )}
              </fieldset>
              ${!pathSource
                ? html`<p class="access-map-help">${t("accessMap.uploadCopyOnly")}</p>`
                : nothing}`}
        <div class="access-map-destination">
          <p>
            ${icon("folder")}<span
              >${t("accessMap.destination")}<small
                >${p.draft.mode === "copy"
                  ? (p.report.inbox?.containerPath ?? t("common.unknown"))
                  : t("accessMap.sharedDestination")}</small
              ></span
            >
          </p>
          <p>
            ${icon("shieldCheck")}<span
              >${t("accessMap.scope")}<small
                >${t(
                  p.draft.kind === "directory" ? "accessMap.scopeFolder" : "accessMap.scopeFile",
                )}</small
              ></span
            >
          </p>
        </div>
        ${p.draft.mode !== "copy"
          ? html`<p class="access-map-help">${t("accessMap.destinationPending")}</p>`
          : nothing}
        ${p.error
          ? html`<p class="access-map-message is-error" role="alert">${p.error}</p>`
          : nothing}
      </div>
      <footer class="access-map-drawer__footer">
        <button class="access-map-button" type="button" ?disabled=${p.busy} @click=${p.onClose}>
          ${t("common.cancel")}
        </button>
        <button class="access-map-button is-primary" type="submit" ?disabled=${p.busy}>
          ${p.busy ? t("common.saving") : t("accessMap.addToWorkspace")}
        </button>
      </footer>
    </form>
  </openclaw-modal-dialog>`;
}

export type AccessMapPickerProps = {
  listing: FsListDirResult | null;
  path: string;
  loading: boolean;
  error: string | null;
  onPath: (value: string) => void;
  onBrowse: (path?: string) => void;
  onSelect: (path: string, kind: "file" | "directory") => void;
  onUpload: () => void;
  onClose: () => void;
};

export function renderAccessMapPicker(p: AccessMapPickerProps) {
  return html`<openclaw-modal-dialog
    class="access-map-picker-modal"
    label=${t("accessMap.pickerTitle")}
    @modal-cancel=${p.onClose}
  >
    <section class="access-map-picker">
      <header class="access-map-drawer__header">
        <h2>${t("accessMap.pickerTitle")}</h2>
        <button
          type="button"
          class="access-map-icon-button"
          aria-label=${t("common.close")}
          @click=${p.onClose}
        >
          ${icon("x")}
        </button>
      </header>
      <p class="access-map-help">${t("accessMap.hostPickerNote")}</p>
      <form
        class="access-map-path-form"
        @submit=${(e: Event) => {
          e.preventDefault();
          p.onBrowse(p.path);
        }}
      >
        <label class="access-map-field"
          >${t("accessMap.path")}<input
            autofocus
            .value=${p.path}
            @input=${(e: Event) => {
              // SAFETY: this input handler is bound directly to the folder-path input.
              const input = e.currentTarget as HTMLInputElement;
              p.onPath(input.value);
            }}
        /></label>
        <button type="submit" class="access-map-button" ?disabled=${p.loading}>
          ${t("accessMap.browse")}
        </button>
      </form>
      ${p.error
        ? html`<p class="access-map-message is-error" role="alert">${p.error}</p>`
        : nothing}
      <div class="access-map-picker__entries" aria-busy=${p.loading}>
        ${p.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
        ${p.listing
          ? html`
              ${p.listing.parent
                ? html`<button
                    type="button"
                    class="access-map-picker__entry"
                    ?disabled=${p.loading}
                    @click=${() => p.onBrowse(p.listing!.parent!)}
                  >
                    ${icon("chevronLeft")}${t("accessMap.parentFolder")}
                  </button>`
                : nothing}
              ${p.listing.entries.map(
                (entry) => html`<button
                  type="button"
                  class="access-map-picker__entry"
                  ?disabled=${p.loading}
                  @click=${() =>
                    entry.kind === "directory"
                      ? p.onBrowse(entry.path)
                      : p.onSelect(entry.path, "file")}
                >
                  ${icon(
                    entry.kind === "directory" ? "folder" : "fileText",
                  )}<span>${entry.name}</span>${entry.kind === "directory"
                    ? icon("chevronRight")
                    : nothing}
                </button>`,
              )}
              ${p.listing.entries.length === 0
                ? html`<p class="access-map-help">${t("accessMap.pickerEmpty")}</p>`
                : nothing}
            `
          : nothing}
      </div>
      <footer class="access-map-picker__footer">
        <button type="button" class="access-map-button" @click=${p.onUpload}>
          ${t("accessMap.uploadFile")}
        </button>
        <button
          type="button"
          class="access-map-button is-primary"
          ?disabled=${p.loading || !p.listing}
          @click=${() => p.listing && p.onSelect(p.listing.path, "directory")}
        >
          ${t("accessMap.selectFolder")}
        </button>
      </footer>
    </section></openclaw-modal-dialog
  >`;
}
