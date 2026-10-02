/**
 * Builds bounded, container-only file-location guidance for sandbox prompts.
 *
 * Bind metadata is projected from the same effective mount table used by the
 * filesystem bridge. The renderer deliberately excludes host paths because
 * those paths are not valid targets for sandbox execution.
 */
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasPromptUnsafeControlCharacter } from "../sanitize-for-prompt.js";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import type { SandboxContext } from "./types.js";

const SANDBOX_FILE_LOCATIONS_PROMPT_MAX_CHARS = 4096;

const SHARED_CONTAINER_ROOT = "/mnt/shared";
const MAX_SHARED_BIND_ENTRIES = 16;
const MAX_ENCODED_PATH_CHARS = 128;
const OUTPUT_DIRECTORY_NAME = "outputs";

type SandboxFileLocation = {
  containerPath: string;
  writable: boolean;
};

type SandboxFileLocationsPromptProjection = {
  sharedMounts: readonly SandboxFileLocation[];
  omittedSharedMountCount: number;
  outputDirectory?: {
    containerPath: string;
    writable: boolean;
  };
};

/**
 * Projects only the sandbox paths that are useful to the model.
 *
 * Docker and Podman are the backends whose effective bind table is represented
 * by `buildSandboxFsMounts`. Other backends are outside the local Files browser
 * contract, so they receive no new location guidance.
 */
function projectSandboxFileLocationsPrompt(
  sandbox?: SandboxContext,
): SandboxFileLocationsPromptProjection | undefined {
  if (!sandbox?.enabled) {
    return undefined;
  }

  const isContainerBackend = isDockerOrPodmanBackend(sandbox.backendId);
  if (!isContainerBackend) {
    return undefined;
  }
  const mounts = buildSandboxFsMounts(sandbox);
  const sharedMounts = mounts
    .filter((mount) => mount.source === "bind" && isUnderSharedContainerRoot(mount.containerRoot))
    .map((mount) => ({
      containerPath: mount.containerRoot,
      writable: mount.writable,
    }))
    .toSorted(
      (left, right) =>
        left.containerPath.localeCompare(right.containerPath) ||
        Number(left.writable) - Number(right.writable),
    );

  const visibleSharedMounts = sharedMounts.slice(0, MAX_SHARED_BIND_ENTRIES);
  const containerWorkdir = normalizeContainerPath(sandbox.containerWorkdir);
  const outputDirectory = containerWorkdir
    ? {
        containerPath: path.posix.join(containerWorkdir, OUTPUT_DIRECTORY_NAME),
        writable: resolveOutputDirectoryWritable({
          sandbox,
          containerWorkdir,
          outputPath: path.posix.join(containerWorkdir, OUTPUT_DIRECTORY_NAME),
          mounts,
        }),
      }
    : undefined;

  return {
    sharedMounts: visibleSharedMounts,
    omittedSharedMountCount: sharedMounts.length - visibleSharedMounts.length,
    ...(outputDirectory ? { outputDirectory } : {}),
  };
}

