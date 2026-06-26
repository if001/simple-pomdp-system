import { SimplePomdpSystemService } from "./service";

export interface SimplePomdpBackgroundRunnerOptions {
  botId: string;
  threadIds: string[];
  userId: string;
  pollMs?: number;
  shouldRun?: () => Promise<boolean>;
}

export interface SimplePomdpBackgroundRunner {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
}

export const createSimplePomdpBackgroundRunner = (
  service: Pick<SimplePomdpSystemService, "dispatchNext">,
  options: SimplePomdpBackgroundRunnerOptions,
): SimplePomdpBackgroundRunner => {
  const pollMs = options.pollMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    process.stdout.write(
      "[simple-pomdp-runner] ------------- cycle start ---------------- \n",
    );
    if (options.shouldRun && !(await options.shouldRun())) {
      process.stdout.write("[simple-pomdp-runner] skipped by shouldRun\n");
      return;
    }
    process.stdout.write(
      `[simple-pomdp-runner] cycle start botId=${options.botId} threads=${options.threadIds.length}\n`,
    );
    for (const threadId of options.threadIds) {
      process.stdout.write(
        `[simple-pomdp-runner] dispatch threadId=${threadId} userId=${options.userId}\n`,
      );
      await service.dispatchNext({
        botId: options.botId,
        threadId,
        userId: options.userId,
      });
    }
    process.stdout.write(
      "[simple-pomdp-runner] ------------- cycle complete ---------------- \n",
    );
  };

  const tick = (): void => {
    if (!running || inFlight) {
      return;
    }
    inFlight = runOnce()
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        process.stdout.write(`[simple-pomdp-background-error] ${message}\n`);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      process.stdout.write(
        `[simple-pomdp-runner] start pollMs=${pollMs} threads=${options.threadIds.join(",")}\n`,
      );
      timer = setInterval(tick, pollMs);
      tick();
    },
    stop() {
      running = false;
      process.stdout.write("[simple-pomdp-runner] stop\n");
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async runOnce() {
      await runOnce();
    },
  };
};
