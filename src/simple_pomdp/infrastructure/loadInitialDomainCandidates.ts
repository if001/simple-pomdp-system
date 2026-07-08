import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const loadInitialDomainCandidates = async (
  filePath = join(__dirname, "../../../domains/initial_domains.txt"),
): Promise<string[]> => {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
};
