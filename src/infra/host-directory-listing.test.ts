import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listHostDirectories } from "./host-directory-listing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("listHostDirectories", () => {
  it.runIf(process.platform !== "win32")(
    "keeps the default directory-only shape and opts into files with entry kinds",
    async () => {
      const root = tempDirs.make("openclaw-host-listdir-");
      const directory = path.join(root, "directory");
      const file = path.join(root, "file.txt");
      const hiddenDirectory = path.join(root, ".hidden-directory");
      const hiddenFile = path.join(root, ".hidden-file.txt");
      await fs.mkdir(directory);
      await fs.mkdir(hiddenDirectory);
      await fs.writeFile(file, "file");
      await fs.writeFile(hiddenFile, "hidden file");
      fsSync.symlinkSync(directory, path.join(root, "linked-directory"));
      fsSync.symlinkSync(file, path.join(root, "linked-file.txt"));

      const defaultListing = await listHostDirectories(root);
      expect(defaultListing.entries).toEqual([
        { name: "directory", path: directory },
        { name: "linked-directory", path: path.join(root, "linked-directory") },
        { name: ".hidden-directory", path: hiddenDirectory, hidden: true },
      ]);

      const listing = await listHostDirectories(root, { includeFiles: true });
      expect(listing.entries).toEqual([
        { name: "directory", path: directory, kind: "directory" },
        { name: "file.txt", path: file, kind: "file" },
        { name: "linked-directory", path: path.join(root, "linked-directory"), kind: "directory" },
        { name: "linked-file.txt", path: path.join(root, "linked-file.txt"), kind: "file" },
        { name: ".hidden-directory", path: hiddenDirectory, hidden: true, kind: "directory" },
        { name: ".hidden-file.txt", path: hiddenFile, hidden: true, kind: "file" },
      ]);
    },
  );
});
