import { join } from "node:path";
import { ChatOllama } from "@langchain/ollama";
import { createQueueApi, FileQueueStore } from "@chat-agent/queue";
import { createPostgresTurnRecordReader } from "@chat-agent/memory-system";
import {
  createFileCachedDialoguePlanningModel,
  createRecentTurnContextSource,
  createTopicStateInteractionLogContextSource,
  createUserMemoryContextSource,
  createPostgresUserMemoryReader,
  createLangChainExploitResearchAgent,
  createFileInteractionLogStore,
  createFileQueueBackgroundInputSink,
  createFileUserBeliefStore,
  loadInitialDomainCandidates,
  createOllamaDialoguePlanningModel,
  createSimplePomdpBackgroundApp,
  getFileQueueStatus,
  type KnowledgeAccessService,
  type SimplePomdpBackgroundAppOptions,
  type UserMemoryQueryExecutor,
} from "../index";

export const buildSimplePomdpBackgroundAppFromEnv = async (
  env: NodeJS.ProcessEnv,
) => {
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
  const queueApi = createQueueApi(new FileQueueStore(queueFilePath));
  const initialDomainCandidatesFile =
    env.SIMPLE_POMDP_INITIAL_DOMAIN_CANDIDATES_FILE ??
    join(__dirname, "../../domains/initial_domains.txt");
  const initialDomainCandidates = await loadInitialDomainCandidates(
    initialDomainCandidatesFile,
  );
  const knowledgeAccess = loadKnowledgeAccess();
  const knowledgePool = knowledgeAccess.createPostgresPool(
    requiredFromEnv(env, "POSTGRES_URL"),
  );
  const knowledgeDb = knowledgeAccess.createDrizzleClient(knowledgePool);
  const knowledgeEmbeddingProvider =
    new knowledgeAccess.OllamaEmbeddingProvider(
      requiredFromEnv(env, "OLLAMA_EMBEDDING_BASE_URL"),
      requiredFromEnv(env, "OLLAMA_EMBEDDING_MODEL"),
    );
  const knowledgeRepository = new knowledgeAccess.PostgresKnowledgeRepository(
    knowledgeDb,
    knowledgeEmbeddingProvider,
  );
  const knowledgeWebClient = new knowledgeAccess.SimpleWebClient(
    requiredFromEnv(env, "SIMPLE_CLIENT_BASE_URL"),
  );
  const knowledgeAnalysisModel =
    knowledgeAccess.createOllamaKnowledgeAccessAnalysisModel(
      requiredFromEnv(env, "OLLAMA_BASE_URL"),
      requiredFromEnv(env, "OLLAMA_CHAT_MODEL"),
      env.OLLAMA_API_KEY,
    );
  const knowledgeAccessService = knowledgeAccess.createKnowledgeAccessService({
    repository: knowledgeRepository,
    webClient: knowledgeWebClient,
    analysisModel: knowledgeAnalysisModel,
  }) as KnowledgeAccessService;
  const exploitAgentModel = new ChatOllama({
    baseUrl: requiredFromEnv(env, "OLLAMA_BASE_URL"),
    model: requiredFromEnv(env, "OLLAMA_CHAT_MODEL"),
    ...(env.OLLAMA_API_KEY
      ? { headers: { authorization: `Bearer ${env.OLLAMA_API_KEY}` } }
      : {}),
  });
  const turnRecordReader = createPostgresTurnRecordReader(
    requiredFromEnv(env, "POSTGRES_URL"),
  );
  const userBeliefStore = createFileUserBeliefStore({
    baseDir: join(storeDir, "beliefs"),
  });
  const interactionLogStore = createFileInteractionLogStore({
    baseDir: join(storeDir, "interaction-logs"),
    maxLogsPerUser: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_MAX_LOGS_PER_USER",
      200,
    ),
  });
  const recentTurnLimit = optionalNumberFromEnv(
    env,
    "SIMPLE_POMDP_RECENT_TURN_LIMIT",
    12,
  );
  const interactionLogLimit = optionalNumberFromEnv(
    env,
    "SIMPLE_POMDP_INTERACTION_LOG_LIMIT",
    20,
  );
  const options: SimplePomdpBackgroundAppOptions = {
    botId,
    threadIds,
    userId,
    pollMs: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_BACKGROUND_POLL_MS",
      60_000,
    ),
    turnRecordReader,
    userBeliefStore,
    interactionLogStore,
    contextSources: [
      createRecentTurnContextSource({
        reader: turnRecordReader,
        limit: recentTurnLimit,
      }),
      createUserMemoryContextSource({
        reader: createPostgresUserMemoryReader(
          knowledgePool as UserMemoryQueryExecutor,
        ),
      }),
      createTopicStateInteractionLogContextSource({
        userBeliefReader: userBeliefStore,
        interactionLogReader: interactionLogStore,
        limit: interactionLogLimit,
      }),
    ],
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
      queueApi,
      ...(env.SIMPLE_POMDP_QUEUE_DEBUG_LOG_FILE
        ? { debugLogFilePath: env.SIMPLE_POMDP_QUEUE_DEBUG_LOG_FILE }
        : {}),
    }),
    recentTurnLimit,
    interactionLogLimit,
    observeWindowTurns: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_OBSERVE_WINDOW_TURNS",
      3,
    ),
    pendingTimeoutMs: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_PENDING_TIMEOUT_MS",
      6 * 60 * 60 * 1000,
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
    interactionStartHour: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_INTERACTION_START_HOUR",
      0,
    ),
    interactionEndHour: optionalNumberFromEnv(
      env,
      "SIMPLE_POMDP_INTERACTION_END_HOUR",
      24,
    ),
    exploitResearchAgent: createLangChainExploitResearchAgent({
      model: exploitAgentModel,
      knowledgeAccessService,
    }),
    initialDomainCandidates,
    shouldRun: async () => {
      const status = await getFileQueueStatus(queueApi);
      const busy =
        status.counts.locked > 0 || status.counts.readyByType.user > 0;
      if (busy) {
        process.stdout.write(
          `[simple-pomdp] skipped background dispatch because user queue is busy locked=${status.counts.locked} readyUser=${status.counts.readyByType.user}\n`,
        );
      }
      return !busy;
    },
  };
  return {
    kind: "app" as const,
    app: createSimplePomdpBackgroundApp(options),
    meta: {
      botId,
      userId,
      threadIds,
      initialDomainCandidatesFile,
      initialDomainCount: initialDomainCandidates.length,
    },
  };
};

