import type { SandboxEntriesAddParams } from "../../../../packages/gateway-protocol/src/index.js";

export type AccessMapDraft = {
  source: SandboxEntriesAddParams["source"];
  name: string;
  kind: "file" | "directory";
  mode: "copy" | "ro" | "rw";
  size?: number;
};
