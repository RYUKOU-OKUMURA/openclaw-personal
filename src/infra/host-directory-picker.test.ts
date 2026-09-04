// Native folder-picker tests mock the subprocess boundary so no Finder dialog is opened.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { pickHostDirectory } from "./host-directory-picker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function commandResult(
  overrides: Partial<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  }> = {},
) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    ...overrides,
  };
}

describe("pickHostDirectory", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
  });

  it("passes the initial path as a separate argv and verifies the selected directory", async () => {
    const root = tempDirs.make("openclaw-native-picker-");
    const initialPath = path.join(root, 'folder "with quotes" 日本語 ');
    const selectedPath = path.join(root, "selected");
    await fs.mkdir(initialPath);
    await fs.mkdir(selectedPath);
    runCommandWithTimeoutMock.mockResolvedValue(commandResult({ stdout: `${selectedPath}\n` }));

    await expect(pickHostDirectory({ path: initialPath })).resolves.toEqual({ path: selectedPath });

    const [argv, options] = runCommandWithTimeoutMock.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ];
    expect(argv[0]).toBe("/usr/bin/osascript");
    expect(argv[1]).toBe("-e");
    expect(argv[2]).toContain("choose folder");
    expect(argv[2]).not.toContain(initialPath);
    expect(argv[3]).toBe(initialPath);
    expect(options).toMatchObject({
      timeoutMs: 120_000,
      killProcessTree: true,
      maxOutputBytes: 16 * 1024,
    });
  });

  it("keeps spaces and the literal cancel marker in a successful selected path", async () => {
    const root = tempDirs.make("openclaw-native-picker-");
    const selectedPath = path.join(root, "folder (-128) with trailing space ");
    await fs.mkdir(selectedPath);
    runCommandWithTimeoutMock.mockResolvedValue(commandResult({ stdout: `${selectedPath}\n` }));

    await expect(pickHostDirectory({ path: root })).resolves.toEqual({ path: selectedPath });
  });

  it("maps AppleScript user cancellation to the protocol cancellation result", async () => {
    runCommandWithTimeoutMock.mockResolvedValue(
      commandResult({ code: 1, stderr: "execution error: User canceled. (-128)" }),
    );

    await expect(pickHostDirectory({ path: "/tmp" })).resolves.toEqual({ cancelled: true });
  });

  it.each([
    ["timeout", commandResult({ code: 124, termination: "timeout" }), "timed out"],
    [
      "non-cancel failure",
      commandResult({ code: 1, stderr: "execution error: permission denied (42)" }),
      "failed",
    ],
    [
      "failure mentioning the cancel marker",
      commandResult({ code: 1, stderr: 'execution error: Cannot open "folder (-128)". (42)' }),
      "failed",
    ],
    ["relative output", commandResult({ stdout: "relative/path\n" }), "non-absolute"],
  ] as const)("reports a visible %s", async (_name, result, message) => {
    runCommandWithTimeoutMock.mockResolvedValue(result);

    await expect(pickHostDirectory({ path: "/tmp" })).rejects.toThrow(message);
  });

  it("releases the single-flight guard after a failure", async () => {
    const root = tempDirs.make("openclaw-native-picker-");
    const selectedPath = path.join(root, "selected");
    await fs.mkdir(selectedPath);
    runCommandWithTimeoutMock
      .mockResolvedValueOnce(commandResult({ code: 1, stderr: "failed (42)" }))
      .mockResolvedValueOnce(commandResult({ stdout: `${selectedPath}\n` }));

    await expect(pickHostDirectory({ path: root })).rejects.toThrow("failed");
    await expect(pickHostDirectory({ path: root })).resolves.toEqual({ path: selectedPath });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("does not open a second dialog while the first one is pending", async () => {
    const root = tempDirs.make("openclaw-native-picker-");
    const selectedPath = path.join(root, "selected");
    await fs.mkdir(selectedPath);
    let resolveCommand: ((result: ReturnType<typeof commandResult>) => void) | undefined;
    runCommandWithTimeoutMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );

    const first = pickHostDirectory({ path: root });
    await vi.waitFor(() => expect(runCommandWithTimeoutMock).toHaveBeenCalledOnce());
    await expect(pickHostDirectory({ path: root })).rejects.toThrow("already open");

    resolveCommand?.(commandResult({ stdout: `${selectedPath}\n` }));
    await expect(first).resolves.toEqual({ path: selectedPath });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledOnce();
  });
});
