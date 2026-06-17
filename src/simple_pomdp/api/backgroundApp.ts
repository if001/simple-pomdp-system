import { createSimplePomdpBackgroundRunner } from "./backgroundRunner";
import {
  createSimplePomdpSystemService,
  SimplePomdpSystemOptions,
} from "./service";

export interface SimplePomdpBackgroundAppOptions extends SimplePomdpSystemOptions {
  botId: string;
  threadIds: string[];
  userId: string;
  pollMs?: number;
  shouldRun?: () => Promise<boolean>;
}

export const createSimplePomdpBackgroundApp = (
  options: SimplePomdpBackgroundAppOptions,
) => {
  const service = createSimplePomdpSystemService(options);
  const runner = createSimplePomdpBackgroundRunner(service, {
    botId: options.botId,
    threadIds: options.threadIds,
    userId: options.userId,
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.shouldRun ? { shouldRun: options.shouldRun } : {}),
  });
  return { service, runner };
};
