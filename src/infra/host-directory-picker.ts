import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout, type CommandOptions, type SpawnResult } from "../process/exec.js";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const NATIVE_PICKER_TIMEOUT_MS = 120_000;
const MAX_PICKER_OUTPUT_BYTES = 16 * 1024;

// AppKit permits files and folders in one panel. Calling it directly avoids
// Standard Additions' Apple-event activation path. User paths remain argv data.
const NATIVE_PATH_PICKER_SCRIPT = [
  'ObjC.import("AppKit");',
  "function run(argv) {",
  "  const app = $.NSApplication.sharedApplication;",
  "  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);",
  "  const panel = $.NSOpenPanel.openPanel;",
  "  panel.canChooseFiles = true;",
  "  panel.canChooseDirectories = true;",
  "  panel.allowsMultipleSelection = false;",
  "  panel.resolvesAliases = true;",
  '  panel.title = "OpenClaw";',
  "  panel.directoryURL = $.NSURL.fileURLWithPath(argv[0]);",
  "  app.activateIgnoringOtherApps(true);",
  "  const response = panel.runModal;",
  "  return JSON.stringify(Number(response) === Number($.NSModalResponseOK) ? ObjC.unwrap(panel.URL.path) : null);",
  "}",
].join("\n");

export type HostPathPickerResult =
  | { path: string; kind: "file" | "directory" }
  | { cancelled: true };

let nativePickerInFlight = false;

function commandFailureMessage(result: Pick<SpawnResult, "code" | "signal" | "stderr" | "stdout">) {
  const detail = (result.stderr || result.stdout).trim().replace(/\s+/gu, " ").slice(0, 512);
  if (detail) {
    return `native path picker failed: ${detail}`;
  }
  if (result.signal) {
    return `native path picker terminated by ${result.signal}`;
  }
  return `native path picker failed${result.code === null ? "" : ` (exit code ${String(result.code)})`}`;
}

/**
 * Opens a macOS Finder chooser and returns a verified host path.
 * Authorization and platform checks belong to the Gateway method boundary.
 */
export async function pickHostPath(options: {
  path?: string;
  signal?: AbortSignal;
}): Promise<HostPathPickerResult> {
  const requestedPath = options.path ?? os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new Error(`native path picker start path must be absolute`);
  }
  if (nativePickerInFlight) {
    throw new Error("native file or folder picker is already open");
  }

  nativePickerInFlight = true;
  try {
    const commandOptions: CommandOptions = {
      timeoutMs: NATIVE_PICKER_TIMEOUT_MS,
      killProcessTree: true,
      maxOutputBytes: MAX_PICKER_OUTPUT_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const result = await runCommandWithTimeout(
      [OSASCRIPT_PATH, "-l", "JavaScript", "-e", NATIVE_PATH_PICKER_SCRIPT, requestedPath],
      commandOptions,
    );

    if (result.termination === "timeout" || result.termination === "no-output-timeout") {
      throw new Error(`native path picker timed out`);
    }
    if (result.code !== 0 || result.signal !== null || result.termination !== "exit") {
      throw new Error(commandFailureMessage(result));
    }

    // JSON framing preserves filenames containing whitespace and newlines; null
    // is a successful user cancellation, never inferred from an error message.
    const selectedPath: unknown = JSON.parse(result.stdout);
    if (selectedPath === null) {
      return { cancelled: true };
    }
    if (typeof selectedPath !== "string" || !path.isAbsolute(selectedPath)) {
      throw new Error("native path picker returned a non-absolute path");
    }
    const actualPath = await fs.realpath(selectedPath);
    const selectedStats = await fs.stat(actualPath);
    if (selectedStats.isDirectory()) {
      return { path: actualPath, kind: "directory" };
    }
    if (selectedStats.isFile()) {
      return { path: actualPath, kind: "file" };
    }
    throw new Error("native path picker returned neither a file nor a directory");
  } finally {
    nativePickerInFlight = false;
  }
}
