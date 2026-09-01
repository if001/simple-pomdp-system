import assert from "node:assert/strict";
import { QueueApi } from "@chat-agent/queue";
import { test } from "vitest";
import { createFileQueueBackgroundInputSink } from "../src/simple_pomdp/infrastructure/fileQueueBackgroundInputSink";

test("forwards one scheduled payload and deduplicates concurrent interaction IDs", async () => {
  const enqueued: unknown[] = [];
  const queueApi = {
    enqueueConversationInput: async (input: unknown) => {
      enqueued.push(input);
      return {};
    },
  } as QueueApi;
  const sink = createFileQueueBackgroundInputSink({ queueApi });

  const input = {
    trigger: "scheduled" as const,
    botId: "ao",
    threadId: "channel-1:user-1",
    text: "proactive prompt",
    sourceInteractionId: "interaction-1",
  };

  await Promise.all([sink.enqueue(input), sink.enqueue(input)]);

  assert.deepEqual(enqueued, [
    {
      botId: "ao",
      userId: "user-1",
      channelId: "channel-1",
      text: "proactive prompt",
      source: "simple_pomdp",
      sourceInteractionId: "interaction-1",
      dueAt: enqueued.length
        ? (enqueued[0] as { dueAt: Date }).dueAt
        : undefined,
    },
  ]);
});
