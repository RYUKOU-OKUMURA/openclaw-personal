import { html, nothing } from "lit";
import type { SandboxExplainResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { buildAccessMapViewModel } from "./access-map-model.ts";

export type AccessMapMount = SandboxExplainResult["sandbox"]["workspaceMounts"][number];

export function renderAccessMapDiagram(p: {
  report: SandboxExplainResult;
  assetBase: string;
  onShare: (mount: AccessMapMount) => void;
  onDetails: () => void;
}) {
  const report = p.report;
  const model = buildAccessMapViewModel(report);
  const shares = model.sandbox.workspaceMounts.filter((mount) => mount.source === "bind");
  const inbox = model.inbox;
  return html`<section class="access-map-diagram" aria-label=${t("accessMap.sandboxHeading")}>
    <div class="access-map-pc">
      <h2>${icon("monitor")}${t("accessMap.yourPc")}</h2>
      <p class="access-map-help">${t("accessMap.yourPcNote")}</p>
      <div class="access-map-pc__locations">
        ${["desktop", "documents", "photos"].map(
          (key) =>
            html`<div class="access-map-pc__location">
              ${icon("lock")}<span
                >${t(`accessMap.${key}`)}<small>${t("accessMap.checkMounts")}</small></span
              >
            </div>`,
        )}
      </div>
    </div>
    <div class="access-map-transfer" aria-hidden="true">
      ${icon("fileText")}<span>${icon("forward")}</span>
    </div>
    <div class="access-map-workspace">
      <img
        class="access-map-workspace__frame"
        src=${`${p.assetBase}access-map-workspace.png`}
        alt=""
        aria-hidden="true"
      />
      <div class="access-map-workspace__content">
        <header class="access-map-workspace__header">
          <span class="access-map-workspace__icon"
            ><img src=${`${p.assetBase}access-map-docker.svg`} alt="" aria-hidden="true"
          /></span>
          <div>
            <h2>${t("accessMap.sandboxHeading")}</h2>
            <p>${t("accessMap.docker")}</p>
          </div>
        </header>
        <div class="access-map-inventory">
          <h3>
            ${
              inbox
                ? t("accessMap.inboxCount", {
                    files: String(inbox.counts.files),
                    folders: String(inbox.counts.folders),
                  })
                : t("accessMap.inboxUnavailable")
            }
          </h3>
          <div class="access-map-cards">
            ${inbox?.entries.map(
              (entry) => html`<div class="access-map-entry" title=${entry.name}>
                ${icon(entry.kind === "directory" ? "folder" : "fileText")}<strong
                  >${entry.name}</strong
                ><span class="access-map-badge is-copy">${t("accessMap.badgeInbox")}</span>
              </div>`,
            )}
            ${shares.map(
              (mount) => html`<button
                type="button"
                class="access-map-entry is-share"
                title=${mount.hostRoot}
                @click=${() => p.onShare(mount)}
              >
                ${icon("link")}<strong
                  >${
                    mount.containerRoot.split("/").findLast(Boolean) ?? mount.containerRoot
                  }</strong
                ><span class="access-map-badge ${mount.writable ? "is-rw" : "is-ro"}"
                  >${t(
                    mount.writable ? "accessMap.badgeReadWrite" : "accessMap.badgeReadOnly",
                  )}</span
                >
              </button>`,
            )}
            <button type="button" class="access-map-entry is-workdir" @click=${p.onDetails}>
              ${icon("folder")}<strong>${t("accessMap.workspaceLocation")}</strong>
              <small
                >${
                  report.sandbox.runtimeWorkdir ?? report.sandbox.effectiveHostWorkspaceRoot
                }</small
              >
            </button>
            ${
              inbox && !inbox.entries.length && !shares.length
                ? html`<div class="access-map-entry is-placeholder">
                    ${icon("folder")}<strong>${t("accessMap.inboxEmpty")}</strong
                    ><small>${t("accessMap.inboxPlaceholder")}</small>
                  </div>`
                : nothing
            }
          </div>
          ${
            inbox?.counts.other
              ? html`<small
                  >${t("accessMap.inboxOther", { count: String(inbox.counts.other) })}</small
                >`
              : nothing
          }
          ${
            inbox?.truncated
              ? html`<p class="access-map-help">${t("accessMap.inboxTruncated")}</p>`
              : nothing
          }
        </div>
      </div>
    </div>
    <div class="access-map-connections">
      <button type="button" class="access-map-connection" @click=${p.onDetails}>
        ${icon("users")}<span
          >${t("accessMap.sharedFoldersChip")}<strong
            >${t("accessMap.shareCount", { count: String(model.chips.sharedFolders) })}</strong
          ></span
        >
      </button>
      <button type="button" class="access-map-connection" @click=${p.onDetails}>
        ${icon("globe")}<span
          >${t("accessMap.networkChip")}<strong
            >${
              report.sandbox.network === "none"
                ? t("accessMap.networkNone")
                : t("accessMap.networkEnabled", {
                    network: report.sandbox.network ?? t("common.unknown"),
                  })
            }</strong
          ></span
        >
      </button>
      <button type="button" class="access-map-connection" @click=${p.onDetails}>
        ${icon("wrench")}<span
          >${t("accessMap.externalToolsChip")}<strong>${t("accessMap.toolsDetails")}</strong></span
        >
      </button>
    </div>
  </section>`;
}

export function renderAccessMapDetails(report: SandboxExplainResult) {
  return html`<div class="access-map-details" id="access-map-effective-permissions">
    <h2>${t("accessMap.configuredMounts")}</h2>
    <p class="access-map-help">${t("accessMap.mountsHint")}</p>
    <div class="access-map-mount-list">
      ${report.sandbox.workspaceMounts.map(
        (mount) => html`<div class="access-map-mount">
          ${icon(mount.source === "protectedSkill" ? "lock" : "folder")}
          <div><strong>${mount.containerRoot}</strong><small>${mount.hostRoot}</small></div>
          <span class="access-map-badge ${mount.writable ? "is-rw" : "is-ro"}"
            >${t(mount.writable ? "accessMap.badgeReadWrite" : "accessMap.badgeReadOnly")}</span
          >
        </div>`,
      )}
    </div>
    <h3>${t("accessMap.toolPolicy")}</h3>
    <dl>
      <dt>${t("accessMap.allowedTools")}</dt>
      <dd>${report.sandbox.tools.allow.join(", ") || t("accessMap.noAllowRestriction")}</dd>
      <dt>${t("accessMap.deniedTools")}</dt>
      <dd>${report.sandbox.tools.deny.join(", ") || t("common.none")}</dd>
    </dl>
    <h3>${t("accessMap.elevatedPolicy")}</h3>
    <p>${t(report.elevated.enabled ? "accessMap.elevatedConfigured" : "accessMap.elevatedOff")}</p>
    <details>
      <summary>${t("accessMap.rawReport")}</summary>
      <pre>${JSON.stringify(report, null, 2)}</pre>
    </details>
  </div>`;
}
