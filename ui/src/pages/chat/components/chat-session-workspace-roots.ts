import { html, nothing, type TemplateResult } from "lit";
import type { SessionWorkspaceRoot } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

export function workspaceRootLabel(root: SessionWorkspaceRoot): string {
  if (root.kind === "workspace") {
    return t("chat.workspaceFiles.workspaceRoot");
  }
  if (root.kind === "outputs") {
    return t("chat.workspaceFiles.outputsRoot");
  }
  return root.name;
}

function rootIsSelected(
  sessionWorkspace: SessionWorkspaceProps,
  root: SessionWorkspaceRoot,
): boolean {
  return (sessionWorkspace.rootId ?? "workspace") === root.id;
}

function renderRootButton(
  sessionWorkspace: SessionWorkspaceProps,
  root: SessionWorkspaceRoot,
): TemplateResult {
  const label = workspaceRootLabel(root);
  const selected = rootIsSelected(sessionWorkspace, root);
  return html`
    <button
      type="button"
      class="chat-workspace-rail__root-button ${
        selected ? "chat-workspace-rail__root-button--active" : ""
      }"
      aria-label=${label}
      aria-pressed=${selected ? "true" : "false"}
      @click=${() => sessionWorkspace.onSelectRoot?.(root.id)}
    >
      <span class="chat-workspace-rail__file-icon" aria-hidden="true">${icons.folder}</span>
      <span class="chat-workspace-rail__root-label">${label}</span>
      ${
        root.writable
          ? nothing
          : html`<span class="chat-workspace-rail__root-badge"
              >${t("chat.workspaceFiles.readOnly")}</span
            >`
      }
    </button>
  `;
}

export function renderWorkspaceRootSelector(
  sessionWorkspace: SessionWorkspaceProps,
): TemplateResult | typeof nothing {
  const roots = sessionWorkspace.roots ?? [];
  if (roots.length === 0 || !sessionWorkspace.onSelectRoot) {
    return nothing;
  }
  const workspaceRoot = roots.find((root) => root.kind === "workspace" || root.id === "workspace");
  const outputsRoot = roots.find((root) => root.kind === "outputs");
  const sharedRoots = roots.filter((root) => root.kind === "shared");
  const sharedExpanded = sessionWorkspace.sharedRootsExpanded === true;
  return html`
    <nav class="chat-workspace-rail__roots" aria-label=${t("chat.workspaceFiles.rootSelector")}>
      ${workspaceRoot ? renderRootButton(sessionWorkspace, workspaceRoot) : nothing}
      ${outputsRoot ? renderRootButton(sessionWorkspace, outputsRoot) : nothing}
      ${
        sharedRoots.length > 0
          ? html`
              <button
                type="button"
                class="chat-workspace-rail__root-button ${
                  sharedRoots.some((root) => rootIsSelected(sessionWorkspace, root))
                    ? "chat-workspace-rail__root-button--active"
                    : ""
                }"
                aria-label=${t("chat.workspaceFiles.sharedRoot")}
                aria-pressed=${
                  sharedRoots.some((root) => rootIsSelected(sessionWorkspace, root))
                    ? "true"
                    : "false"
                }
                aria-expanded=${sharedExpanded ? "true" : "false"}
                @click=${() => {
                  const singleSharedRoot = sharedRoots.length === 1 ? sharedRoots[0] : undefined;
                  if (singleSharedRoot && !sessionWorkspace.onToggleSharedRoots) {
                    sessionWorkspace.onSelectRoot?.(singleSharedRoot.id);
                    return;
                  }
                  sessionWorkspace.onToggleSharedRoots?.();
                }}
              >
                <span class="chat-workspace-rail__file-icon" aria-hidden="true"
                  >${icons.folder}</span
                >
                <span class="chat-workspace-rail__root-label"
                  >${t("chat.workspaceFiles.sharedRoot")}</span
                >
                <span>${sharedRoots.length}</span>
              </button>
              ${
                sharedExpanded
                  ? html`
                      <div class="chat-workspace-rail__shared-list" role="list">
                        ${sharedRoots.map(
                          (root) => html`
                            <div role="listitem">${renderRootButton(sessionWorkspace, root)}</div>
                          `,
                        )}
                      </div>
                    `
                  : nothing
              }
            `
          : nothing
      }
    </nav>
  `;
}
