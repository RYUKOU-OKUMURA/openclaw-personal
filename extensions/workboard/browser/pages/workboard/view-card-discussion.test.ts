import "../../test/dom.setup.ts";
import type { ModelChoice } from "@openclaw/gateway-protocol";
import { nothing, render } from "lit";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderWorkboardDiscussion } from "./view-card-discussion.ts";
import type { WorkboardProps } from "./view-helpers.ts";

const mockDiscussWorkboardCard = vi.hoisted(() => vi.fn());
const mockDiscussionSessionKey = vi.hoisted(() => vi.fn());

vi.mock("../../lib/workboard/discussion.ts", () => ({
  discussWorkboardCard: mockDiscussWorkboardCard,
  discussionSessionKey: mockDiscussionSessionKey,
}));

function createProps(
  host: object,
  request: unknown,
  overrides: Partial<WorkboardProps> = {},
): WorkboardProps {
  return {
    host,
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    agentsList: null,
    defaultAgentId: "main",
    sessions: [],
    onOpenSession: vi.fn(),
    onRequestUpdate: vi.fn(),
    ...overrides,
  };
}

function renderDiscussion(props: WorkboardProps, card = createWorkboardCard()) {
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  render(renderWorkboardDiscussion(props, card), container);
  return { card, container };
}

function model(provider: string, id: string, overrides: Partial<ModelChoice> = {}): ModelChoice {
  return {
    provider,
    id,
    name: id,
    available: true,
    ...overrides,
  } as ModelChoice;
}

