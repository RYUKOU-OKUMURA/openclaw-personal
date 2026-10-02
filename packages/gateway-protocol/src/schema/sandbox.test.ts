import { describe, expect, it } from "vitest";
import { validateSandboxEntriesAddParams, validateSandboxRecreateParams } from "../index.js";
import { MAX_TERMINAL_UPLOAD_BASE64_LENGTH } from "./terminal-constants.js";

describe("sandbox entry protocol", () => {
  it.each([
    { kind: "path", path: "/home/operator/source" },
    { kind: "upload", name: "notes.md", contentBase64: "" },
    { kind: "create", name: "notes.md", entryKind: "file" },
    { kind: "create", name: "notes", entryKind: "directory" },
  ])("accepts the copy source %j", (source) => {
    expect(validateSandboxEntriesAddParams({ mode: "copy", source })).toBe(true);
  });

  it.each(["ro", "rw"])("accepts a %s host share with explicit external consent", (mode) => {
    expect(
      validateSandboxEntriesAddParams({
        mode,
        source: { kind: "path", path: "/reference" },
        allowExternalSource: true,
      }),
    ).toBe(true);
  });

  it.each([
    { mode: "read", source: { kind: "path", path: "/reference" } },
    { mode: "ro", source: { kind: "upload", name: "x", contentBase64: "" } },
    { mode: "rw", source: { kind: "create", name: "x", entryKind: "file" } },
    { mode: "copy", source: { kind: "path", path: "/reference" }, allowExternalSource: true },
    {
      mode: "copy",
      destination: "/elsewhere",
      source: { kind: "create", name: "x", entryKind: "file" },
    },
    { mode: "copy", source: { kind: "create", name: "x", entryKind: "symlink" } },
    { mode: "copy", source: { kind: "upload", name: "x", path: "/reference", contentBase64: "" } },
  ])("rejects unsupported modes, mixed sources and client-selected destinations: %j", (params) => {
    expect(validateSandboxEntriesAddParams(params)).toBe(false);
  });

  it("rejects an oversized upload before decoding or writing", () => {
    expect(
      validateSandboxEntriesAddParams({
        mode: "copy",
        source: {
          kind: "upload",
          name: "large.bin",
          contentBase64: "A".repeat(MAX_TERMINAL_UPLOAD_BASE64_LENGTH + 1),
        },
      }),
    ).toBe(false);
  });
});

describe("sandbox recreate protocol", () => {
  it("accepts an optional agent and rejects client-selected runtime identities", () => {
    for (const params of [{}, { agentId: "main" }]) {
      expect(validateSandboxRecreateParams(params)).toBe(true);
    }
    for (const params of [
      { agentId: "" },
      { agentId: 1 },
      { containerName: "sandbox-other" },
      { all: true },
      { browser: true },
      { sessionKey: "agent:other:main" },
    ]) {
      expect(validateSandboxRecreateParams(params)).toBe(false);
    }
  });
});
