import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  FsListDirResult,
  SandboxEntriesAddParams,
  SandboxExplainResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { icon } from "../../components/icons.ts";
import { encodeTerminalUpload } from "../../components/terminal/terminal-file-upload.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import type { AccessMapMount } from "./access-map-diagram.ts";
import type { AccessMapDraft } from "./access-map-draft.ts";
import { renderAccessMapDrawer, renderAccessMapPicker } from "./access-map-drawer.ts";
import {
  addSandboxEntry,
  listHostDir,
  loadSandboxExplain,
  pickHostPath,
  recreateSandboxContainer,
  removeSharedBind,
} from "./access-map-gateway.ts";
import { renderAccessMapView } from "./access-map-view.ts";

class AccessMapPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @state() private report: SandboxExplainResult | null = null;
  @state() private loading = false;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private draft: AccessMapDraft | null = null;
  @state() private formError: string | null = null;
  @state() private pickerOpen = false;
  @state() private listing: FsListDirResult | null = null;
  @state() private pickerPath = "";
  @state() private pickerLoading = false;
  @state() private pickerError: string | null = null;
  @state() private detailsOpen = false;
  @state() private selectedShare: AccessMapMount | null = null;
  @state() private pending = false;
  private loadVersion = 0;
  private pickerVersion = 0;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.reset(),
    ensureInitialData: () => void this.refresh(),
  });

  private get canRead() {
    return canCallGatewayMethod(this.gateway.snapshot, "sandbox.explain", "operator.read", {
      requireAdvertisement: false,
    });
  }

  private get canMutate() {
    return canCallGatewayMethod(this.gateway.snapshot, "sandbox.entries.add", "operator.admin", {
      requireAdvertisement: false,
    });
  }

  private get canManageFiles() {
    return (
      this.canMutate &&
      this.report?.sandbox.backend.trim().toLowerCase() === "docker" &&
      this.report.sandbox.sessionIsSandboxed
    );
  }

  private reset() {
    this.loadVersion++;
    this.pickerVersion++;
    this.report = null;
    this.loading = false;
    this.busy = false;
    this.error = null;
    this.notice = null;
    this.draft = null;
    this.pickerOpen = false;
    this.listing = null;
    this.pickerLoading = false;
    this.selectedShare = null;
    this.formError = null;
    this.pending = false;
  }

  private async refresh() {
    const scope = this.gateway.capture();
    if (!scope || !this.canRead) {
      return;
    }
    const version = ++this.loadVersion;
    this.loading = true;
    this.error = null;
    try {
      const report = await loadSandboxExplain(scope.client);
      if (this.gateway.isCurrent(scope) && version === this.loadVersion) {
        this.report = report;
        this.pending = report.registry?.stale ?? false;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && version === this.loadVersion) {
        this.error = `${t("accessMap.loadFailed")} ${formatUiError(error)}`;
      }
    } finally {
      if (this.gateway.isCurrent(scope) && version === this.loadVersion) {
        this.loading = false;
      }
    }
  }

  private openPicker() {
    if (!this.canManageFiles || this.busy) {
      return;
    }
    this.notice = null;
    this.pickerOpen = true;
    this.listing = null;
    this.pickerPath = "";
    void this.browse();
  }

  private async browse(path?: string) {
    const scope = this.gateway.capture();
    if (!scope || !this.pickerOpen || !this.canManageFiles) {
      return;
    }
    const version = ++this.pickerVersion;
    this.pickerLoading = true;
    this.pickerError = null;
    try {
      const listing = await listHostDir(scope.client, path?.trim() ? { path: path.trim() } : {});
      if (this.gateway.isCurrent(scope) && this.pickerOpen && version === this.pickerVersion) {
        this.listing = listing;
        this.pickerPath = listing.path;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && this.pickerOpen && version === this.pickerVersion) {
        this.pickerError = formatUiError(error);
        this.listing = null;
      }
    } finally {
      if (this.gateway.isCurrent(scope) && version === this.pickerVersion) {
        this.pickerLoading = false;
      }
    }
  }

  private selectPath(path: string, kind: "file" | "directory") {
    if (!this.canManageFiles || this.busy) {
      return;
    }
    this.pickerVersion++;
    this.pickerOpen = false;
    this.formError = null;
    this.draft = {
      source: { kind: "path", path },
      name: path.split(/[\\/]/).findLast(Boolean) ?? path,
      kind,
      mode: "copy",
    };
  }

  private async pickNativePath() {
    const scope = this.gateway.capture();
    const listing = this.listing;
    if (
      !scope ||
      !this.pickerOpen ||
      !listing ||
      !listing.nativePathPicker ||
      !this.canManageFiles ||
      this.pickerLoading ||
      this.busy
    ) {
      return;
    }
    const version = ++this.pickerVersion;
    this.pickerLoading = true;
    this.pickerError = null;
    const current = () =>
      this.gateway.isCurrent(scope) && this.pickerOpen && version === this.pickerVersion;
    try {
      const selected = await pickHostPath(scope.client, listing.path);
      if (current() && this.canManageFiles && "path" in selected) {
        this.pickerLoading = false;
        this.selectPath(selected.path, selected.kind);
      }
    } catch (error) {
      if (current()) {
        this.pickerError = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.pickerLoading = false;
      }
    }
  }

  private openCreate() {
    if (!this.canManageFiles || this.busy) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.draft = {
      source: { kind: "create", name: "", entryKind: "file" },
      name: "",
      kind: "file",
      mode: "copy",
    };
  }

  private async upload(files: FileList | null) {
    const scope = this.gateway.capture();
    if (!scope || !this.canManageFiles || this.busy || !files?.length) {
      return;
    }
    if (files.length !== 1) {
      this.error = t("accessMap.singleFile");
      return;
    }
    const file = files[0];
    if (!file) {
      return;
    }
    this.busy = true;
    this.error = null;
    this.notice = null;
    try {
      const contentBase64 = await encodeTerminalUpload(file);
      if (!this.gateway.isCurrent(scope) || !this.canManageFiles) {
        return;
      }
      this.pickerVersion++;
      this.pickerOpen = false;
      this.formError = null;
      this.draft = {
        source: { kind: "upload", name: file.name, contentBase64 },
        name: file.name,
        kind: "file",
        mode: "copy",
        size: file.size,
      };
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async submitDraft() {
    const scope = this.gateway.capture();
    const report = this.report;
    const draft = this.draft;
    if (!scope || !report || !draft || !this.canManageFiles || this.busy) {
      return;
    }
    if (draft.source.kind === "create" && !draft.name.trim()) {
      this.formError = t("accessMap.nameRequired");
      return;
    }
    this.busy = true;
    this.formError = null;
    const current = () =>
      this.gateway.isCurrent(scope) && this.canManageFiles && this.draft === draft;
    try {
      let params: SandboxEntriesAddParams;
      if (draft.mode !== "copy") {
        if (draft.source.kind !== "path") {
          return;
        }
        const consent = await showConfirmDialog({
          title: t("accessMap.externalConsentTitle"),
          message: `${t("accessMap.externalConsentBody")} ${draft.mode === "rw" ? t("accessMap.modeReadWriteHint") : t("accessMap.modeReadOnlyHint")} ${report.sandbox.scope === "shared" ? t("accessMap.recreateShared") : ""}`,
          confirmLabel: t("accessMap.externalConsentConfirm"),
          danger: draft.mode === "rw",
        });
        if (!consent || !current()) {
          return;
        }
        params = {
          agentId: report.agentId,
          mode: draft.mode,
          source: draft.source,
          allowExternalSource: true,
        };
      } else {
        params = {
          agentId: report.agentId,
          mode: "copy",
          source:
            draft.source.kind === "create"
              ? { kind: "create", name: draft.name.trim(), entryKind: draft.kind }
              : draft.source,
        };
      }
      if (!current()) {
        return;
      }
      const outcome =
        params.mode === "copy"
          ? {
              ok: true as const,
              value: await addSandboxEntry(scope.client, params),
              refresh: { ok: true as const },
            }
          : await this.context.runtimeConfig.runExternalMutation(
              (client) => addSandboxEntry(client, params),
              { canDispatch: current },
            );
      if (!current()) {
        return;
      }
      if (!outcome.ok) {
        this.formError = outcome.error;
        return;
      }
      this.draft = null;
      this.pending = this.pending || outcome.value.recreateRequired;
      this.notice = `${t("accessMap.added", { name: outcome.value.entry.name })}${!outcome.refresh.ok ? ` ${t("accessMap.settingsRefreshFailed", { error: outcome.refresh.error })}` : ""}`;
      await this.refresh();
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.formError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async recreate() {
    const scope = this.gateway.capture();
    const report = this.report;
    if (!scope || !report || !this.canManageFiles || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    const current = () => this.gateway.isCurrent(scope) && this.canManageFiles;
    try {
      const confirmed = await showConfirmDialog({
        title: t("accessMap.recreateTitle"),
        message: `${t("accessMap.recreateBody")} ${report.sandbox.scope === "shared" ? t("accessMap.recreateShared") : ""}`,
        confirmLabel: t("accessMap.recreate"),
        danger: true,
      });
      if (!confirmed || !current()) {
        return;
      }
      const result = await recreateSandboxContainer(scope.client, report.agentId);
      if (!current()) {
        return;
      }
      await this.refresh();
      if (!current()) {
        return;
      }
      if (result.failed.length) {
        this.error = result.failed
          .map((failure) =>
            t("accessMap.recreateFailed", { name: failure.containerName, error: failure.error }),
          )
          .join("\n");
      } else {
        this.pending = false;
        this.notice = t(
          result.removed.length ? "accessMap.recreateDone" : "accessMap.recreateNoop",
        );
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private async removeShare() {
    const scope = this.gateway.capture();
    const report = this.report;
    const mount = this.selectedShare;
    if (!scope || !report || !mount || !this.canManageFiles || this.busy) {
      return;
    }
    this.busy = true;
    this.formError = null;
    const current = () =>
      this.gateway.isCurrent(scope) && this.canManageFiles && this.selectedShare === mount;
    try {
      const confirmed = await showConfirmDialog({
        title: t("accessMap.removeShareTitle"),
        message: `${t("accessMap.removeShareBody")} ${report.sandbox.scope === "shared" ? t("accessMap.recreateShared") : ""}`,
        confirmLabel: t("accessMap.removeShare"),
        danger: true,
      });
      if (!confirmed || !current()) {
        return;
      }
      const result = await removeSharedBind(
        scope.client,
        report,
        mount,
        this.context.runtimeConfig,
        current,
      );
      if (!current()) {
        return;
      }
      this.selectedShare = null;
      this.pending = true;
      this.notice = t("accessMap.shareRemoved");
      if (result.refreshWarning) {
        this.notice += ` ${t("accessMap.settingsRefreshFailed", { error: result.refreshWarning })}`;
      }
      await this.refresh();
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.formError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  override render() {
    return html`${renderAccessMapView({
      report: this.report,
      loading: this.loading,
      busy: this.busy,
      canRead: this.canRead,
      connected: this.gateway.connected,
      canMutate: this.canMutate,
      error: this.error,
      notice: this.notice,
      detailsOpen: this.detailsOpen,
      pending: this.pending,
      drawerOpen: Boolean(this.draft),
      assetBase: `${this.context?.resourceBasePath ?? ""}/`.replace(/\/+$/, "/"),
      onRefresh: () => void this.refresh(),
      onAdd: () => this.openPicker(),
      onCreate: () => this.openCreate(),
      onFile: (files) => void this.upload(files),
      onRecreate: () => void this.recreate(),
      onDetails: () => {
        this.detailsOpen = !this.detailsOpen;
      },
      onShare: (mount) => {
        this.formError = null;
        this.selectedShare = mount;
      },
    })}
    ${
      this.draft && this.report
        ? renderAccessMapDrawer({
            draft: this.draft,
            report: this.report,
            busy: this.busy,
            error: this.formError,
            onClose: () => {
              if (!this.busy) {
                this.draft = null;
              }
            },
            onChange: (patch) => {
              if (this.draft && !this.busy) {
                this.draft = { ...this.draft, ...patch };
                this.formError = null;
              }
            },
            onSubmit: () => void this.submitDraft(),
          })
        : nothing
    }
    ${
      this.pickerOpen
        ? renderAccessMapPicker({
            listing: this.listing,
            path: this.pickerPath,
            loading: this.pickerLoading,
            error: this.pickerError,
            onPath: (value) => {
              this.pickerPath = value;
            },
            onBrowse: (path) => void this.browse(path),
            onNativeSelect: () => void this.pickNativePath(),
            onSelect: (path, kind) => this.selectPath(path, kind),
            onUpload: () => {
              this.pickerOpen = false;
              this.querySelector<HTMLInputElement>(".access-map-upload")?.click();
            },
            onClose: () => {
              this.pickerOpen = false;
              this.pickerVersion++;
            },
          })
        : nothing
    }
    ${
      this.selectedShare
        ? html`<openclaw-modal-dialog
            label=${t("accessMap.sharedEntry")}
            @modal-cancel=${(event: Event) => {
              if (this.busy) {
                event.preventDefault();
              } else {
                this.selectedShare = null;
              }
            }}
            ><section class="access-map-share">
              <header class="access-map-drawer__header">
                <h2>${t("accessMap.sharedEntry")}</h2>
                <button
                  class="access-map-icon-button"
                  type="button"
                  aria-label=${t("common.close")}
                  ?disabled=${this.busy}
                  @click=${() => {
                    this.selectedShare = null;
                  }}
                >
                  ${icon("x")}
                </button>
              </header>
              <dl>
                <dt>${t("accessMap.originalLocation")}</dt>
                <dd>${this.selectedShare.hostRoot}</dd>
                <dt>${t("accessMap.containerLocation")}</dt>
                <dd>${this.selectedShare.containerRoot}</dd>
              </dl>
              <p>
                ${t(
                  this.selectedShare.writable
                    ? "accessMap.modeReadWriteHint"
                    : "accessMap.modeReadOnlyHint",
                )}
              </p>
              <p class="access-map-help">
                ${t("accessMap.inheritedShareHint")}
                <a
                  href="https://docs.openclaw.ai/gateway/sandboxing"
                  target="_blank"
                  rel="noreferrer"
                  >${t("accessMap.sandboxSettings")}</a
                >
              </p>
              ${
                this.formError
                  ? html`<p class="access-map-message is-error" role="alert">${this.formError}</p>`
                  : nothing
              }
              <button
                class="access-map-button"
                type="button"
                ?disabled=${!this.canManageFiles || this.busy}
                @click=${() => void this.removeShare()}
              >
                ${t("accessMap.removeShare")}
              </button>
            </section></openclaw-modal-dialog
          >`
        : nothing
    }`;
  }
}

if (!customElements.get("openclaw-access-map-page")) {
  customElements.define("openclaw-access-map-page", AccessMapPage);
}
