import { QueueApi, QueueStatus, parseConversationThreadId } from "@chat-agent/queue";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BackgroundInput, BackgroundInputSink } from "../domain/types";

export interface FileQueueBackgroundInputSinkOptions {
  queueApi: QueueApi;
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
      const thread = parseConversationThreadId(input.threadId);
      if (!thread) {
        throw new Error(
          `simple-pomdp conversation queue requires channelId:userId threadId, got: ${input.threadId}`,
        );
      }
      await options.queueApi.enqueueConversationInput({
        botId: input.botId,
        userId: thread.userId,
        channelId: thread.channelId,
        text: input.text,
        source: "simple_pomdp",
        sourceInteractionId: input.sourceInteractionId,
        dueAt: new Date(),
      });
      lastEnqueuedAtByInteractionId.set(input.sourceInteractionId, now);
      await appendDebugLog(options.debugLogFilePath, "enqueued", input);
      process.stdout.write(
        `[simple-pomdp] queued threadId=${input.threadId} key=${input.sourceInteractionId}\n`,
      );
    },
  };
};

export const getFileQueueStatus = async (
  queueApi: QueueApi,
  now: Date = new Date(),
): Promise<QueueStatus> => {
  return queueApi.getStatus(now, 0);
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
