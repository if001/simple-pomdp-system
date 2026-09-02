import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveBackgroundUserId } from "../src/cli/runBackground";

test("derives the real user ID from a valid thread collection", () => {
  assert.equal(
    deriveBackgroundUserId(["channel-1:user-1", "channel-2:user-1"]),
    "user-1",
  );
});

test("rejects thread collections containing multiple users", () => {
  assert.throws(
    () =>
      deriveBackgroundUserId(["channel-1:user-1", "channel-2:user-2"]),
    /same user/,
  );
});

test.each(["missing-separator", ":user-1", "channel-1:", "a:b:c"])(
  "rejects malformed thread ID %s",
  (threadId) => {
    assert.throws(
      () => deriveBackgroundUserId([threadId]),
      /expected channelId:userId/,
    );
  },
);

test("accepts an explicit user ID when it matches derived identity", () => {
  assert.equal(
    deriveBackgroundUserId(["channel-1:user-1"], "user-1"),
    "user-1",
  );
});

test("rejects an explicit user ID when it differs from derived identity", () => {
  assert.throws(
    () => deriveBackgroundUserId(["channel-1:user-1"], "user-2"),
    /does not match thread userId/,
  );
});
