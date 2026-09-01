import { UserMemoryReader } from "../domain/types";

export interface UserMemoryQueryExecutor {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Array<{ note: unknown; created_at: unknown }> }>;
}

export const createPostgresUserMemoryReader = (
  executor: UserMemoryQueryExecutor,
): UserMemoryReader => ({
  async listRecentUserMemory(input) {
    const result = await executor.query(
      [
        "select note, created_at",
        "from user_notes",
        "where user_id = $1",
        "order by created_at desc",
        "limit $2",
      ].join(" "),
      [input.userId, input.limit],
    );
    return result.rows
      .filter((row) => typeof row.note === "string")
      .map((row) => ({
        text: row.note as string,
        ...(row.created_at instanceof Date
          ? { createdAtIso: row.created_at.toISOString() }
          : typeof row.created_at === "string"
            ? { createdAtIso: row.created_at }
            : {}),
      }));
  },
});