describe("Workboard card discussion entry", () => {
  beforeEach(() => {
    mockDiscussWorkboardCard.mockReset();
    mockDiscussionSessionKey.mockReset();
    mockDiscussionSessionKey.mockReturnValue(undefined);
  });

  it("checks the catalog before selecting Luna and keeps GLM available", async () => {
    const host = {};
    const request = vi.fn(async () => ({
      models: [
        model("zai", "glm-5.3"),
        model("openai", "gpt-5.6-luna", {
          name: "Luna",
          thinkingLevels: [{ id: "max", label: "max" }],
        }),
      ],
    }));
    const props = createProps(host, request);
    const { container, card } = renderDiscussion(props);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("models.list", expect.anything()));
    render(renderWorkboardDiscussion(props, card), container);

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
    expect(select?.value).toBe("openai/gpt-5.6-luna");
    expect([...select!.options].map((option) => option.value)).toEqual([
      "",
      "zai/glm-5.3",
      "openai/gpt-5.6-luna",
    ]);
    const next = "zai/glm-5.3";
    Object.defineProperty(select, "value", { configurable: true, value: next, writable: true });
    select?.dispatchEvent(new Event("change", { bubbles: true }));
    Reflect.deleteProperty(select!, "value");
    render(renderWorkboardDiscussion(props, card), container);

    mockDiscussWorkboardCard.mockResolvedValueOnce("agent:main:discussion");
    container.querySelector<HTMLButtonElement>('button[aria-label="Start discussion"]')?.click();
    await waitForFast(() => expect(mockDiscussWorkboardCard).toHaveBeenCalledOnce());

    expect(mockDiscussWorkboardCard).toHaveBeenCalledWith(
      expect.objectContaining({
        card,
        agentId: "main",
        model: "zai/glm-5.3",
      }),
    );
    expect(mockDiscussWorkboardCard.mock.calls[0]?.[0]).not.toHaveProperty("thinkingLevel");
    expect(mockDiscussWorkboardCard.mock.calls[0]?.[0]).not.toHaveProperty("fastMode");
    expect(props.onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:discussion" });
  });

  it("keeps an archived card's persisted discussion open instead of the execution session", () => {
    const host = {};
    const request = vi.fn();
    const onOpenSession = vi.fn();
    const props = createProps(host, request, { onOpenSession });
    const card = createWorkboardCard({
      sessionKey: "agent:main:execution",
      metadata: { archivedAt: 1 },
    });
    mockDiscussionSessionKey.mockReturnValue("agent:main:discussion");
    const { container } = renderDiscussion(props, card);

    container.querySelector<HTMLButtonElement>('button[aria-label="Continue discussion"]')?.click();

    expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:discussion" });
    expect(request).not.toHaveBeenCalled();
    expect(mockDiscussWorkboardCard).not.toHaveBeenCalled();
  });

  it("passes max and fast only when the preferred Luna model is available", async () => {
    const host = {};
    const request = vi.fn(async () => ({
      models: [model("openai", "gpt-5.6-luna", { name: "Luna" })],
    }));
    const props = createProps(host, request);
    const { container, card } = renderDiscussion(props);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("models.list", expect.anything()));
    render(renderWorkboardDiscussion(props, card), container);
    mockDiscussWorkboardCard.mockResolvedValueOnce("agent:main:discussion");
    container.querySelector<HTMLButtonElement>('button[aria-label="Start discussion"]')?.click();
    await waitForFast(() => expect(mockDiscussWorkboardCard).toHaveBeenCalledOnce());

    expect(mockDiscussWorkboardCard).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        model: "openai/gpt-5.6-luna",
        thinkingLevel: "max",
        fastMode: true,
      }),
    );
  });

  it("uses the default agent for an unassigned card in the catalog and discussion session", async () => {
    const host = {};
    const request = vi.fn(async () => ({
      models: [model("openai", "gpt-5.6-luna")],
    }));
    const props = createProps(host, request, { defaultAgentId: "research" });
    const card = createWorkboardCard({ agentId: undefined });
    const { container } = renderDiscussion(props, card);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("models.list", expect.anything()));
    expect(request).toHaveBeenCalledWith(
      "models.list",
      expect.objectContaining({ agentId: "research" }),
    );
    render(renderWorkboardDiscussion(props, card), container);
    mockDiscussWorkboardCard.mockResolvedValueOnce("agent:research:discussion");
    container.querySelector<HTMLButtonElement>('button[aria-label="Start discussion"]')?.click();
    await waitForFast(() => expect(mockDiscussWorkboardCard).toHaveBeenCalledOnce());

    expect(mockDiscussWorkboardCard).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
  });

  it("clears the old catalog before loading a changed card agent", async () => {
    const host = {};
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: [model("zai", "glm-5.3")] })
      .mockRejectedValueOnce(new Error("research model catalog unavailable"));
    const props = createProps(host, request);
    const card = createWorkboardCard({ agentId: "main" });
    const { container } = renderDiscussion(props, card);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    render(renderWorkboardDiscussion(props, card), container);
    expect(container.querySelector('option[value="zai/glm-5.3"]')).toBeTruthy();

    card.agentId = "research";
    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    render(renderWorkboardDiscussion(props, card), container);
    expect(container.querySelector('option[value="zai/glm-5.3"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Start discussion"]')).toBeNull();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    render(renderWorkboardDiscussion(props, card), container);
    expect(container.querySelector('option[value="zai/glm-5.3"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Start discussion"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "research model catalog unavailable",
    );
  });

  it("offers the created chat as recovery and disables a second start", async () => {
    const host = {};
    const request = vi.fn(async () => ({
      models: [model("openai", "gpt-5.6-luna")],
    }));
    const props = createProps(host, request);
    const { container, card } = renderDiscussion(props);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("models.list", expect.anything()));
    render(renderWorkboardDiscussion(props, card), container);
    mockDiscussWorkboardCard.mockImplementationOnce(async ({ onUnlinkedSession }) => {
      onUnlinkedSession?.("agent:main:recovery");
      return null;
    });
    container.querySelector<HTMLButtonElement>('button[aria-label="Start discussion"]')?.click();
    await waitForFast(() => expect(mockDiscussWorkboardCard).toHaveBeenCalledOnce());
    render(renderWorkboardDiscussion(props, card), container);

    const start = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start discussion"]',
    );
    expect(start?.disabled).toBe(true);
    const openCreated = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Open the created chat"),
    );
    expect(openCreated).toBeTruthy();
    openCreated?.click();
    expect(props.onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:recovery" });
  });

  it("retries a successful empty catalog when the entry is reopened", async () => {
    const host = {};
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [model("openai", "gpt-5.6-luna")] });
    const props = createProps(host, request);
    const { container, card } = renderDiscussion(props);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    render(renderWorkboardDiscussion(props, card), container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("No available models");

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    render(renderWorkboardDiscussion(props, card), container);

    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe(
      "openai/gpt-5.6-luna",
    );
  });

  it("keeps the workboard recovery error visible after the discussion link is saved", async () => {
    const host = {};
    const request = vi.fn(async () => ({
      models: [model("openai", "gpt-5.6-luna")],
    }));
    const props = createProps(host, request);
    const { container, card } = renderDiscussion(props);

    container.querySelector<HTMLButtonElement>('button[aria-label="Discuss this card"]')?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("models.list", expect.anything()));
    render(renderWorkboardDiscussion(props, card), container);
    mockDiscussWorkboardCard.mockImplementationOnce(async ({ host: discussionHost }) => {
      getWorkboardState(discussionHost).error =
        "Open the card's discussion to continue; the initial card context was not confirmed sent.";
      return null;
    });
    container.querySelector<HTMLButtonElement>('button[aria-label="Start discussion"]')?.click();
    await waitForFast(() => expect(mockDiscussWorkboardCard).toHaveBeenCalledOnce());

    mockDiscussionSessionKey.mockReturnValue("agent:main:discussion");
    render(renderWorkboardDiscussion(props, card), container);

    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Continue discussion"]'),
    ).toBeTruthy();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "initial card context was not confirmed sent",
    );
  });
});
