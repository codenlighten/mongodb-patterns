import { describe, expect, it } from "vitest";
import { readPlan } from "../src/explain.js";
import { at, useDb } from "./helpers.js";

const db = useDb();
const N = 5000;

/** 5000 orders; every tenth is open, totals cycle through 0..999. */
async function orders() {
  const collection = db().db.collection("orders");
  await collection.insertMany(
    Array.from({ length: N }, (_, i) => ({
      status: i % 10 === 0 ? "open" : "closed",
      createdAt: at(i),
      total: (i * 37) % 1000,
      email: `User${i}@Example.test`,
    })),
  );
  return collection;
}

const query = { status: "open", total: { $gte: 500 } };
const sort = { createdAt: -1 } as const;

describe("equality, sort, range", () => {
  it("without an index, reads every document", async () => {
    const c = await orders();
    const plan = readPlan(await c.find(query, { sort, limit: 10 }).explain("executionStats"));
    expect(plan.stages).toContain("COLLSCAN");
    expect(plan.docsExamined).toBe(N);
  });

  it("range before sort uses the index but still sorts in memory", async () => {
    const c = await orders();
    await c.createIndex({ status: 1, total: 1, createdAt: -1 }, { name: "ers" });
    const plan = readPlan(await c.find(query, { sort, limit: 10 }).hint("ers").explain("executionStats"));
    expect(plan.stages).toContain("SORT");
    // Every matching key must be read before the first ten are known.
    expect(plan.keysExamined).toBeGreaterThan(200);
  });

  it("sort before range returns rows in order and stops after ten", async () => {
    const c = await orders();
    await c.createIndex({ status: 1, createdAt: -1, total: 1 }, { name: "esr" });
    const plan = readPlan(await c.find(query, { sort, limit: 10 }).hint("esr").explain("executionStats"));
    expect(plan.stages).not.toContain("SORT");
    expect(plan.returned).toBe(10);
    expect(plan.docsExamined).toBe(10);
    expect(plan.keysExamined).toBeLessThan(40);
  });
});

describe("covered queries", () => {
  it("answers from the index alone when every wanted field is in it", async () => {
    const c = await orders();
    await c.createIndex({ status: 1, total: 1 });
    const plan = readPlan(
      await c.find({ status: "open" }, { projection: { _id: 0, total: 1 } }).explain("executionStats"),
    );
    expect(plan.returned).toBe(N / 10);
    expect(plan.docsExamined).toBe(0);
  });

  it("reads documents again as soon as _id is left in the projection", async () => {
    const c = await orders();
    await c.createIndex({ status: 1, total: 1 });
    const plan = readPlan(await c.find({ status: "open" }, { projection: { total: 1 } }).explain("executionStats"));
    expect(plan.docsExamined).toBe(N / 10);
  });
});

describe("case-insensitive lookup", () => {
  const collation = { locale: "en", strength: 2 };

  it("uses the collation index only when the query asks for the same collation", async () => {
    const c = await orders();
    await c.createIndex({ email: 1 }, { name: "email_ci", collation });
    const matched = readPlan(await c.find({ email: "user42@example.test" }, { collation }).explain("executionStats"));
    expect(matched.indexes).toContain("email_ci");
    expect(matched).toMatchObject({ returned: 1, docsExamined: 1 });

    const plain = readPlan(await c.find({ email: "User42@Example.test" }).explain("executionStats"));
    expect(plain.stages).toContain("COLLSCAN");
    expect(plain.docsExamined).toBe(N);
  });
});

describe("partial indexes", () => {
  it("indexes only the rows that are asked for", async () => {
    const c = await orders();
    await c.createIndex({ createdAt: 1 }, { name: "open_only", partialFilterExpression: { status: "open" } });
    const plan = readPlan(
      await c.find({ status: "open" }, { sort: { createdAt: 1 } }).hint("open_only").explain("executionStats"),
    );
    expect(plan.keysExamined).toBe(N / 10);
  });

  it("is not used by a query that could need rows outside it", async () => {
    const c = await orders();
    await c.createIndex({ createdAt: 1 }, { name: "open_only", partialFilterExpression: { status: "open" } });
    const plan = readPlan(await c.find({ createdAt: { $gte: at(0) } }).explain("executionStats"));
    expect(plan.indexes).not.toContain("open_only");
    expect(plan.returned).toBe(N);
  });
});

describe("multikey limit", () => {
  it("refuses a compound index entry over two arrays", async () => {
    const c = db().db.collection("tags");
    await c.createIndex({ a: 1, b: 1 });
    await c.insertOne({ a: [1, 2], b: 3 });
    await expect(c.insertOne({ a: [1, 2], b: [3, 4] })).rejects.toThrow(/parallel arrays/);
  });
});
