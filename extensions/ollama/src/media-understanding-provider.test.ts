import type { StructuredExtractionRequest } from "openclaw/plugin-sdk/media-understanding";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ollamaMediaUnderstandingProvider } from "./media-understanding-provider.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn() }));
vi.mock("openclaw/plugin-sdk/media-understanding", () => ({
  describeImageWithModel: vi.fn(),
  describeImagesWithModel: vi.fn(),
  describeImagesWithModelPayloadTransform: mocks.describe,
}));

const schema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
};
const request: StructuredExtractionRequest = {
  input: [
    { type: "text", text: "Captured at 12:00." },
    {
      type: "image",
      buffer: Buffer.from("synthetic-image"),
      fileName: "frame.jpg",
      mime: "image/jpeg",
    },
  ],
  instructions: "Describe the screen.",
  jsonSchema: schema,
  timeoutMs: 1000,
  agentDir: "/synthetic/agent",
  cfg: {},
  model: "vision-local",
  provider: "ollama",
};

describe("Ollama structured image extraction", () => {
  beforeEach(() => {
    mocks.describe
      .mockReset()
      .mockResolvedValue({ text: '{"summary":"Synthetic screen"}', model: "vision-local" });
  });

  it.each([undefined, 1024])(
    "sends images, schema, and output budget %s through the model transport",
    async (maxTokens) => {
      const result = await ollamaMediaUnderstandingProvider.extractStructured({
        ...request,
        maxTokens,
      });
      const [params, transform] = mocks.describe.mock.calls[0] ?? [];
      expect(params.images).toEqual([request.input[1]]);
      expect(params).toMatchObject({
        model: request.model,
        provider: "ollama",
        cfg: request.cfg,
        timeoutMs: 1000,
      });
      expect(params.maxTokens).toBe(maxTokens);
      expect(params.prompt).toContain("Captured at 12:00.");
      expect(params.prompt).toContain(JSON.stringify(schema));
      const payload = {
        messages: [{ role: "user", images: ["synthetic"] }],
        options: { num_predict: 4096 },
      };
      expect(await transform(payload, { api: "ollama" })).toEqual({
        ...payload,
        format: schema,
        think: false,
      });
      expect(result).toMatchObject({
        parsed: { summary: "Synthetic screen" },
        contentType: "json",
        provider: "ollama",
      });
    },
  );

  it.each(["", "not JSON", '{"summary":42}'])("rejects unusable output: %j", async (text) => {
    mocks.describe.mockResolvedValue({ text });
    await expect(ollamaMediaUnderstandingProvider.extractStructured(request)).rejects.toThrow();
  });

  it("preserves plain text extraction when JSON mode is explicitly disabled", async () => {
    mocks.describe.mockResolvedValue({ text: "Synthetic screen" });
    const result = await ollamaMediaUnderstandingProvider.extractStructured({
      ...request,
      jsonMode: false,
    });
    expect(result).toMatchObject({ text: "Synthetic screen", contentType: "text" });
    const [, transform] = mocks.describe.mock.calls[0] ?? [];
    expect(await transform({ messages: [] }, { api: "ollama" })).not.toHaveProperty("format");
  });

  it("does not silently send a native format to a different API", async () => {
    await ollamaMediaUnderstandingProvider.extractStructured(request);
    const [, transform] = mocks.describe.mock.calls[0] ?? [];
    expect(() => transform({}, { api: "openai-completions" })).toThrow(/native Ollama/i);
  });

  it("rejects missing images before calling the model", async () => {
    await expect(
      ollamaMediaUnderstandingProvider.extractStructured({ ...request, input: [] }),
    ).rejects.toThrow(/image/i);
    expect(mocks.describe).not.toHaveBeenCalled();
  });
});
