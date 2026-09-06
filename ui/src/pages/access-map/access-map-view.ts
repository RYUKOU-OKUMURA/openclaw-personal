import { html, nothing } from "lit";
import type { SandboxExplainResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerAccessMapEnglish } from "../../i18n/locales/en-access-map.ts";
import {
  renderAccessMapDetails,
  renderAccessMapDiagram,
  type AccessMapMount,
} from "./access-map-diagram.ts";
import "./access-map.css";

registerAccessMapEnglish();

export function renderAccessMapView(p: {
  report: SandboxExplainResult | null;
  loading: boolean;
  busy: boolean;
  canRead: boolean;
  connected: boolean;
  canMutate: boolean;
  error: string | null;
  notice: string | null;
  detailsOpen: boolean;
  pending: boolean;
  drawerOpen: boolean;
  assetBase: string;
  onRefresh: () => void;
  onAdd: () => void;
  onCreate: () => void;
  onFile: (files: FileList | null) => void;
  onRecreate: () => void;
  onDetails: () => void;
  onShare: (mount: AccessMapMount) => void;
}) {
  const report = p.report;
  const isDocker = report?.sandbox.backend.trim().toLowerCase() === "docker";
  const supported = isDocker && report?.sandbox.sessionIsSandboxed;
  const scopeKey =
    report?.sandbox.scope === "shared"
      ? "accessMap.sharedScope"
      : report?.sandbox.scope === "agent"
        ? "accessMap.agentScope"
        : "accessMap.sessionScope";
  return html`<div class="access-map ${p.drawerOpen ? "has-drawer" : ""}" data-testid="access-map">
    <header class="access-map-header">
      <div>
        <p class="access-map-eyebrow">${t("accessMap.eyebrow")}</p>
        <h1>${t("accessMap.title")}</h1>
        <p class="access-map-subtitle">${t("accessMap.subtitle")}</p>
      </div>
      ${
        report
          ? html`<div class="access-map-runtime">
              <span
                class="access-map-status-dot ${
                  report.registry?.running && !report.registry.stale ? "is-running" : ""
                }"
              ></span>
              <div>
                ${t("accessMap.runtime", {
                  backend: isDocker ? t("accessMap.docker") : report.sandbox.backend,
                })}<small>${supported ? t(scopeKey) : t("common.disabled")}</small
                ><small
                  >${
                    !supported
                      ? nothing
                      : report.registry
                        ? report.registry.running
                          ? t("common.running")
                          : t("accessMap.stopped")
                        : t("accessMap.notProvisioned")
                  }</small
                >
              </div>
            </div>`
          : nothing
      }
    </header>
    <div class="access-map-toolbar">
      <button
        class="access-map-button is-primary"
        ?disabled=${!p.canMutate || p.busy || !supported}
        @click=${p.onAdd}
      >
        ${icon("plus")}${t("accessMap.addFromPc")}
      </button>
      <button
        class="access-map-button"
        ?disabled=${!p.canMutate || p.busy || !supported}
        @click=${p.onCreate}
      >
        ${icon("fileText")}${t("accessMap.createNew")}
      </button>
      <label
        class="access-map-dropzone ${!p.canMutate || p.busy || !supported ? "is-disabled" : ""}"
        @dragover=${(e: DragEvent) => {
          e.preventDefault();
        }}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          if (p.canMutate && !p.busy && supported) {
            p.onFile(e.dataTransfer?.files ?? null);
          }
        }}
      >
        ${icon("download")}<span
          >${t("accessMap.dropZoneHint")}<small>${t("accessMap.chooseFile")}</small></span
        ><input
          class="access-map-upload"
          type="file"
          aria-label=${t("accessMap.uploadFile")}
          ?disabled=${!p.canMutate || p.busy || !supported}
          @change=${(e: Event) => {
            // SAFETY: this change handler is bound directly to the file input.
            const input = e.currentTarget as HTMLInputElement;
            p.onFile(input.files);
            input.value = "";
          }}
        />
      </label>
      <button
        class="access-map-icon-button"
        title=${t("accessMap.refresh")}
        aria-label=${t("accessMap.refresh")}
        ?disabled=${p.loading || p.busy || !p.canRead}
        @click=${p.onRefresh}
      >
        ${icon("refresh")}
      </button>
    </div>
    ${
      p.error
        ? html`<div class="access-map-message is-error" role="alert">
            ${p.error}<button
              class="access-map-button"
              ?disabled=${p.loading || !p.canRead}
              @click=${p.onRefresh}
            >
              ${t("common.retry")}
            </button>
          </div>`
        : nothing
    }
    ${p.notice ? html`<p class="access-map-message" role="status">${p.notice}</p>` : nothing}
    ${
      p.loading && !report
        ? html`<p class="access-map-empty" role="status">${t("common.loading")}</p>`
        : nothing
    }
    ${
      !p.connected
        ? html`<p class="access-map-empty">${t("accessMap.disconnected")}</p>`
        : !p.canRead
          ? html`<p class="access-map-empty">${t("accessMap.noReadAccess")}</p>`
          : nothing
    }
    ${
      report
        ? html`
            ${
              !p.canMutate
                ? html`<p class="access-map-help">${t("accessMap.readOnlyNotice")}</p>`
                : nothing
            }
            ${
              !report.sandbox.sessionIsSandboxed
                ? html`<div class="access-map-empty">
                    <p>${t("accessMap.sandboxDisabled")}</p>
                    <a
                      href="https://docs.openclaw.ai/gateway/sandboxing"
                      target="_blank"
                      rel="noreferrer"
                      >${t("accessMap.enableSandbox")}</a
                    >
                  </div>`
                : !isDocker
                  ? html`<p class="access-map-empty">
                      ${t("accessMap.unsupportedBackend", { backend: report.sandbox.backend })}
                    </p>`
                  : html` ${
                      report.registry?.stale || p.pending
                        ? html`<div class="access-map-message is-warning" role="status">
                            <span
                              >${
                                report.registry
                                  ? t("accessMap.staleBanner")
                                  : t("accessMap.notProvisioned")
                              }</span
                            ><button
                              class="access-map-button"
                              ?disabled=${!p.canMutate || p.busy}
                              @click=${p.onRecreate}
                            >
                              ${t("accessMap.recreate")}
                            </button>
                          </div>`
                        : nothing
                    }
                    ${renderAccessMapDiagram({
                      report,
                      assetBase: p.assetBase,
                      onShare: p.onShare,
                      onDetails: p.onDetails,
                    })}`
            }
            <button
              type="button"
              class="access-map-footer"
              aria-expanded=${p.detailsOpen}
              aria-controls="access-map-effective-permissions"
              @click=${p.onDetails}
            >
              ${icon("info")}<span>${t("accessMap.footerScope")}</span
              ><strong>${t("accessMap.viewEffectivePermissions")}</strong>${icon(
                p.detailsOpen ? "chevronDown" : "chevronRight",
              )}
            </button>
            ${p.detailsOpen ? renderAccessMapDetails(report) : nothing}
            <p class="access-map-caption">
              ${t("accessMap.agent", { agent: report.agentId })} ·
              ${t("accessMap.createdEntriesHint")}
            </p>
          `
        : nothing
    }
  </div>`;
}
