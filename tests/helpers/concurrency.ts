/**
 * Runs `worker` over every item with at most `limit` in flight at any moment
 * (a small worker-pool), instead of opening every connection in one single
 * `Promise.all` burst. 500 simulated buyers each opening a raw Postgres
 * connection at the exact same instant will blow past the default
 * `max_connections` (100) on a stock local Postgres/Supabase image and fail
 * with "sorry, too many clients already" — a test-infra artifact, not a real
 * oversell bug. Throttling keeps the test meaningful (many transactions still
 * race for the same tier_inventory row concurrently) while staying safely
 * below typical connection limits. Override via DB_TEST_MAX_CONCURRENCY if
 * your test database is configured with more headroom.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}
