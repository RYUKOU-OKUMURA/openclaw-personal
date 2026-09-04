import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

// Host directory browsing for the new-session folder picker. Gateway-local
// write-scope browsing stays inside configured agent workspaces; node and
// arbitrary host browsing require admin.
export const FsListDirParamsSchema = closedObject({
  /** Absolute directory to list; for non-admin Gateway callers, omission means the first configured agent workspace. */
  path: Type.Optional(NonEmptyString),
  /** Connected node host to browse; omitted means the Gateway host. */
  nodeId: Type.Optional(NonEmptyString),
  /** Include regular files in Gateway-local listings; node hosts remain directory-only. */
  includeFiles: Type.Optional(Type.Boolean()),
});

export const FsDirEntrySchema = closedObject({
  name: NonEmptyString,
  path: NonEmptyString,
  /** Dot-prefixed entries; clients render them dimmed after visible ones. */
  hidden: Type.Optional(Type.Boolean()),
  /** Present only for opt-in listings that include both files and directories. */
  kind: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory")])),
});

export const FsListDirResultSchema = closedObject({
  /** Resolved absolute path that was listed. */
  path: NonEmptyString,
  /** Absent at the filesystem root. */
  parent: Type.Optional(NonEmptyString),
  /** Selected host's home directory, for the picker's "home" shortcut. */
  home: NonEmptyString,
  entries: Type.Array(FsDirEntrySchema),
  /** Native Finder folder selection is available to this local macOS listing caller. */
  nativeDirectoryPicker: Type.Optional(Type.Literal(true)),
});

export const FsPickDirectoryParamsSchema = closedObject({
  /** Absolute directory to show initially in the native Finder chooser. */
  path: Type.Optional(NonEmptyString),
});

export const FsPickDirectoryResultSchema = Type.Union([
  closedObject({ path: NonEmptyString }),
  closedObject({ cancelled: Type.Literal(true) }),
]);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type FsDirEntry = Static<typeof FsDirEntrySchema>;
export type FsListDirParams = Static<typeof FsListDirParamsSchema>;
export type FsListDirResult = Static<typeof FsListDirResultSchema>;
export type FsPickDirectoryParams = Static<typeof FsPickDirectoryParamsSchema>;
export type FsPickDirectoryResult = Static<typeof FsPickDirectoryResultSchema>;
