import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TopicStateSnapshot, TopicStateStore } from "../domain/types";

export interface FileTopicStateStoreOptions {
  baseDir: string;
}

export const createFileTopicStateStore = (
  options: FileTopicStateStoreOptions,
): TopicStateStore => ({
  async getTopicState(input) {
    try {
      const raw = await readFile(
        toFilePath(options.baseDir, input.botId, input.userId),
        "utf8",
      );
      return JSON.parse(raw) as TopicStateSnapshot;
    } catch {
      return null;
    }
  },
  async saveTopicState(input) {
    if (input.state.userId !== input.userId) {
      throw new Error("TopicState userId does not match the requested scope");
    }
    const directory = join(options.baseDir, encodeKey(input.botId));
    await mkdir(directory, { recursive: true });
    await writeFile(
      toFilePath(options.baseDir, input.botId, input.userId),
      JSON.stringify(input.state, null, 2),
      "utf8",
    );
  },
});

const toFilePath = (baseDir: string, botId: string, userId: string): string =>
  join(baseDir, encodeKey(botId), `${encodeKey(userId)}.json`);

const encodeKey = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");
