import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout, type CommandOptions, type SpawnResult } from "../process/exec.js";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const NATIVE_DIRECTORY_PICKER_TIMEOUT_MS = 120_000;
const MAX_PICKER_OUTPUT_BYTES = 16 * 1024;

// Keep this script constant. The initial path is supplied through osascript's
// argv list so paths containing spaces, quotes, or non-ASCII characters never
// become AppleScript source.
const NATIVE_DIRECTORY_PICKER_SCRIPT = [
  "on run argv",
  "  set startPath to item 1 of argv",
  "  set startLocation to POSIX file startPath",
  "  activate",
  '  set selectedFolder to choose folder with prompt "OpenClaw" default location startLocation',
  "  return POSIX path of selectedFolder",
  "end run",
].join("\n");

export type HostDirectoryPickerResult = { path: string } | { cancelled: true };

let nativePickerInFlight = false;

function isNativePickerCancelled(result: Pick<SpawnResult, "code" | "stderr">) {
  return result.code !== 0 && /\(-128\)\s*$/u.test(result.stderr);
}

function commandFailureMessage(result: Pick<SpawnResult, "code" | "signal" | "stderr" | "stdout">) {
  const detail = (result.stderr || result.stdout).trim().replace(/\s+/gu, " ").slice(0, 512);
  if (detail) {
    return `native directory picker failed: ${detail}`;
  }
  if (result.signal) {
    return `native directory picker terminated by ${result.signal}`;
  }
  return `native directory picker failed${result.code === null ? "" : ` (exit code ${String(result.code)})`}`;
}

/**
 * Opens the macOS Finder folder chooser and returns a verified host directory.
 * Authorization and platform checks belong to the Gateway method boundary.
 */
export async function pickHostDirectory(options: {
  path?: string;
  signal?: AbortSignal;
}): Promise<HostDirectoryPickerResult> {
  const requestedPath = options.path ?? os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new Error("native directory picker start path must be absolute");
  }
  if (nativePickerInFlight) {
    throw new Error("native directory picker is already open");
  }

  nativePickerInFlight = true;
  try {
    const commandOptions: CommandOptions = {
      timeoutMs: NATIVE_DIRECTORY_PICKER_TIMEOUT_MS,
      killProcessTree: true,
      maxOutputBytes: MAX_PICKER_OUTPUT_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    // Keep the script and the selected starting path in separate argv entries.
    const result = await runCommandWithTimeout(
      [OSASCRIPT_PATH, "-e", NATIVE_DIRECTORY_PICKER_SCRIPT, requestedPath],
      commandOptions,
    );

    if (result.termination === "timeout" || result.termination === "no-output-timeout") {
      throw new Error("native directory picker timed out");
    }
    if (isNativePickerCancelled(result)) {
      return { cancelled: true };
    }
    if (result.code !== 0 || result.signal !== null || result.termination !== "exit") {
      throw new Error(commandFailureMessage(result));
    }

    const selectedPath = result.stdout.replace(/(?:\r\n|\n)$/u, "");
    if (!path.isAbsolute(selectedPath)) {
      throw new Error("native directory picker returned a non-absolute path");
    }
    const actualPath = await fs.realpath(selectedPath);
    const selectedStats = await fs.stat(actualPath);
    if (!selectedStats.isDirectory()) {
      throw new Error("native directory picker returned a non-directory path");
    }
    return { path: actualPath };
  } finally {
    nativePickerInFlight = false;
  }
}
