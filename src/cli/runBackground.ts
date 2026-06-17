import { join } from "node:path";
import {
  createFileCachedDialoguePlanningModel,
  createFileInteractionLogStore,
  createFileQueueBackgroundInputSink,
  createFileTurnRecordStore,
  createFileUserBeliefStore,
  createOllamaDialoguePlanningModel,
  createSimplePomdpBackgroundApp,
  getFileQueueStatus,
} from "../index";

export const buildSimplePomdpBackgroundAppFromEnv = (env: NodeJS.ProcessEnv) => {
  const botId = env.BOT_ID ?? "ao";
  const threadIds = (env.SIMPLE_POMDP_THREAD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (threadIds.length === 0) {
    return { kind: "empty" as const };
  }
  const userId = env.SIMPLE_POMDP_USER_ID ?? "discord-user";
  const storeDir = env.SIMPLE_POMDP_STORE_DIR ?? "data/simple-pomdp-system";
  const queueFilePath = requiredFromEnv(env, "SIMPLE_POMDP_QUEUE_FILE");
  const app = createSimplePomdpBackgroundApp({
    botId,
    threadIds,
    userId,
    pollMs: optionalNumberFromEnv(env, "SIMPLE_POMDP_BACKGROUND_POLL_MS", 60_000),
    turnRecordStore: createFileTurnRecordStore({
      baseDir: join(storeDir, "turn-records"),
      maxTurnsPerThread: optionalNumberFromEnv(
        env,
        "SIMPLE_POMDP_MAX_TURNS_PER_THREAD",
        200,
      ),
    }),
    userBeliefStore: createFileUserBeliefStore({
      baseDir: join(storeDir, "beliefs"),
    }),
    interactionLogStore: createFileInteractionLogStore({
      baseDir: join(storeDir, "interaction-logs"),
      maxLogsPerUser: optionalNumberFromEnv(
        env,
        "SIMPLE_POMDP_MAX_LOGS_PER_USER",
        200,
      ),
    }),
    plannerModel: createFileCachedDialoguePlanningModel(
      createOllamaDialoguePlanningModel(
        requiredFromEnv(env, "OLLAMA_BASE_URL"),
        requiredFromEnv(env, "OLLAMA_CHAT_MODEL"),
        env.OLLAMA_API_KEY,
      ),
      {
        cacheDir: join(storeDir, "llm-cache"),
        ttlMs: optionalNumberFromEnv(
          env,
          "SIMPLE_POMDP_LLM_CACHE_TTL_MS",
          24 * 60 * 60 * 1000,
        ),
      },
    ),
    backgroundInputSink: createFileQueueBackgroundInputSink({
      filePath: queueFilePath,
      channelId: requiredFromEnv(env, "MENTION_CHANNEL_ID"),
      ...(env.SIMPLE_POMDP_QUEUE_DEBUG_LOG_FILE
        ? { debugLogFilePath: env.SIMPLE_POMDP_QUEUE_DEBUG_LOG_FILE }
        : {}),
    }),
    recentTurnLimit: optionalNumberFromEnv(env, "SIMPLE_POMDP_RECENT_TURN_LIMIT", 12),
    interactionLogLimit: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_INTERACTION_LOG_LIMIT",
      20,
    ),
    observeWindowTurns: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_OBSERVE_WINDOW_TURNS",
      3,
    ),
    dispatchCooldownMs: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_DISPATCH_COOLDOWN_MS",
      60 * 60 * 1000,
    ),
    maxPendingInteractions: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_MAX_PENDING_INTERACTIONS",
      1,
    ),
    shouldRun: async () => {
      const status = await getFileQueueStatus(queueFilePath);
      const busy =
        status.counts.locked > 0 || status.counts.readyByType.user > 0;
      if (busy) {
        process.stdout.write(
          `[simple-pomdp] skipped background dispatch because user queue is busy locked=${status.counts.locked} readyUser=${status.counts.readyByType.user}\n`,
        );
      }
      return !busy;
    },
  });
  return {
    kind: "app" as const,
    app,
    meta: {
      botId,
      userId,
      threadIds,
    },
  };
};

const main = async (): Promise<void> => {
  const built = buildSimplePomdpBackgroundAppFromEnv(process.env);
  if (built.kind === "empty") {
    process.stdout.write(
      "[simple-pomdp] SIMPLE_POMDP_THREAD_IDS is empty; exiting without starting runner\n",
    );
    return;
  }
  process.stdout.write(
    `[simple-pomdp] starting botId=${built.meta.botId} userId=${built.meta.userId} threads=${built.meta.threadIds.join(",")}\n`,
  );
  built.app.runner.start();
  const shutdown = (): void => {
    process.stdout.write("[simple-pomdp] stopping\n");
    built.app.runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

const requiredFromEnv = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const optionalNumberFromEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const value = env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return parsed;
};

if (require.main === module) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`${message}\n`);
    process.exit(1);
  });
}
