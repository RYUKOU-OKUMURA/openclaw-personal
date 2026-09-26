import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../../../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../../../../ui/src/test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../../../../ui/src/test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../../../../ui/src/test-helpers/control-ui-workboard-fixture.ts";
import { workboardSqliteBackendEntrypoint } from "../../../src/sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "../../../src/sqlite-store.js";
import { WorkboardStore } from "../../../src/store.js";

const suite = createControlUiE2eSuite({ name: "Workboard planning SQLite browser flow" });
const dirs = useAutoCleanupTempDirTracker(afterEach);

suite.define(() => {
  it("edits planning columns, moves the same card, and reloads without changing execution status", async () => {
    const dbPath = path.join(dirs.make("workboard-planning-browser-"), "workboard.sqlite");
    const persistence = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
    const store = new WorkboardStore(persistence.cards, persistence);
    const card = await store.create({
      title: "Validate subscription concept",
      status: "todo",
      position: 27,
    });
    await store.updatePlanning({
      boardId: "default",
      expectedRevision: 0,
      columns: [
        { id: "inbox", name: "Inbox", width: 300, order: 0 },
        { id: "ideas", name: "Ideas", width: 320, order: 1 },
        { id: "validation", name: "Validation", width: 360, order: 2 },
      ],
    });
    try {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 2200, height: 1000 } },
        async ({ page }) => {
          const config = { plugins: { entries: { workboard: { enabled: true } } } };
          const gateway = await installMockGateway(page, {
            ...workboardUi,
            methodResponses: {
              "config.get": {
                config,
                resolved: config,
                sourceConfig: config,
                raw: JSON.stringify(config),
                hash: "planning-fixture",
                path: "/tmp/planning-fixture/openclaw.json",
              },
              "workboard.cards.list": {
                cards: [card],
                ...(await store.listBoards()),
                statuses: WORKBOARD_STATUSES,
              },
              "workboard.planning.get": { planning: await store.getPlanning("default") },
              "tasks.list": { tasks: [], nextCursor: null },
            },
          });
          // The wire is mocked, but every planning mutation is committed by the real SQLite owner.
          const commit = async (
            method: "workboard.planning.update" | "workboard.planning.move",
            action: () => Promise<unknown>,
          ) => {
            const after = (await gateway.getRequests(method)).length;
            await gateway.deferNext(method);
            await action();
            const request = await gateway.waitForRequest(method, { after });
            const params = request.params;
            if (!isRecord(params)) {
              throw new Error("planning request params missing");
            }
            const planning =
              method === "workboard.planning.update"
                ? await store.updatePlanning(params)
                : await store.movePlanningCard(params);
            await gateway.setMethodResponse("workboard.planning.get", { planning });
            await gateway.resolveDeferred(method, { planning });
            await expect.poll(() => page.locator(".workboard-planning-editor").count()).toBe(0);
            return planning;
          };
          const proof =
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
              ? createControlUiE2eArtifactDir("planning")
              : undefined;
          const capture = async (name: string) => {
            if (proof) {
              await writeFile(
                path.join(proof, name + ".png"),
                await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
                  page.locator(".workboard-planning-board"),
                ]),
              );
            }
          };
          expect(
            (await page.goto(`${suite.server.baseUrl}workboard?board=default`))?.status(),
          ).toBe(200);
          await page.locator(".workboard-planning-board").waitFor({ state: "visible" });
          await capture("01-before");
          const editPlanning = page
            .locator(".workboard-planning-toolbar")
            .getByRole("button", { name: "Edit board", exact: true });
          await editPlanning.click();
          const editor = page.getByRole("region", { name: "Edit board", exact: true });
          const rows = editor.locator(".workboard-planning-editor__row");
          await rows.nth(1).getByLabel("Column name", { exact: true }).fill("Considering");
          await rows.nth(1).getByLabel("Width (px)", { exact: true }).fill("400");
          await editor.getByRole("button", { name: /Add column/ }).click();
          await rows.last().getByLabel("Column name", { exact: true }).fill("Revenue");
          await rows.last().getByLabel("Width (px)", { exact: true }).fill("420");
          await rows.last().getByRole("button", { name: "Move column left", exact: true }).click();
          await rows.nth(2).getByRole("button", { name: "Move column right", exact: true }).click();
          await rows.last().getByRole("button", { name: "Move column left", exact: true }).click();
          await capture("02-editor");
          const edited = await commit("workboard.planning.update", () =>
            editor.getByRole("button", { name: "Save", exact: true }).click(),
          );
          expect(edited.columns.map((column) => column.name)).toEqual([
            "Inbox",
            "Considering",
            "Revenue",
            "Validation",
          ]);
          expect(edited.columns.map((column) => column.width)).toEqual([300, 400, 420, 360]);
          const handle = page.getByRole("separator", {
            name: "Resize column: Revenue",
            exact: true,
          });
          const handleBox = await handle.boundingBox();
          if (!handleBox) {
            throw new Error("Revenue resize handle is not visible");
          }
          const resized = await commit("workboard.planning.update", async () => {
            await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40);
            await page.mouse.down();
            await page.mouse.move(handleBox.x + handleBox.width / 2 + 40, handleBox.y + 40, {
              steps: 5,
            });
            await page.mouse.up();
          });
          expect(resized.columns.find((column) => column.name === "Revenue")?.width).toBe(460);
          const planningCard = page
            .locator(".workboard-planning-card")
            .filter({ hasText: card.title });
          await commit("workboard.planning.move", () =>
            planningCard
              .locator(".workboard-card")
              .dragTo(
                page
                  .locator(".workboard-planning-column")
                  .filter({ has: page.getByRole("heading", { name: "Validation", exact: true }) }),
              ),
          );
          await commit("workboard.planning.move", () =>
            planningCard
              .getByRole("combobox", { name: `Planning column: ${card.title}`, exact: true })
              .selectOption("ideas"),
          );
          const column = (name: string) =>
            page
              .locator(".workboard-planning-column")
              .filter({ has: page.getByRole("heading", { name, exact: true }) });
          await expect.poll(() => column("Considering").textContent()).toContain(card.title);
          await expect
            .poll(() =>
              planningCard
                .getByRole("combobox", { name: `Planning column: ${card.title}`, exact: true })
                .inputValue(),
            )
            .toBe("ideas");
          await capture("02-edited-and-moved");
          await page.getByRole("button", { name: "Execution status", exact: true }).click();
          const todo = page
            .locator(".workboard-column")
            .filter({ has: page.getByRole("heading", { name: "Todo", exact: true }) });
          await expect.poll(() => todo.textContent()).toContain(card.title);
          expect(await store.get(card.id)).toEqual(card);
          expect(await gateway.getRequests("workboard.cards.move")).toHaveLength(0);
          await page.getByRole("button", { name: "Planning", exact: true }).click();
          await editPlanning.click();
          const considering = rows.nth(1);
          expect(
            await considering
              .getByRole("button", { name: "Remove column", exact: true })
              .isDisabled(),
          ).toBe(true);
          expect(
            await rows.first().getByRole("button", { name: "Remove column", exact: true }).count(),
          ).toBe(0);
          await considering
            .getByRole("combobox", { name: "Move cards before removal: Considering", exact: true })
            .selectOption("validation");
          await considering.getByRole("button", { name: "Remove column", exact: true }).click();
          const deleted = await commit("workboard.planning.update", () =>
            editor.getByRole("button", { name: "Save", exact: true }).click(),
          );
          expect(deleted.columns.map((item) => item.name)).toEqual([
            "Inbox",
            "Revenue",
            "Validation",
          ]);
          expect(deleted.cards).toEqual([{ cardId: card.id, columnId: "validation", order: 0 }]);
          await page.reload();
          await expect.poll(() => column("Validation").textContent()).toContain(card.title);
          await expect
            .poll(() =>
              planningCard
                .getByRole("combobox", { name: `Planning column: ${card.title}`, exact: true })
                .inputValue(),
            )
            .toBe("validation");
          expect(await column("Considering").count()).toBe(0);
          await capture("03-reloaded-after-removal");
          await store.close();
          const reopenedPersistence = createWorkboardSqliteStores({
            dbPath,
            workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
          });
          const reopened = new WorkboardStore(reopenedPersistence.cards, reopenedPersistence);
          try {
            expect(await reopened.getPlanning("default")).toEqual(deleted);
            expect(await reopened.get(card.id)).toEqual(card);
          } finally {
            await reopened.close();
          }
          if (proof) {
            await writeFile(
              path.join(proof, "proof.json"),
              JSON.stringify(
                {
                  mockedGateway: true,
                  realSqliteOwner: true,
                  chromiumUi: true,
                  columns: deleted.columns,
                  revision: deleted.revision,
                  executionStatus: card.status,
                },
                null,
                2,
              ),
            );
          }
        },
      );
    } finally {
      await store.close();
    }
  });
});
