import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Server-selected locations; ids are not client-supplied host paths. */
export const SessionFileRootSchema = closedObject({
  id: NonEmptyString,
  kind: Type.Union([Type.Literal("workspace"), Type.Literal("outputs"), Type.Literal("shared")]),
  name: NonEmptyString,
  hostPath: NonEmptyString,
  runtimePath: Type.Optional(NonEmptyString),
  writable: Type.Boolean(),
  available: Type.Boolean(),
});

export const SessionsFilesListParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  rootId: Type.Optional(NonEmptyString),
  path: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
});

export const SessionsFilesGetParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  path: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  rootId: Type.Optional(NonEmptyString),
});
