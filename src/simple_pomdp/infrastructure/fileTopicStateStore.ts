import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TopicStateSnapshot, TopicStateStore } from "../domain/types";

export interface FileTopicStateStoreOptions {
  baseDir: string;
}

export const createFileTopicStateStore = (
  options: FileTopicStateStoreOptions,
): TopicStateStore => ({
  async getTopicState(userId) {
    try {
      const raw = await readFile(toFilePath(options.baseDir, userId), "utf8");
      return JSON.parse(raw) as TopicStateSnapshot;
    } catch {
      return null;
    }
  },
  async saveTopicState(state) {
    await mkdir(options.baseDir, { recursive: true });
    await writeFile(
      toFilePath(options.baseDir, state.userId),
      JSON.stringify(state, null, 2),
      "utf8",
    );
  },
});

const toFilePath = (baseDir: string, userId: string): string =>
  join(baseDir, `${sanitize(userId)}.json`);

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
