import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SandboxExplainResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI access map mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const ACCESS_MAP_PATH = "settings/access-map";
const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";
const WORKSPACE_ROOT = "/Users/operator/OpenClaw/workspace";
const INBOX_HOST_PATH = `${WORKSPACE_ROOT}/inbox`;
const PICKER_ROOT = "/Users/operator/Documents";
const PICKER_FILE = `${PICKER_ROOT}/draft.md`;
const PICKER_FOLDER = `${PICKER_ROOT}/fixtures`;
const CONTAINER_NAME = "openclaw-sandbox-agent-main";
const BASE_TIME = Date.parse("2026-08-31T12:00:00.000Z");

const BASE_SANDBOX: SandboxExplainResult["sandbox"] = {
  mode: "all",
  scope: "agent",
  backend: "docker",
  workspaceAccess: "rw",
  workspaceRoot: WORKSPACE_ROOT,
  effectiveHostWorkspaceRoot: WORKSPACE_ROOT,
  runtimeWorkdir: "/workspace",
  workspaceMounts: [
    {
      hostRoot: WORKSPACE_ROOT,
      containerRoot: "/workspace",
      writable: true,
      source: "workspace",
    },
    {
      hostRoot: "/Users/operator/Documents/reference",
      containerRoot: "/mnt/shared/reference",
      writable: false,
      source: "bind",
    },
    {
      hostRoot: "/Users/operator/Projects/live",
      containerRoot: "/mnt/shared/live",
      writable: true,
      source: "bind",
    },
  ],
  workspaceSource: "sandbox",
  sessionIsSandboxed: true,
  network: "none",
  tools: {
    allow: ["read"],
    deny: ["exec"],
    sources: {
      allow: { source: "default", key: "sandbox.tools.allow" },
      deny: { source: "default", key: "sandbox.tools.deny" },
    },
  },
};

const BASE_INBOX: NonNullable<SandboxExplainResult["inbox"]> = {
  hostPath: INBOX_HOST_PATH,
  containerPath: "/workspace/inbox",
  entries: [
    { name: "README.md", kind: "file" },
    { name: "assets", kind: "directory" },
  ],
  counts: { files: 1, folders: 1, other: 0 },
  truncated: false,
};

const BASE_REGISTRY: NonNullable<SandboxExplainResult["registry"]> = {
  containerName: CONTAINER_NAME,
  image: "openclaw-sandbox:latest",
  configHash: "sandbox-config-current",
  createdAtMs: BASE_TIME - 60_000,
  lastUsedAtMs: BASE_TIME,
  running: true,
  stale: false,
};

const BASE_REPORT: SandboxExplainResult = {
  docsUrl: "https://docs.openclaw.ai/gateway/sandboxing",
  agentId: AGENT_ID,
  sessionKey: SESSION_KEY,
  mainSessionKey: SESSION_KEY,
  sandbox: BASE_SANDBOX,
  elevated: {
    enabled: false,
    allowedByConfig: false,
    alwaysAllowedByConfig: false,
    allowFrom: {},
    failures: [],
  },
  fixIt: [],
  inbox: BASE_INBOX,
  registry: BASE_REGISTRY,
};

const PICKER_LISTING = {
  path: PICKER_ROOT,
  parent: "/Users/operator",
  home: "/Users/operator",
  entries: [
    { name: "draft.md", path: PICKER_FILE, kind: "file" as const },
    { name: "fixtures", path: PICKER_FOLDER, kind: "directory" as const },
  ],
};

type ReportOverrides = {
  inbox?: SandboxExplainResult["inbox"];
  registry?: SandboxExplainResult["registry"];
  sandbox?: Partial<SandboxExplainResult["sandbox"]>;
};

function sandboxReport(overrides: ReportOverrides = {}): SandboxExplainResult {
  return {
    ...BASE_REPORT,
    sandbox: { ...BASE_REPORT.sandbox, ...overrides.sandbox },
    ...(overrides.inbox === undefined ? {} : { inbox: overrides.inbox }),
    ...(overrides.registry === undefined ? {} : { registry: overrides.registry }),
  };
}

function configSnapshot() {
  const config = {
    agents: {
      defaults: {
        workspace: WORKSPACE_ROOT,
        sandbox: { mode: "all", backend: "docker", scope: "agent" },
      },
    },
  };
  return {
    config,
    hash: "config-base-hash",
    issues: [],
    path: "/Users/operator/.openclaw/openclaw.json",
    raw: JSON.stringify(config),
    resolved: config,
    runtimeConfig: config,
    sourceConfig: config,
    valid: true,
  };
}

