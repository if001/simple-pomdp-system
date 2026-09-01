import assert from "node:assert/strict";
import { test } from "vitest";
import { createPostgresUserMemoryReader } from "../src/simple_pomdp/infrastructure/postgresUserMemoryReader";

test("postgres user memory reader shares notes across bots while isolating users", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const reader = createPostgresUserMemoryReader({
    query: async (text, values) => {
      calls.push({ text, values });
      return {
        rows: [
          {
            note: "TypeScriptが好き",
            created_at: new Date("2026-09-01T00:00:00.000Z"),
          },
          { note: 42, created_at: null },
        ],
      };
    },
  });

  const result = await reader.listRecentUserMemory({
    botId: "ao",
    userId: "user-1",
    limit: 5,
  });

  assert.deepEqual(calls[0]?.values, ["user-1", 5]);
  assert.match(calls[0]?.text ?? "", /where user_id = \$1/);
  assert.doesNotMatch(calls[0]?.text ?? "", /bot_id/);
  assert.match(calls[0]?.text ?? "", /limit \$2/);
  assert.deepEqual(result, [
    {
      text: "TypeScriptが好き",
      createdAtIso: "2026-09-01T00:00:00.000Z",
    },
  ]);
});