const loadKnowledgeAccess = (): {
  createPostgresPool: (connectionString: string) => unknown;
  createDrizzleClient: (pool: unknown) => unknown;
  OllamaEmbeddingProvider: new (
    baseUrl: string,
    model: string,
    fetchFn?: typeof fetch,
  ) => unknown;
  PostgresKnowledgeRepository: new (
    db: unknown,
    embeddingProvider: unknown,
  ) => unknown;
  SimpleWebClient: new (baseUrl: string, fetchFn?: typeof fetch) => unknown;
  createOllamaKnowledgeAccessAnalysisModel: (
    baseUrl: string,
    model: string,
    apiKey?: string,
  ) => unknown;
  createKnowledgeAccessService: (options: {
    repository: unknown;
    webClient: unknown;
    analysisModel: unknown;
  }) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} => require("../../../knowledge-access/lib");

const main = async (): Promise<void> => {
  const built = await buildSimplePomdpBackgroundAppFromEnv(process.env);
  if (built.kind === "empty") {
    process.stdout.write(
      "[simple-pomdp] SIMPLE_POMDP_THREAD_IDS is empty; exiting without starting runner\n",
    );
    return;
  }
  process.stdout.write(
    `[simple-pomdp] starting botId=${built.meta.botId} userId=${built.meta.userId} threads=${built.meta.threadIds.join(",")} domains=${built.meta.initialDomainCount} domainsFile=${built.meta.initialDomainCandidatesFile}\n`,
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
