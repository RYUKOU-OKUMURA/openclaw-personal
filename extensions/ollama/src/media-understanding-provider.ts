// Ollama provider module implements model/runtime integration.
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import {
  describeImagesWithModelPayloadTransform,
  type MediaUnderstandingProvider,
  type StructuredExtractionRequest,
  type StructuredExtractionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OLLAMA_PROVIDER_ID } from "./discovery-shared.js";

async function extractOllamaStructured(
  request: StructuredExtractionRequest,
): Promise<StructuredExtractionResult> {
  const images = request.input.filter((entry) => entry.type === "image");
  if (images.length === 0) {
    throw new Error("Ollama structured extraction requires at least one image input.");
  }
  const jsonMode = request.jsonMode !== false;
  const prompt = [
    request.instructions,
    ...request.input.filter((entry) => entry.type === "text").map((entry) => entry.text),
    request.jsonSchema !== undefined ? `JSON schema:\n${JSON.stringify(request.jsonSchema)}` : "",
    jsonMode ? "Return valid JSON only, without Markdown fences." : "Return concise text.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const result = await describeImagesWithModelPayloadTransform(
    {
      images,
      prompt,
      model: request.model,
      provider: request.provider,
      cfg: request.cfg,
      agentDir: request.agentDir,
      profile: request.profile,
      preferredProfile: request.preferredProfile,
      authStore: request.authStore,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    },
    (payload, model) => {
      if (model.api !== "ollama" || !isRecord(payload)) {
        throw new Error("Structured extraction requires the native Ollama API (api: ollama).");
      }
      return {
        ...payload,
        think: false,
        ...(jsonMode ? { format: request.jsonSchema ?? "json" } : {}),
      };
    },
  );
  if (!result.text.trim()) {
    throw new Error("Ollama structured extraction returned no text.");
  }
  let parsed: unknown;
  if (jsonMode) {
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new Error("Ollama structured extraction returned invalid JSON.");
    }
    if (isRecord(request.jsonSchema) || typeof request.jsonSchema === "boolean") {
      const validation = validateJsonSchemaValue({
        schema: request.jsonSchema,
        value: parsed,
        cacheKey: "ollama.media-understanding.extractStructured",
        cache: false,
      });
      if (!validation.ok) {
        throw new Error("Ollama structured extraction JSON did not match the requested schema.");
      }
      parsed = validation.value;
    }
  }
  return {
    ...result,
    provider: request.provider,
    contentType: jsonMode ? "json" : "text",
    ...(jsonMode ? { parsed } : {}),
  };
}

// Ollama vision support depends on which models the user has pulled (llava,
// qwen2.5vl, llama3.2-vision, …) — there is no single canonical default. We
// register the provider so the image tool can route `ollama/<vision-model>`
// requests, but leave `defaultModels` and `autoPriority` unset so Ollama
// only participates when the user explicitly configures an image model.
export const ollamaMediaUnderstandingProvider = {
  id: OLLAMA_PROVIDER_ID,
  capabilities: ["image"],
  extractStructured: extractOllamaStructured,
} satisfies MediaUnderstandingProvider;