/** Renders the projected paths as bounded, prompt-safe environment facts. */
function renderSandboxFileLocationsPrompt(
  projection: SandboxFileLocationsPromptProjection,
): string {
  const encodedSharedRoot = JSON.stringify(`${SHARED_CONTAINER_ROOT}/`);
  const lines: string[] = [
    "Sandbox file locations are container paths; do not use host paths with sandbox tools.",
  ];
  let omittedPathCount = 0;

  lines.push(`Configured shared binds under ${encodedSharedRoot}:`);
  if (projection.sharedMounts.length === 0) {
    lines.push(`- No configured shared bind is exposed under ${encodedSharedRoot}.`);
  } else {
    for (const mount of projection.sharedMounts) {
      const encodedPath = stringifyBoundedPath(mount.containerPath);
      if (!encodedPath) {
        omittedPathCount += 1;
        continue;
      }
      lines.push(`- ${encodedPath} — ${mount.writable ? "read-write" : "read-only"}`);
    }
  }
  const omittedSharedMountCount = projection.omittedSharedMountCount + omittedPathCount;
  if (omittedSharedMountCount > 0) {
    lines.push(
      `- ${omittedSharedMountCount} additional shared bind(s) omitted from this bounded list. Use filesystem tools to inspect ${encodedSharedRoot}.`,
    );
  }

  if (projection.outputDirectory) {
    const encodedOutputPath = stringifyBoundedPath(projection.outputDirectory.containerPath);
    if (encodedOutputPath) {
      lines.push(
        projection.outputDirectory.writable
          ? `Deliverables: save under ${encodedOutputPath}. If it does not exist, create it when saving; workspace access is read-write.`
          : `Deliverables path ${encodedOutputPath} is not writable in this sandbox; do not write there.`,
      );
    } else {
      omittedPathCount += 1;
      lines.push(
        projection.outputDirectory.writable
          ? `Deliverables: save under the sandbox working directory's "outputs" directory when writable. If it does not exist, create it when saving; workspace access is read-write.`
          : `Deliverables are not writable in this sandbox; do not write them.`,
      );
    }
  }

  if (omittedPathCount > 0) {
    lines.push(
      `Some paths were omitted for prompt size. Use filesystem tools to inspect ${encodedSharedRoot} and the sandbox working directory.`,
    );
  }

  const rendered = lines.join("\n");
  if (rendered.length <= SANDBOX_FILE_LOCATIONS_PROMPT_MAX_CHARS) {
    return rendered;
  }

  // The entry and per-path caps above should make this unreachable in normal
  // operation. Keep a safe fallback if fixed wording changes later.
  const fallbackLines = lines.filter((line) => !line.startsWith("- "));
  fallbackLines.push(
    `Shared bind list omitted for prompt size. Use filesystem tools to inspect ${encodedSharedRoot}.`,
  );
  return truncateUtf16Safe(fallbackLines.join("\n"), SANDBOX_FILE_LOCATIONS_PROMPT_MAX_CHARS);
}

/** Projects and renders the prompt metadata in one call for runtime callers. */
export function buildSandboxFileLocationsPrompt(sandbox?: SandboxContext): string | undefined {
  const projection = projectSandboxFileLocationsPrompt(sandbox);
  return projection ? renderSandboxFileLocationsPrompt(projection) : undefined;
}

function isDockerOrPodmanBackend(backendId: string): boolean {
  const normalized = backendId.trim().toLowerCase();
  return normalized === "docker" || normalized === "podman";
}

function normalizeContainerPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || !path.posix.isAbsolute(trimmed)) {
    return undefined;
  }
  return path.posix.normalize(trimmed);
}

function isUnderSharedContainerRoot(containerPath: string): boolean {
  const normalized = normalizeContainerPath(containerPath);
  return (
    normalized === SHARED_CONTAINER_ROOT ||
    normalized?.startsWith(`${SHARED_CONTAINER_ROOT}/`) === true
  );
}

function resolveOutputDirectoryWritable(params: {
  sandbox: SandboxContext;
  containerWorkdir: string;
  outputPath: string;
  mounts: ReturnType<typeof buildSandboxFsMounts>;
}): boolean {
  // The approved outputs convention is intentionally unavailable to a
  // read-only/none workspace, even if another nested bind happens to be RW.
  if (params.sandbox.workspaceAccess !== "rw") {
    return false;
  }
  try {
    return resolveSandboxFsPathWithMounts({
      filePath: params.outputPath,
      cwd: params.sandbox.workspaceDir,
      defaultWorkspaceRoot: params.sandbox.workspaceDir,
      defaultContainerRoot: params.containerWorkdir,
      mounts: params.mounts,
    }).writable;
  } catch {
    return false;
  }
}

function stringifyBoundedPath(value: string): string | undefined {
  // JSON leaves some Unicode controls literal. Escape those losslessly instead
  // of stripping characters and advertising a path that does not exist.
  const full = Array.from(JSON.stringify(value), (char) =>
    hasPromptUnsafeControlCharacter(char)
      ? char
          .split("")
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join("")
      : char,
  ).join("");
  if (full.length <= MAX_ENCODED_PATH_CHARS) {
    return full;
  }
  return undefined;
}
