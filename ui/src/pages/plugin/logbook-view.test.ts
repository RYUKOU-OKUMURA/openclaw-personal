import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { getLogbookState, stopLogbookPolling } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";

describe("Logbook view", () => {
  it("renders timeline clocks in the capture host timezone", () => {
    const host = {};
    const state = getLogbookState(host);
    state.day = "2026-01-01";
    state.status = {
      captureEnabled: true,
      capturePaused: false,
      captureSchedule: null,
      captureSchedulePaused: false,
      captureIntervalSeconds: 30,
      analysisIntervalMinutes: 15,
      retentionDays: 30,
      pendingFrames: 0,
      analysisRunning: false,
      visionModelSource: "missing",
      today: "2026-01-01",
      todayCards: 1,
      timeZone: "America/Los_Angeles",
    };
    state.timeline = {
      day: state.day,
      cards: [
        {
          id: 1,
          day: state.day,
          startMs: Date.UTC(2026, 0, 2, 0, 30),
          endMs: Date.UTC(2026, 0, 2, 1, 30),
          title: "Work",
          summary: "Summary",
          detail: "",
          category: "Coding",
          distractions: [],
        },
      ],
      stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
    };

    const container = document.createElement("div");
    render(renderLogbook({ host, client: null, connected: false }), container);

    const timeOptions = {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    } satisfies Intl.DateTimeFormatOptions;
    const expectedTime = [Date.UTC(2026, 0, 2, 0, 30), Date.UTC(2026, 0, 2, 1, 30)]
      .map((ms) => new Date(ms).toLocaleTimeString(i18n.getLocale(), timeOptions))
      .join("–");
    expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe(expectedTime);
    expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
  });
  it("edits and disables a nightly capture schedule without losing unsaved times to polling", async () => {
    const host = {};
    const state = getLogbookState(host);
    state.status = {
      captureEnabled: true,
      capturePaused: false,
      captureSchedule: { start: "23:00", end: "08:00" },
      captureSchedulePaused: true,
      captureIntervalSeconds: 30,
      analysisIntervalMinutes: 15,
      retentionDays: 30,
      pendingFrames: 0,
      analysisRunning: true,
      visionModelSource: "missing",
      today: state.day,
      todayCards: 0,
      timeZone: "Asia/Tokyo",
    };
    state.timeline = {
      day: state.day,
      cards: [],
      stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
    };
    const request = vi.fn(
      async (_method: string, params: { schedule: { start: string; end: string } | null }) => ({
        ...state.status!,
        captureSchedule: params.schedule,
        captureSchedulePaused: params.schedule !== null,
      }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");
    const update = () =>
      render(renderLogbook({ host, client, connected: true, onRequestUpdate: update }), container);
    try {
      update();
      expect(container.querySelector(".logbook__chips")?.textContent).toContain(
        "Capture paused by schedule",
      );
      expect(container.textContent).toContain("Asia/Tokyo");
      const times = container.querySelectorAll<HTMLInputElement>('input[type="time"]');
      times[0]!.value = "22:30";
      times[0]!.dispatchEvent(new Event("input"));
      state.status = { ...state.status!, captureSchedule: { start: "21:00", end: "07:00" } };
      update();
      expect(times[0]!.value).toBe("22:30");
      expect(times[1]!.value).toBe("08:00");
      const form = container.querySelector<HTMLFormElement>(".logbook-schedule")!;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() => expect(state.actionPending).toBe(false));
      expect(request).toHaveBeenLastCalledWith("logbook.schedule.set", {
        schedule: { start: "22:30", end: "08:00" },
      });
      expect(state.scheduleDraft).toBeNull();
      const enabled = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      enabled.checked = false;
      enabled.dispatchEvent(new Event("change"));
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() => expect(state.actionPending).toBe(false));
      expect(request).toHaveBeenLastCalledWith("logbook.schedule.set", { schedule: null });
      expect(container.querySelector(".logbook__chips")?.textContent).toContain(
        "Capturing every 30s",
      );
    } finally {
      stopLogbookPolling(host);
    }
  });
});
