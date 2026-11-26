import type { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { readPlan } from "../src/explain.js";
import { after, newestFirst, pageByKeyset, pageBySkip, pageByTimeOnly, type Event } from "../src/pagination.js";
import { at, useDb } from "./helpers.js";

const db = useDb();

async function events(n: number, timestamp: (i: number) => Date = at) {
  const collection = db().db.collection<Event>("events");
  await collection.createIndex(newestFirst);
  await collection.insertMany(Array.from({ length: n }, (_, i) => ({ createdAt: timestamp(i), label: `e${i}` })));
  return collection;
}

/** Walks every page. Bounded, so a cursor that never advances fails instead of hanging. */
async function walk(c: Awaited<ReturnType<typeof events>>, size: number, between?: () => Promise<void>) {
  const labels: string[] = [];
  let cursor: { createdAt: Date; _id: ObjectId } | undefined;
  for (let page = 0; page < 100; page++) {
    const rows = await pageByKeyset(c, size, cursor);
    if (rows.length === 0) return labels;
    labels.push(...rows.map((r) => r.label));
    const last = rows.at(-1)!;
    cursor = { createdAt: last.createdAt, _id: last._id };
    await between?.();
  }
  throw new Error("pagination never ended");
}

describe("skip", () => {
  it("repeats rows when new ones arrive between pages", async () => {
    const c = await events(20);
    const first = await pageBySkip(c, 0, 5);
    await c.insertMany([1, 2].map((i) => ({ createdAt: at(100 + i), label: `new${i}` })));
    const second = await pageBySkip(c, 1, 5);
    const repeated = second.filter((r) => first.some((f) => f.label === r.label));
    expect(repeated.map((r) => r.label)).toEqual(["e16", "e15"]);
  });

  it("examines every skipped key", async () => {
    const c = await events(2000);
    const plan = readPlan(await c.find({}, { sort: newestFirst, skip: 1500, limit: 10 }).explain("executionStats"));
    expect(plan.returned).toBe(10);
    expect(plan.keysExamined).toBeGreaterThanOrEqual(1510);
  });
});

describe("keyset", () => {
  it("returns every original row exactly once while new rows arrive", async () => {
    const c = await events(20);
    let n = 0;
    const labels = await walk(c, 3, async () => {
      await c.insertOne({ createdAt: at(1000 + n++), label: `new${n}` });
    });
    expect(labels).toEqual(Array.from({ length: 20 }, (_, i) => `e${19 - i}`));
  });

  it("returns every row once when many share a timestamp", async () => {
    const c = await events(23, (i) => at(Math.floor(i / 7)));
    const labels = await walk(c, 4);
    expect(labels).toHaveLength(23);
    expect(new Set(labels).size).toBe(23);
  });

  it("shows the trap: paging by timestamp alone skips rows that share one", async () => {
    const c = await events(10, () => at(0));
    const first = await pageByTimeOnly(c, 4);
    const second = await pageByTimeOnly(c, 4, first.at(-1)!.createdAt);
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(0);
  });

  it("examines about a page of keys however deep it is", async () => {
    const c = await events(2000);
    const [anchor] = await pageBySkip(c, 150, 10);
    const filter = after({ createdAt: anchor!.createdAt, _id: anchor!._id });
    const plan = readPlan(await c.find(filter, { sort: newestFirst, limit: 10 }).explain("executionStats"));
    expect(plan.returned).toBe(10);
    expect(plan.keysExamined).toBeLessThanOrEqual(15);
    expect(plan.docsExamined).toBeLessThanOrEqual(15);
  });
});
