// Study 3: single-document updates. Each update is atomic; a read followed by a write is not.
import type { Collection } from "mongodb";

export interface Counter {
  _id: string;
  n: number;
  version: number;
}

export interface Stock {
  _id: string;
  quantity: number;
}

/** BROKEN on purpose: another writer can act between the read and the write, and its change is lost. */
export async function incrementByReadThenWrite(
  counters: Collection<Counter>,
  id: string,
  afterRead: () => Promise<void> = async () => {},
): Promise<void> {
  const doc = await counters.findOne({ _id: id });
  if (!doc) throw new Error(`no counter ${id}`);
  await afterRead();
  await counters.updateOne({ _id: id }, { $set: { n: doc.n + 1 } });
}

/** The server does the arithmetic inside the atomic update. */
export async function incrementAtomically(counters: Collection<Counter>, id: string): Promise<void> {
  await counters.updateOne({ _id: id }, { $inc: { n: 1 } });
}

/**
 * Optimistic concurrency, for changes an update operator cannot express: write only if the document still
 * has the version that was read, otherwise read again.
 */
export async function updateWithVersion(
  counters: Collection<Counter>,
  id: string,
  change: (current: number) => number,
  afterRead: (attempt: number) => Promise<void> = async () => {},
  maxAttempts = 20,
): Promise<number> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const doc = await counters.findOne({ _id: id });
    if (!doc) throw new Error(`no counter ${id}`);
    await afterRead(attempt);
    const result = await counters.updateOne(
      { _id: id, version: doc.version },
      { $set: { n: change(doc.n) }, $inc: { version: 1 } },
    );
    if (result.matchedCount === 1) return attempt;
  }
  throw new Error(`gave up on ${id} after ${maxAttempts} attempts`);
}

/** Check and decrement in one operation: stock can never go below zero. */
export async function reserve(stock: Collection<Stock>, id: string, quantity: number): Promise<boolean> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError("quantity must be a positive integer");
  const result = await stock.updateOne({ _id: id, quantity: { $gte: quantity } }, { $inc: { quantity: -quantity } });
  return result.modifiedCount === 1;
}
