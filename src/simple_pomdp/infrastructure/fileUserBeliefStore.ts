import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserBelief, UserBeliefStore } from "../domain/types";

export interface FileUserBeliefStoreOptions {
  baseDir: string;
}

export const createFileUserBeliefStore = (
  options: FileUserBeliefStoreOptions,
): UserBeliefStore => ({
  async getUserBelief(userId) {
    try {
      const raw = await readFile(toFilePath(options.baseDir, userId), "utf8");
      return JSON.parse(raw) as UserBelief;
    } catch {
      return null;
    }
  },
  async saveUserBelief(belief) {
    await mkdir(options.baseDir, { recursive: true });
    await writeFile(
      toFilePath(options.baseDir, belief.userId),
      JSON.stringify(belief, null, 2),
      "utf8",
    );
  },
});

const toFilePath = (baseDir: string, userId: string): string =>
  join(baseDir, `${sanitize(userId)}.json`);

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
