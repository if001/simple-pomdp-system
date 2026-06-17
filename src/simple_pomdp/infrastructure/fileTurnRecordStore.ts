import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TurnRecord, TurnRecordStore } from "../domain/types";

interface BotTurnRecordFile {
  threads: Record<string, TurnRecord[]>;
}

export interface FileTurnRecordStoreOptions {
  baseDir: string;
  maxTurnsPerThread?: number;
}

export const createFileTurnRecordStore = (
  options: FileTurnRecordStoreOptions,
): TurnRecordStore => {
  const maxTurnsPerThread = Math.max(1, options.maxTurnsPerThread ?? 200);

  const loadBotFile = async (botId: string): Promise<BotTurnRecordFile> => {
    const path = join(options.baseDir, `${sanitize(botId)}.json`);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as BotTurnRecordFile;
      if (!parsed || typeof parsed !== "object" || !parsed.threads) {
        return { threads: {} };
      }
      return parsed;
    } catch {
      return { threads: {} };
    }
  };

  const saveBotFile = async (
    botId: string,
    data: BotTurnRecordFile,
  ): Promise<void> => {
    await mkdir(options.baseDir, { recursive: true });
    await writeFile(
      join(options.baseDir, `${sanitize(botId)}.json`),
      JSON.stringify(data, null, 2),
      "utf8",
    );
  };

  return {
    async appendTurnRecord(turn) {
      const data = await loadBotFile(turn.botId);
      const items = data.threads[turn.threadId] ?? [];
      items.push(
        turn.id
          ? turn
          : {
              ...turn,
              id: `turn_${sanitize(turn.threadId)}_${turn.createdAtIso}_${items.length}`,
            },
      );
      data.threads[turn.threadId] = items.slice(-maxTurnsPerThread);
      await saveBotFile(turn.botId, data);
    },
    async listRecentTurnRecords(input) {
      const data = await loadBotFile(input.botId);
      const items = data.threads[input.threadId] ?? [];
      return items.slice(-Math.max(1, input.limit));
    },
  };
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
