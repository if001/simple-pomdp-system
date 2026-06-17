import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InteractionLog, InteractionLogStore } from "../domain/types";

interface InteractionLogFile {
  logs: InteractionLog[];
}

export interface FileInteractionLogStoreOptions {
  baseDir: string;
  maxLogsPerUser?: number;
}

export const createFileInteractionLogStore = (
  options: FileInteractionLogStoreOptions,
): InteractionLogStore => {
  const maxLogsPerUser = Math.max(1, options.maxLogsPerUser ?? 200);

  return {
    async listRecentInteractionLogs(input) {
      const file = await readLogFile(options.baseDir, input.userId);
      return file.logs.slice(-Math.max(1, input.limit));
    },
    async saveInteractionLog(log) {
      const file = await readLogFile(options.baseDir, log.userId);
      const next = file.logs.filter((item) => item.id !== log.id);
      next.push(log);
      await mkdir(options.baseDir, { recursive: true });
      await writeFile(
        toFilePath(options.baseDir, log.userId),
        JSON.stringify({ logs: next.slice(-maxLogsPerUser) }, null, 2),
        "utf8",
      );
    },
  };
};

const readLogFile = async (
  baseDir: string,
  userId: string,
): Promise<InteractionLogFile> => {
  try {
    const raw = await readFile(toFilePath(baseDir, userId), "utf8");
    const parsed = JSON.parse(raw) as InteractionLogFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.logs)) {
      return { logs: [] };
    }
    return parsed;
  } catch {
    return { logs: [] };
  }
};

const toFilePath = (baseDir: string, userId: string): string =>
  join(baseDir, `${sanitize(userId)}.json`);

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
