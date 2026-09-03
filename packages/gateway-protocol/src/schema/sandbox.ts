import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_NAME_LENGTH,
} from "./terminal-constants.js";

const SandboxEntryKindSchema = Type.Union([Type.Literal("file"), Type.Literal("directory")]);
const SandboxEntryNameSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TERMINAL_UPLOAD_NAME_LENGTH,
});

export const SandboxEntriesAddParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  mode: Type.Literal("copy"),
  source: Type.Union([
    closedObject({ kind: Type.Literal("path"), path: NonEmptyString }),
    closedObject({
      kind: Type.Literal("upload"),
      name: SandboxEntryNameSchema,
      contentBase64: Type.String({ maxLength: MAX_TERMINAL_UPLOAD_BASE64_LENGTH }),
    }),
    closedObject({
      kind: Type.Literal("create"),
      name: SandboxEntryNameSchema,
      entryKind: SandboxEntryKindSchema,
    }),
  ]),
});

export const SandboxEntriesAddResultSchema = closedObject({
  entry: closedObject({
    name: NonEmptyString,
    kind: SandboxEntryKindSchema,
    hostPath: NonEmptyString,
    containerPath: NonEmptyString,
    mode: Type.Literal("copy"),
  }),
  recreateRequired: Type.Boolean(),
});

/** Immediate inbox children, not every file reachable by the agent. No content is returned. */
const SandboxInboxSchema = closedObject({
  hostPath: NonEmptyString,
  containerPath: NonEmptyString,
  entries: Type.Array(
    closedObject({
      name: NonEmptyString,
      kind: Type.Union([SandboxEntryKindSchema, Type.Literal("symlink"), Type.Literal("other")]),
    }),
  ),
  counts: closedObject({
    files: Type.Integer({ minimum: 0 }),
    folders: Type.Integer({ minimum: 0 }),
    other: Type.Integer({ minimum: 0 }),
  }),
  /** Entries may be capped; counts cover all immediate children in this listing. */
  truncated: Type.Boolean(),
});

export const SandboxExplainParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

const SandboxToolPolicySourceSchema = closedObject({
  source: Type.Union([Type.Literal("agent"), Type.Literal("global"), Type.Literal("default")]),
  key: Type.String(),
});

export const SandboxExplainResultSchema = closedObject({
  docsUrl: Type.String(),
  agentId: NonEmptyString,
  sessionKey: NonEmptyString,
  mainSessionKey: NonEmptyString,
  sandbox: closedObject({
    mode: Type.Union([Type.Literal("off"), Type.Literal("non-main"), Type.Literal("all")]),
    scope: Type.Union([Type.Literal("session"), Type.Literal("agent"), Type.Literal("shared")]),
    backend: NonEmptyString,
    workspaceAccess: Type.Union([Type.Literal("none"), Type.Literal("ro"), Type.Literal("rw")]),
    workspaceRoot: Type.String(),
    effectiveHostWorkspaceRoot: Type.String(),
    runtimeWorkdir: Type.Optional(Type.String()),
    workspaceMounts: Type.Array(
      closedObject({
        hostRoot: Type.String(),
        containerRoot: Type.String(),
        writable: Type.Boolean(),
        source: Type.Union([
          Type.Literal("workspace"),
          Type.Literal("agent"),
          Type.Literal("bind"),
          Type.Literal("protectedSkill"),
        ]),
      }),
    ),
    workspaceSource: Type.Union([
      Type.Literal("agent"),
      Type.Literal("sandbox"),
      Type.Literal("direct"),
    ]),
    sessionIsSandboxed: Type.Boolean(),
    /** Configured Docker network; runtime may still use an older config when registry.stale is true. */
    network: Type.Optional(Type.String()),
    tools: closedObject({
      allow: Type.Array(Type.String()),
      deny: Type.Array(Type.String()),
      sources: closedObject({
        allow: SandboxToolPolicySourceSchema,
        deny: SandboxToolPolicySourceSchema,
      }),
    }),
  }),
  elevated: closedObject({
    enabled: Type.Boolean(),
    channel: Type.Optional(Type.String()),
    allowedByConfig: Type.Boolean(),
    alwaysAllowedByConfig: Type.Boolean(),
    allowFrom: closedObject({
      global: Type.Optional(Type.Array(Type.String())),
      agent: Type.Optional(Type.Array(Type.String())),
    }),
    failures: Type.Array(closedObject({ gate: Type.String(), key: Type.String() })),
  }),
  fixIt: Type.Array(Type.String()),
  inbox: Type.Optional(Type.Union([Type.Null(), SandboxInboxSchema])),
  /** Docker container for this report's workspace and scope, or null before provisioning. */
  registry: Type.Union([
    Type.Null(),
    closedObject({
      containerName: NonEmptyString,
      image: Type.String(),
      configHash: Type.Optional(Type.String()),
      createdAtMs: Type.Number(),
      lastUsedAtMs: Type.Number(),
      running: Type.Boolean(),
      stale: Type.Boolean(),
    }),
  ]),
});

export type SandboxExplainParams = Static<typeof SandboxExplainParamsSchema>;
export type SandboxExplainResult = Static<typeof SandboxExplainResultSchema>;
export type SandboxEntriesAddParams = Static<typeof SandboxEntriesAddParamsSchema>;
export type SandboxEntriesAddResult = Static<typeof SandboxEntriesAddResultSchema>;
