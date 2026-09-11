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
