import { QueueApi, QueueStatus, parseConversationThreadId } from "@chat-agent/queue";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BackgroundInputSink, ScheduledAgentInput } from "../domain/types";

export interface FileQueueBackgroundInputSinkOptions {
  queueApi: QueueApi;
  debugLogFilePath?: string;
}

export const createFileQueueBackgroundInputSink = (
  options: FileQueueBackgroundInputSinkOptions,
): BackgroundInputSink => {
  const acceptedInteractionIds = new Set<string>();

  return {
    async enqueue(input) {
      if (acceptedInteractionIds.has(input.sourceInteractionId)) {
        await appendDebugLog(options.debugLogFilePath, "skipped_duplicate", input);
        process.stdout.write(
          `[simple-pomdp] skipped duplicate threadId=${input.threadId} key=${input.sourceInteractionId}\n`,
        );
        return;
      }
      acceptedInteractionIds.add(input.sourceInteractionId);
      const thread = parseConversationThreadId(input.threadId);
      if (!thread) {
        acceptedInteractionIds.delete(input.sourceInteractionId);
        throw new Error(
          `simple-pomdp conversation queue requires channelId:userId threadId, got: ${input.threadId}`,
        );
      }
      try {
        await options.queueApi.enqueueConversationInput({
          botId: input.botId,
          userId: thread.userId,
          channelId: thread.channelId,
          text: input.text,
          source: "simple_pomdp",
          sourceInteractionId: input.sourceInteractionId,
          dueAt: new Date(),
        });
      } catch (error: unknown) {
        acceptedInteractionIds.delete(input.sourceInteractionId);
        throw error;
      }
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
  input: ScheduledAgentInput,
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
