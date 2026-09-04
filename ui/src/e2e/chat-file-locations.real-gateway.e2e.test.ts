// Real filesystem + isolated Gateway proof for the shared-materials/output workflow.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.ts";
import { callGateway } from "../../../src/gateway/call.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat file locations with a real Gateway",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("opens shared notes and generated outputs from the same Files panel without relocating either", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "chat-file-locations",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    try {
      const workspace = state.path("workspace");
      const shared = state.path("Shared Notes");
      await Promise.all([
        mkdir(path.join(workspace, "outputs"), { recursive: true }),
        mkdir(shared),
      ]);
      await Promise.all([
        writeFile(path.join(workspace, "AGENTS.md"), "# Workspace instructions\n"),
        writeFile(path.join(workspace, "outputs/report.md"), "Deliverable from the agent.\n"),
        writeFile(path.join(shared, "notes.md"), "This note is read-only.\n"),
      ]);
      await state.writeConfig({
        agents: {
          defaults: {
            workspace,
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceAccess: "rw",
              docker: {
                binds: [`${shared}:/mnt/shared/Shared Notes:ro`],
                dangerouslyAllowExternalBindSources: true,
              },
            },
          },
          entries: { main: { workspace } },
        },
        gateway: {
          auth: { mode: "none" },
          controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
          port,
        },
      });
      state.applyEnv();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "file-locations-proof", updatedAt: Date.now() },
      );
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      // The source-only Gateway lazily loads provider catalogs synchronously. Warm the
      // unrelated chat voice catalog before Playwright's interaction deadlines begin.
      await callGateway({ method: "talk.catalog", localPortOverride: port, timeoutMs: 120_000 });
      await suite.withPage(
        {
          locale: "en-US",
          colorScheme: "dark",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
          recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 1000 } },
        },
        async ({ page }) => {
          const url = new URL("chat", suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          url.searchParams.set("session", "agent:main:main");
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
          await openChatSidePanelType(page, "Files");
          const rail = page.locator(".chat-workspace-rail");
          await rail.getByRole("button", { name: "Shared materials", exact: true }).waitFor();
          await page.screenshot({ path: path.join(suite.artifactDir, "01-work-files.png") });
          await rail.getByRole("button", { name: "Shared materials", exact: true }).click();
          await rail.getByRole("button", { name: "Shared Notes", exact: true }).click();
          const sharedFile = rail.locator(".chat-workspace-rail__file-name", {
            hasText: "notes.md",
          });
          await sharedFile.waitFor();
          await page.screenshot({ path: path.join(suite.artifactDir, "02-shared-files.png") });
          await sharedFile.click();
          await page.getByText("This note is read-only.", { exact: true }).waitFor();
          expect(await page.getByRole("button", { name: "Edit file", exact: true }).count()).toBe(
            0,
          );
          expect(
            await page.getByRole("button", { name: "Open in editor", exact: true }).count(),
          ).toBe(0);
          expect(
            await page.getByRole("button", { name: "Show in Files", exact: true }).count(),
          ).toBe(0);
          await page.screenshot({ path: path.join(suite.artifactDir, "03-shared-preview.png") });
          await page
            .locator(".side-panel__header-tabs wa-tab")
            .filter({ hasText: "Files" })
            .click();
          await rail.getByRole("button", { name: "Outputs", exact: true }).click();
          const outputFile = rail.locator(".chat-workspace-rail__file-name", {
            hasText: "report.md",
          });
          await outputFile.waitFor();
          await page.screenshot({ path: path.join(suite.artifactDir, "04-outputs.png") });
          await outputFile.click();
          await page.getByText("Deliverable from the agent.", { exact: true }).waitFor();
          await page.screenshot({ path: path.join(suite.artifactDir, "05-output-preview.png") });
        },
      );
      expect(await readFile(path.join(shared, "notes.md"), "utf8")).toBe(
        "This note is read-only.\n",
      );
      expect(await readFile(path.join(workspace, "outputs/report.md"), "utf8")).toBe(
        "Deliverable from the agent.\n",
      );
    } finally {
      try {
        await gateway?.close({ reason: "file locations proof cleanup" });
      } finally {
        await state.cleanup();
      }
    }
  });
});
