import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionsCreateResultSchema,
  WorktreesBranchesResultSchema,
  WorktreesRemoveResultSchema,
  validateSessionsCreateParams,
  validateFsListDirParams,
  validateFsListDirResult,
  validateFsPickPathParams,
  validateFsPickPathResult,
  validateWorktreesBranchesParams,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesRemoveParams,
} from "../index.js";

describe("managed worktree protocol schemas", () => {
  it("accepts the additive worktree method payloads", () => {
    expect(
      validateWorktreesCreateParams({ repoRoot: "/repo", name: "task-one", baseRef: "main" }),
    ).toBe(true);
    expect(validateWorktreesRemoveParams({ id: "id", force: true })).toBe(true);
    expect(validateWorktreesGcParams({})).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", worktree: true })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", catalogId: "claude" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", thinkingLevel: "high" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: true })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: "auto" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: "fast" })).toBe(false);
    expect(validateSessionsCreateParams({ agentId: "main", incognito: true })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", incognito: "true" })).toBe(false);
    expect(validateSessionsCreateParams({ agentId: "main", thinkingLevel: "" })).toBe(false);
    expect(
      Value.Check(SessionsCreateResultSchema, {
        ok: true,
        key: "agent:main:dashboard:test",
        runStarted: false,
        runError: { code: "INVALID_REQUEST", message: "send blocked by session policy" },
        worktree: { id: "id", path: "/worktree", branch: "openclaw/wt-test" },
      }),
    ).toBe(true);
  });

  it("accepts worktree target params on sessions.create", () => {
    expect(
      validateSessionsCreateParams({
        agentId: "main",
        worktree: true,
        worktreeBaseRef: "origin/main",
        worktreeName: "my-task",
        execNode: "macbook",
      }),
    ).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", worktreeName: "Bad Name" })).toBe(false);
  });

  it("accepts branch listing payloads and snapshot errors", () => {
    expect(validateWorktreesBranchesParams({ repoRoot: "/repo" })).toBe(true);
    expect(
      validateWorktreesBranchesParams({ repoRoot: "/repo", includeRepositoryStatus: true }),
    ).toBe(true);
    expect(
      validateWorktreesBranchesParams({ repoRoot: "/repo", includeRepositoryStatus: false }),
    ).toBe(true);
    expect(validateWorktreesBranchesParams({})).toBe(false);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [
          { name: "main", kind: "local" },
          { name: "feature", kind: "remote" },
        ],
        defaultBranch: "main",
        headBranch: "feature",
        repositoryStatus: "git",
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [],
        repositoryStatus: "not_git",
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [],
        repositoryStatus: "unavailable",
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [],
        repositoryStatus: "unknown",
      }),
    ).toBe(false);
    expect(
      Value.Check(WorktreesRemoveResultSchema, {
        removed: true,
        snapshotError: "snapshot failed: nested gitlink",
      }),
    ).toBe(true);
  });

  it("accepts Gateway and node directory-listing targets", () => {
    expect(validateFsListDirParams({ path: "/repo" })).toBe(true);
    expect(validateFsListDirParams({ nodeId: "macbook", path: "/Users/peter" })).toBe(true);
    expect(validateFsListDirParams({ nodeId: "" })).toBe(false);
    expect(
      validateFsListDirResult({
        path: "/repo",
        home: "/home/peter",
        entries: [],
        nativePathPicker: true,
      }),
    ).toBe(true);
    expect(
      validateFsListDirResult({
        path: "/repo",
        home: "/home/peter",
        entries: [],
        nativePathPicker: false,
      }),
    ).toBe(false);
  });

  it("accepts native path-picker requests and both outcomes", () => {
    expect(validateFsPickPathParams({})).toBe(true);
    expect(validateFsPickPathParams({ path: "/repo" })).toBe(true);
    expect(validateFsPickPathParams({ path: "" })).toBe(false);
    expect(validateFsPickPathParams({ nodeId: "node" })).toBe(false);
    expect(validateFsPickPathResult({ path: "/repo/file.txt", kind: "file" })).toBe(true);
    expect(validateFsPickPathResult({ path: "/repo", kind: "directory" })).toBe(true);
    expect(validateFsPickPathResult({ cancelled: true })).toBe(true);
    expect(validateFsPickPathResult({ cancelled: false })).toBe(false);
    expect(validateFsPickPathResult({ path: "/repo/file.txt" })).toBe(false);
    expect(
      validateFsPickPathResult({ path: "/repo/file.txt", kind: "file", cancelled: true }),
    ).toBe(false);
  });

  it("rejects invalid names and unknown fields", () => {
    expect(validateWorktreesCreateParams({ repoRoot: "/repo", name: "Bad Name" })).toBe(false);
    expect(validateWorktreesGcParams({ unexpected: true })).toBe(false);
  });
});
