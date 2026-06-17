import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BackgroundInput, BackgroundInputSink } from "../domain/types";

interface QueueTask {
  id: string;
  type: "user" | "scheduled_recurring" | "scheduled_once";
  action: "mention" | "agent_input";
  text: string;
  channelId: string;
  authorId: string;
  mentionsBot: boolean;
  dueAt: string;
  createdAt: string;
  locked: boolean;
}

interface QueueStatus {
  counts: {
    locked: number;
    readyByType: {
      user: number;
      scheduled_recurring: number;
      scheduled_once: number;
    };
  };
}

export interface FileQueueBackgroundInputSinkOptions {
  filePath: string;
  channelId: string;
  authorId?: string;
  enqueueCooldownMs?: number;
  debugLogFilePath?: string;
}

export const createFileQueueBackgroundInputSink = (
  options: FileQueueBackgroundInputSinkOptions,
): BackgroundInputSink => {
  const lastEnqueuedAtByInteractionId = new Map<string, number>();
  const enqueueCooldownMs = options.enqueueCooldownMs ?? 60 * 60 * 1000;

  return {
    async enqueue(input) {
      const now = Date.now();
      const lastAt = lastEnqueuedAtByInteractionId.get(input.sourceInteractionId);
      if (lastAt !== undefined && now - lastAt < enqueueCooldownMs) {
        await appendDebugLog(options.debugLogFilePath, "skipped_duplicate", input);
        process.stdout.write(
          `[simple-pomdp] skipped duplicate threadId=${input.threadId} key=${input.sourceInteractionId}\n`,
        );
        return;
      }
      const items = await readQueueFile(options.filePath);
      items.push({
        id: `q_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        type: "scheduled_once",
        action: "agent_input",
        text: input.text,
        channelId: options.channelId,
        authorId: options.authorId ?? "simple-pomdp-system",
        mentionsBot: false,
        dueAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        locked: false,
      });
      await writeQueueFile(options.filePath, items);
      lastEnqueuedAtByInteractionId.set(input.sourceInteractionId, now);
      await appendDebugLog(options.debugLogFilePath, "enqueued", input);
      process.stdout.write(
        `[simple-pomdp] queued threadId=${input.threadId} key=${input.sourceInteractionId}\n`,
      );
    },
  };
};

export const getFileQueueStatus = async (
  filePath: string,
  now: Date = new Date(),
): Promise<QueueStatus> => {
  const items = await readQueueFile(filePath);
  const readyByType = {
    user: 0,
    scheduled_recurring: 0,
    scheduled_once: 0,
  } satisfies QueueStatus["counts"]["readyByType"];
  let locked = 0;
  for (const item of items) {
    if (item.locked) {
      locked += 1;
    }
    if (!item.locked && new Date(item.dueAt).getTime() <= now.getTime()) {
      readyByType[item.type] += 1;
    }
  }
  return { counts: { locked, readyByType } };
};

const readQueueFile = async (filePath: string): Promise<QueueTask[]> => {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as QueueTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeQueueFile = async (
  filePath: string,
  items: QueueTask[],
): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(items, null, 2), "utf8");
};

const appendDebugLog = async (
  filePath: string | undefined,
  event: "enqueued" | "skipped_duplicate",
  input: BackgroundInput,
): Promise<void> => {
  if (!filePath) {
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(
    filePath,
    `${JSON.stringify({ atIso: new Date().toISOString(), event, input })}\n`,
    "utf8",
  );
};
