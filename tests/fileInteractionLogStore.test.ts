import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFileInteractionLogStore } from "../src/simple_pomdp/infrastructure/fileInteractionLogStore";
import { InteractionLog } from "../src/simple_pomdp/domain/types";

test("file interaction log store requires and isolates bot scope", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "interaction-log-store-"));
  try {
    const store = createFileInteractionLogStore({ baseDir });
    await store.saveInteractionLog(interaction("ao-log", "ao"));
    await store.saveInteractionLog(interaction("aka-log", "aka"));
    await store.saveInteractionLog(interaction("slash-log", "bot/a"));
    await store.saveInteractionLog(interaction("question-log", "bot?a"));

    assert.deepEqual(
      await store.listRecentInteractionLogs({
        botId: "ao",
        userId: "user-1",
        limit: 10,
      }),
      [interaction("ao-log", "ao")],
    );
    assert.deepEqual(
      await store.listRecentInteractionLogs({
        botId: "aka",
        userId: "user-1",
        limit: 10,
      }),
      [interaction("aka-log", "aka")],
    );
    assert.deepEqual(
      await store.listRecentInteractionLogs({
        botId: "bot/a",
        userId: "user-1",
        limit: 10,
      }),
      [interaction("slash-log", "bot/a")],
    );
    assert.deepEqual(
      await store.listRecentInteractionLogs({
        botId: "bot?a",
        userId: "user-1",
        limit: 10,
      }),
      [interaction("question-log", "bot?a")],
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

const interaction = (id: string, botId: string): InteractionLog => ({
  id,
  botId,
  userId: "user-1",
  threadId: "thread-1",
  candidateKind: "explore",
  trigger: "scheduled",
  message: id,
  status: "pending",
  observation: "unknown",
  feedbackNote: "",
  observeWindowTurns: 2,
  createdAtIso: "2026-09-01T00:00:00.000Z",
});
