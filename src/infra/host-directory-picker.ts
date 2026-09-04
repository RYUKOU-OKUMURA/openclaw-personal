import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout, type CommandOptions, type SpawnResult } from "../process/exec.js";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const NATIVE_PICKER_TIMEOUT_MS = 120_000;
const MAX_PICKER_OUTPUT_BYTES = 16 * 1024;

// Keep these scripts constant. The initial path is supplied through osascript's
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

const NATIVE_FILE_PICKER_SCRIPT = [
  "on run argv",
  "  set startPath to item 1 of argv",
  "  set startLocation to POSIX file startPath",
  "  activate",
  '  set selectedFile to choose file with prompt "OpenClaw" default location startLocation',
  "  return POSIX path of selectedFile",
  "end run",
].join("\n");

export type HostPickerResult = { path: string } | { cancelled: true };
export type HostDirectoryPickerResult = HostPickerResult;
export type HostFilePickerResult = HostPickerResult;

type HostPickerKind = "directory" | "file";

let nativePickerInFlight = false;

function isNativePickerCancelled(result: Pick<SpawnResult, "code" | "stderr">) {
  return result.code !== 0 && /\(-128\)\s*$/u.test(result.stderr);
}

function commandFailureMessage(
  kind: HostPickerKind,
  result: Pick<SpawnResult, "code" | "signal" | "stderr" | "stdout">,
) {
  const detail = (result.stderr || result.stdout).trim().replace(/\s+/gu, " ").slice(0, 512);
  if (detail) {
    return `native ${kind} picker failed: ${detail}`;
  }
  if (result.signal) {
    return `native ${kind} picker terminated by ${result.signal}`;
  }
  return `native ${kind} picker failed${result.code === null ? "" : ` (exit code ${String(result.code)})`}`;
}

/**
 * Opens a macOS Finder chooser and returns a verified host path.
 * Authorization and platform checks belong to the Gateway method boundary.
 */
async function pickHostPath(options: {
  kind: HostPickerKind;
  path?: string;
  signal?: AbortSignal;
}): Promise<HostPickerResult> {
  const requestedPath = options.path ?? os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new Error(`native ${options.kind} picker start path must be absolute`);
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
    // Keep the script and the selected starting path in separate argv entries.
    const script =
      options.kind === "directory" ? NATIVE_DIRECTORY_PICKER_SCRIPT : NATIVE_FILE_PICKER_SCRIPT;
    const result = await runCommandWithTimeout(
      [OSASCRIPT_PATH, "-e", script, requestedPath],
      commandOptions,
    );

    if (result.termination === "timeout" || result.termination === "no-output-timeout") {
      throw new Error(`native ${options.kind} picker timed out`);
    }
    if (isNativePickerCancelled(result)) {
      return { cancelled: true };
    }
    if (result.code !== 0 || result.signal !== null || result.termination !== "exit") {
      throw new Error(commandFailureMessage(options.kind, result));
    }

    const selectedPath = result.stdout.replace(/(?:\r\n|\n)$/u, "");
    if (!path.isAbsolute(selectedPath)) {
      throw new Error(`native ${options.kind} picker returned a non-absolute path`);
    }
    const actualPath = await fs.realpath(selectedPath);
    const selectedStats = await fs.stat(actualPath);
    if (options.kind === "directory" && !selectedStats.isDirectory()) {
      throw new Error("native directory picker returned a non-directory path");
    }
    if (options.kind === "file" && !selectedStats.isFile()) {
      throw new Error("native file picker returned a non-file path");
    }
    return { path: actualPath };
  } finally {
    nativePickerInFlight = false;
  }
}

export async function pickHostDirectory(options: {
  path?: string;
  signal?: AbortSignal;
}): Promise<HostDirectoryPickerResult> {
  return await pickHostPath({ ...options, kind: "directory" });
}

export async function pickHostFile(options: {
  path?: string;
  signal?: AbortSignal;
}): Promise<HostFilePickerResult> {
  return await pickHostPath({ ...options, kind: "file" });
}
