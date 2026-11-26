import { afterEach, beforeEach } from "vitest";
import { throwawayDb, type Throwaway } from "../src/db.js";

/** A fresh database for every test in the file. */
export function useDb(): () => Throwaway {
  let current: Throwaway | undefined;
  beforeEach(async () => {
    current = await throwawayDb();
  });
  afterEach(async () => {
    await current?.drop();
    current = undefined;
  });
  return () => {
    if (!current) throw new Error("no database: call this inside a test");
    return current;
  };
}

/**
 * Makes `parties` callers wait for each other, so a race happens every time instead of sometimes. After the
 * first round it lets everyone through; the timeout only stops a broken test from hanging.
 */
export function barrier(parties: number, timeoutMs = 5000): () => Promise<void> {
  let waiting = 0;
  let open = false;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (open) return;
    waiting += 1;
    if (waiting >= parties) {
      open = true;
      release();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      released,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`barrier: only ${waiting} of ${parties} arrived`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A fixed clock for tests: `at(5)` is five seconds after the start. */
export const at = (seconds: number): Date => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);
