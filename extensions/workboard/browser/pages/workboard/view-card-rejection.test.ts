import "../../test/dom.setup.ts";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { renderWorkboardRejection } from "./view-card-rejection.ts";
import type { WorkboardProps } from "./view-helpers.ts";

function createProps(host: object, overrides: Partial<WorkboardProps> = {}): WorkboardProps {
  return {
    host,
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    connected: true,
    canWrite: true,
    agentsList: null,
    sessions: [],
    onOpenSession: vi.fn(),
    onRequestUpdate: vi.fn(),
    ...overrides,
  };
}

function renderRejection(props: WorkboardProps, card = createWorkboardCard({ status: "triage" })) {
  getWorkboardState(props.host).loaded = true;
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  render(renderWorkboardRejection(props, card), container);
  return { card, container };
}

describe("Workboard card rejection controls", () => {
  it("keeps the rejection action disabled for read-only operators", () => {
    const host = {};
    const props = createProps(host, { canWrite: false });
    const { container } = renderRejection(props);

    const reject = container.querySelector<HTMLButtonElement>("button");
    expect(reject).toBeTruthy();
    expect(reject?.disabled).toBe(true);
    expect(props.client?.request).not.toHaveBeenCalled();
  });

  it("requires detail before confirming the Other reason", () => {
    const host = {};
    const props = createProps(host);
    const { card, container } = renderRejection(props);

    container.querySelector<HTMLButtonElement>("button")?.click();
    render(renderWorkboardRejection(props, card), container);
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select).toBeTruthy();
    select!.value = "other";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    render(renderWorkboardRejection(props, card), container);

    const confirm = container.querySelector<HTMLButtonElement>("button.btn.danger");
    expect(confirm?.disabled).toBe(true);

    const detail = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(detail).toBeTruthy();
    detail!.value = "The customer segment is too small.";
    detail!.dispatchEvent(new Event("input", { bubbles: true }));
    render(renderWorkboardRejection(props, card), container);

    expect(container.querySelector<HTMLButtonElement>("button.btn.danger")?.disabled).toBe(false);
  });
});