function accessMapScenario(
  overrides: Partial<ControlUiMockGatewayScenario> = {},
): ControlUiMockGatewayScenario {
  const { methodResponses: responseOverrides, ...scenarioOverrides } = overrides;
  return {
    defaultAgentId: AGENT_ID,
    mainSessionKey: SESSION_KEY,
    sessionKey: SESSION_KEY,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "agents.list",
      "fs.listDir",
      "sandbox.entries.add",
      "sandbox.explain",
      "sandbox.recreate",
    ],
    methodResponses: {
      "agents.list": {
        agents: [{ id: AGENT_ID, name: "Main" }],
        defaultId: AGENT_ID,
        mainKey: "main",
        scope: "agent",
      },
      "config.get": configSnapshot(),
      "fs.listDir": PICKER_LISTING,
      "sandbox.entries.add": {
        cases: [
          {
            match: { mode: "copy" },
            response: {
              entry: {
                name: "draft.md",
                kind: "file",
                hostPath: PICKER_FILE,
                containerPath: "/workspace/inbox/draft.md",
                mode: "copy",
              },
              recreateRequired: false,
            },
          },
          ...(["ro", "rw"] as const).map((mode) => ({
            match: { mode },
            response: {
              entry: {
                name: "draft.md",
                kind: "file",
                hostPath: PICKER_FILE,
                containerPath: "/mnt/shared/draft.md",
                mode,
              },
              recreateRequired: true,
            },
          })),
        ],
      },
      "sandbox.explain": BASE_REPORT,
      "sandbox.recreate": { removed: [CONTAINER_NAME], failed: [] },
      ...responseOverrides,
    },
    ...scenarioOverrides,
  };
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};
}

async function openAccessMap(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  const gateway = await installMockGateway(page, accessMapScenario(scenario));
  const response = await page.goto(`${suite.server.baseUrl}${ACCESS_MAP_PATH}`);
  expect(response?.status()).toBe(200);
  const root = page.locator('[data-testid="access-map"]');
  await root.waitFor();
  await expect
    .poll(async () => (await gateway.getRequests("sandbox.explain")).length)
    .toBeGreaterThan(0);
  return { gateway, root };
}

function drawer(page: Page) {
  return page.locator("openclaw-modal-dialog.access-map-modal");
}

function picker(page: Page) {
  return page.locator("openclaw-modal-dialog.access-map-picker-modal");
}

async function expectText(locator: Locator, text: string) {
  await expect.poll(() => locator.textContent()).toContain(text);
}

async function expectChecked(locator: Locator, checked: boolean) {
  await expect.poll(() => locator.isChecked()).toBe(checked);
}

async function expectDisabled(locator: Locator, disabled: boolean) {
  await expect.poll(() => locator.isDisabled()).toBe(disabled);
}

