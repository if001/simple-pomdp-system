import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFileTopicStateStore } from "../src/simple_pomdp/infrastructure/fileTopicStateStore";
import { TopicStateSnapshot } from "../src/simple_pomdp/domain/types";

test("file topic state store round-trips the new schema", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "topic-state-store-"));
  try {
    const store = createFileTopicStateStore({ baseDir });
    const state: TopicStateSnapshot = {
      userId: "user-1",
      topics: [
        {
          topic: "TypeScript",
          assessment: "interested",
          evidence: "型の話題に前向きな反応があった",
          lastTriedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      updatedAtIso: "2026-09-01T00:01:00.000Z",
    };

    await store.saveTopicState({ botId: "ao", userId: "user-1", state });
    const akaState: TopicStateSnapshot = {
      userId: "user-1",
      topics: [
        {
          topic: "料理",
          assessment: "possible",
          evidence: "別botでのみ観測した",
        },
      ],
      updatedAtIso: "2026-09-01T00:02:00.000Z",
    };
    await store.saveTopicState({
      botId: "aka",
      userId: "user-1",
      state: akaState,
    });

    assert.deepEqual(
      await store.getTopicState({ botId: "ao", userId: "user-1" }),
      state,
    );
    assert.deepEqual(
      await store.getTopicState({ botId: "aka", userId: "user-1" }),
      akaState,
    );
    assert.deepEqual(Object.keys(state.topics[0] ?? {}).sort(), [
      "assessment",
      "evidence",
      "lastTriedAt",
      "topic",
    ]);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
