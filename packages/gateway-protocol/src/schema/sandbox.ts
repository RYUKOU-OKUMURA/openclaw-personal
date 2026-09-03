import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

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