suite.define(() => {
  it("shows the effective inbox and mounts, then adds a Gateway file as a copy", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "ja-JP",
        serviceWorkers: "block",
        viewport: { width: 1775, height: 1058 },
      },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page, {
          methodResponses: {
            "sandbox.explain": sandboxReport({
              inbox: {
                hostPath: INBOX_HOST_PATH,
                containerPath: "/workspace/inbox",
                entries: [{ name: "README.md", kind: "file" }],
                counts: { files: 1, folders: 0, other: 0 },
                truncated: false,
              },
            }),
          },
        });

        await root.getByRole("heading", { name: "AIの権限範囲", exact: true }).waitFor({
          state: "visible",
        });
        await expectText(root, "追加したもの：1ファイル・0フォルダ");
        await root.locator(".access-map-entry", { hasText: "README.md" }).waitFor({
          state: "visible",
        });
        await expectText(
          root.locator(".access-map-entry", { hasText: "reference" }),
          "読み取り専用",
        );
        await expectText(root.locator(".access-map-entry", { hasText: "live" }), "読み書き");

        await root.getByRole("button", { name: "PCから追加", exact: true }).click();
        const mapPicker = picker(page);
        await mapPicker.waitFor();
        const listRequest = await gateway.waitForRequest("fs.listDir");
        expect(requestParams(listRequest)).toMatchObject({ includeFiles: true });
        await mapPicker.locator(".access-map-picker__entry", { hasText: "draft.md" }).click();

        const mapDrawer = drawer(page);
        await mapDrawer.waitFor();
        await expectText(mapDrawer, "PCからファイルを追加");
        await expectText(mapDrawer, "draft.md");
        await expectText(mapDrawer, "コピーして追加");
        await expectChecked(mapDrawer.locator('input[type="radio"][value="copy"]'), true);
        await expectChecked(mapDrawer.locator('input[type="radio"][value="ro"]'), false);
        await expectChecked(mapDrawer.locator('input[type="radio"][value="rw"]'), false);
        await mkdir(path.join(process.cwd(), ".artifacts", "access-map-ui"), { recursive: true });
        await page.screenshot({
          animations: "disabled",
          clip: { x: 288, y: 0, width: 1487, height: 1058 },
          path: path.join(process.cwd(), ".artifacts", "access-map-ui", "desktop-drawer-ja.png"),
        });
        await mapDrawer.getByRole("button", { name: "作業エリアに追加", exact: true }).click();

        const addRequest = await gateway.waitForRequest("sandbox.entries.add");
        expect(requestParams(addRequest)).toMatchObject({
          agentId: AGENT_ID,
          mode: "copy",
          source: { kind: "path", path: PICKER_FILE },
        });
      },
    );
  });

  it("normalizes a Docker backend and keeps an unavailable inbox out of the zero count", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page, {
          methodResponses: {
            "sandbox.explain": sandboxReport({
              inbox: null,
              sandbox: {
                backend: " DOCKER " as SandboxExplainResult["sandbox"]["backend"],
              },
            }),
          },
        });

        await expectText(root, "Inbox contents unavailable");
        await expect.poll(() => root.textContent()).not.toContain("Inbox: 0 files · 0 folders");
        await expectDisabled(root.getByRole("button", { name: "Add from PC", exact: true }), false);
        await expectDisabled(root.getByRole("button", { name: "Create new", exact: true }), false);
        await expectDisabled(root.locator("input.access-map-upload"), false);

        await root.getByRole("button", { name: "Create new", exact: true }).click();
        const mapDrawer = drawer(page);
        await mapDrawer.waitFor();
        await mapDrawer.getByRole("textbox", { name: "Name", exact: true }).fill("normalized.md");
        await mapDrawer.getByRole("button", { name: "Add to workspace", exact: true }).click();

        const addRequest = await gateway.waitForRequest("sandbox.entries.add");
        expect(requestParams(addRequest)).toMatchObject({
          agentId: AGENT_ID,
          mode: "copy",
          source: { kind: "create", name: "normalized.md", entryKind: "file" },
        });
      },
    );
  });

  it("fits a narrow mobile viewport and keeps the create drawer operable", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page);
        const artifactDir = path.join(process.cwd(), ".artifacts", "access-map-ui");
        await mkdir(artifactDir, { recursive: true });
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "mobile.png"),
        });

        await root.getByRole("button", { name: "Create new", exact: true }).click();
        const mapDrawer = drawer(page);
        await mapDrawer.waitFor();
        const nameInput = mapDrawer.getByRole("textbox", { name: "Name", exact: true });
        await nameInput.fill("mobile.md");
        await expect.poll(() => nameInput.inputValue()).toBe("mobile.md");
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "mobile-drawer.png"),
        });
        await mapDrawer.getByRole("button", { name: "Add to workspace", exact: true }).click();

        const addRequest = await gateway.waitForRequest("sandbox.entries.add");
        expect(requestParams(addRequest)).toMatchObject({
          agentId: AGENT_ID,
          mode: "copy",
          source: { kind: "create", name: "mobile.md", entryKind: "file" },
        });
      },
    );
  });

  it("creates a named empty file through the copy-only inbox action", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page);
        await root.getByRole("button", { name: "Create new", exact: true }).click();

        const mapDrawer = drawer(page);
        await mapDrawer.waitFor();
        await mapDrawer.getByRole("textbox", { name: "Name", exact: true }).fill("notes.md");
        await mapDrawer.getByRole("button", { name: "Add to workspace", exact: true }).click();

        const addRequest = await gateway.waitForRequest("sandbox.entries.add");
        expect(requestParams(addRequest)).toMatchObject({
          agentId: AGENT_ID,
          mode: "copy",
          source: { kind: "create", name: "notes.md", entryKind: "file" },
        });
      },
    );
  });

  it("accepts a 16 MiB browser upload while keeping sharing disabled", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page);
        const content = Buffer.alloc(16 * 1024 * 1024, 0x61);
        await root.locator("input.access-map-upload").setInputFiles({
          name: "browser-upload.bin",
          mimeType: "application/octet-stream",
          buffer: content,
        });

        const mapDrawer = drawer(page);
        await mapDrawer.waitFor();
        await expectText(mapDrawer, "browser-upload.bin");
        await expectChecked(mapDrawer.locator('input[type="radio"][value="copy"]'), true);
        await expectDisabled(mapDrawer.locator('input[type="radio"][value="ro"]'), true);
        await expectDisabled(mapDrawer.locator('input[type="radio"][value="rw"]'), true);
        await mapDrawer.getByRole("button", { name: "Add to workspace", exact: true }).click();

        const addRequest = await gateway.waitForRequest("sandbox.entries.add");
        const params = requestParams(addRequest);
        expect(params).toMatchObject({
          agentId: AGENT_ID,
          mode: "copy",
          source: { kind: "upload", name: "browser-upload.bin" },
        });
        expect((params.source as { contentBase64?: string }).contentBase64).toBe(
          content.toString("base64"),
        );
      },
    );
  });

  it("requires explicit consent before sending read-only and read-write external shares", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page);
        const shares = [
          { mode: "ro" as const, filePath: PICKER_FILE },
          { mode: "rw" as const, filePath: PICKER_FILE },
        ];

        for (const share of shares) {
          await root.getByRole("button", { name: "Add from PC", exact: true }).click();
          const mapPicker = picker(page);
          await mapPicker.waitFor();
          await mapPicker.locator(".access-map-picker__entry", { hasText: "draft.md" }).click();
          const mapDrawer = drawer(page);
          await mapDrawer.waitFor();
          await mapDrawer.locator(`input[type="radio"][value="${share.mode}"]`).check();
          const before = (await gateway.getRequests("sandbox.entries.add")).length;
          await mapDrawer.getByRole("button", { name: "Add to workspace", exact: true }).click();

          const consent = page.locator("openclaw-modal-dialog").last();
          await expectText(consent, "Share the original with AI?");
          expect((await gateway.getRequests("sandbox.entries.add")).length).toBe(before);
          await consent.getByRole("button", { name: "Allow this share", exact: true }).click();

          const addRequest = await gateway.waitForRequest("sandbox.entries.add", { after: before });
          expect(requestParams(addRequest)).toMatchObject({
            agentId: AGENT_ID,
            mode: share.mode,
            allowExternalSource: true,
            source: { kind: "path", path: share.filePath },
          });
          await mapDrawer.waitFor({ state: "detached" });
        }
      },
    );
  });

  it("keeps local sharing pending through a failed refresh, then clears it from a current report", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page);
        const beforeExplain = (await gateway.getRequests("sandbox.explain")).length;
        await gateway.deferNext("sandbox.explain");

        await root.getByRole("button", { name: "Add from PC", exact: true }).click();
        const mapPicker = picker(page);
        await mapPicker.waitFor();
        await mapPicker.locator(".access-map-picker__entry", { hasText: "draft.md" }).click();
        const mapDrawer = drawer(page);
        await mapDrawer.waitFor();
        await mapDrawer.locator('input[type="radio"][value="ro"]').check();
        await mapDrawer.getByRole("button", { name: "Add to workspace", exact: true }).click();

        const consent = page.locator("openclaw-modal-dialog").last();
        await expectText(consent, "Share the original with AI?");
        await consent.getByRole("button", { name: "Allow this share", exact: true }).click();
        await gateway.waitForRequest("sandbox.entries.add");
        await gateway.waitForRequest("sandbox.explain", { after: beforeExplain });
        await gateway.rejectDeferred("sandbox.explain", {
          code: "UNAVAILABLE",
          message: "Permissions refresh failed",
        });

        await expectText(root.getByRole("alert"), "Could not load access permissions.");
        await root.getByRole("button", { name: "Apply to container", exact: true }).waitFor({
          state: "visible",
        });

        await gateway.setMethodResponse(
          "sandbox.explain",
          sandboxReport({ registry: { ...BASE_REGISTRY, stale: false } }),
        );
        const nextExplain = (await gateway.getRequests("sandbox.explain")).length;
        await root.getByRole("button", { name: "Refresh permissions", exact: true }).click();
        await gateway.waitForRequest("sandbox.explain", { after: nextExplain });
        await root.getByRole("button", { name: "Apply to container", exact: true }).waitFor({
          state: "detached",
        });
      },
    );
  });

  it("keeps all mutating controls and RPCs unavailable to an operator.read caller", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page, {
          operatorScopes: ["operator.read"],
          methodResponses: {
            "sandbox.explain": sandboxReport({
              sandbox: { tools: { ...BASE_SANDBOX.tools, allow: [] } },
            }),
          },
        });

        await expectText(root, "You can view access");
        await root.getByRole("button", { name: /View effective permissions/ }).click();
        await expectText(root, "No allow-list restriction; denials still apply.");
        await expectDisabled(root.getByRole("button", { name: "Add from PC", exact: true }), true);
        await expectDisabled(root.getByRole("button", { name: "Create new", exact: true }), true);
        await expectDisabled(root.locator("input.access-map-upload"), true);
        expect(await gateway.getRequests("sandbox.entries.add")).toHaveLength(0);
        expect(await gateway.getRequests("sandbox.recreate")).toHaveLength(0);
        expect(await gateway.getRequests("fs.listDir")).toHaveLength(0);
      },
    );
  });

  it("retains a failed recreate error and reloads after a successful recreate", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page, {
          methodResponses: {
            "sandbox.explain": sandboxReport({
              registry: { ...BASE_REGISTRY, stale: true },
            }),
          },
        });
        const apply = root.getByRole("button", { name: "Apply to container", exact: true });
        await apply.waitFor({ state: "visible" });
        await gateway.deferNext("sandbox.recreate");
        await apply.click();
        const confirm = page.locator("openclaw-modal-dialog").last();
        await expectText(confirm, "Recreate this sandbox?");
        await confirm.getByRole("button", { name: "Apply to container", exact: true }).click();
        await gateway.waitForRequest("sandbox.recreate");
        await gateway.rejectDeferred("sandbox.recreate", {
          code: "UNAVAILABLE",
          message: "Docker unavailable",
        });
        await expectText(root.getByRole("alert"), "Docker unavailable");
        await expectText(root, "Sharing settings changed");
        await root.getByRole("button", { name: "Apply to container", exact: true }).waitFor({
          state: "visible",
        });
      },
    );

    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page, {
          methodResponses: {
            "sandbox.explain": sandboxReport({
              registry: { ...BASE_REGISTRY, stale: true },
            }),
          },
        });
        const beforeExplain = (await gateway.getRequests("sandbox.explain")).length;
        await gateway.setMethodResponse("sandbox.explain", sandboxReport({ registry: null }));
        await root.getByRole("button", { name: "Apply to container", exact: true }).click();
        const confirm = page.locator("openclaw-modal-dialog").last();
        await confirm.getByRole("button", { name: "Apply to container", exact: true }).click();
        await gateway.waitForRequest("sandbox.recreate");
        await expect
          .poll(async () => (await gateway.getRequests("sandbox.explain")).length)
          .toBeGreaterThan(beforeExplain);
        await expectText(root, "The old container was removed");
        await expectText(root, "Ready on next use");
      },
    );
  });

  it("renders recreate failures returned in a successful RPC response", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page, {
          methodResponses: {
            "sandbox.explain": sandboxReport({
              registry: { ...BASE_REGISTRY, stale: true },
            }),
            "sandbox.recreate": {
              removed: [],
              failed: [{ containerName: CONTAINER_NAME, error: "Docker unavailable" }],
            },
          },
        });
        const apply = root.getByRole("button", { name: "Apply to container", exact: true });
        await apply.waitFor({ state: "visible" });
        await apply.click();
        const confirm = page.locator("openclaw-modal-dialog").last();
        await expectText(confirm, "Recreate this sandbox?");
        await confirm.getByRole("button", { name: "Apply to container", exact: true }).click();
        await gateway.waitForRequest("sandbox.recreate");
        await expectText(
          root.getByRole("alert"),
          `Could not remove ${CONTAINER_NAME}: Docker unavailable`,
        );
      },
    );
  });

  it("keeps the rendered report and exposes a retry after refresh failure", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const { gateway, root } = await openAccessMap(page);
        const before = (await gateway.getRequests("sandbox.explain")).length;
        await gateway.deferNext("sandbox.explain");
        await root.getByRole("button", { name: "Refresh permissions", exact: true }).click();
        await gateway.waitForRequest("sandbox.explain", { after: before });
        await gateway.rejectDeferred("sandbox.explain", {
          code: "UNAVAILABLE",
          message: "Gateway read failed",
        });

        await expectText(root.getByRole("alert"), "Gateway read failed");
        await root.getByRole("alert").getByRole("button", { name: "Retry" }).waitFor({
          state: "visible",
        });
        await expectText(root, "Inbox: 1 files · 1 folders");
      },
    );
  });
});
