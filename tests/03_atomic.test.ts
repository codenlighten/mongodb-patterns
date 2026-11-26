import { describe, expect, it } from "vitest";
import {
  incrementAtomically,
  incrementByReadThenWrite,
  reserve,
  updateWithVersion,
  type Counter,
  type Stock,
} from "../src/atomic.js";
import { barrier, useDb } from "./helpers.js";

const db = useDb();

async function counter() {
  const counters = db().db.collection<Counter>("counters");
  await counters.insertOne({ _id: "c", n: 0, version: 0 });
  return counters;
}

describe("lost updates", () => {
  it("read-then-write loses one of two increments when both read first", async () => {
    const counters = await counter();
    const bothRead = barrier(2);
    await Promise.all([
      incrementByReadThenWrite(counters, "c", bothRead),
      incrementByReadThenWrite(counters, "c", bothRead),
    ]);
    expect((await counters.findOne({ _id: "c" }))?.n).toBe(1);
  });

  it("$inc keeps all 200 concurrent increments", async () => {
    const counters = await counter();
    await Promise.all(Array.from({ length: 200 }, () => incrementAtomically(counters, "c")));
    expect((await counters.findOne({ _id: "c" }))?.n).toBe(200);
  });

  it("a version check makes the loser read again and apply its change to the new value", async () => {
    const counters = await counter();
    const bothRead = barrier(2);
    const attempts = await Promise.all([
      updateWithVersion(counters, "c", (n) => n * 2 + 1, bothRead),
      updateWithVersion(counters, "c", (n) => n * 2 + 1, bothRead),
    ]);
    expect(attempts.sort()).toEqual([1, 2]);
    expect(await counters.findOne({ _id: "c" })).toMatchObject({ n: 3, version: 2 });
  });

  it("gives up after the attempt limit instead of looping for ever", async () => {
    const counters = await counter();
    const interfere = async () => {
      await counters.updateOne({ _id: "c" }, { $inc: { version: 1 } });
    };
    await expect(updateWithVersion(counters, "c", (n) => n + 1, interfere, 3)).rejects.toThrow(/after 3 attempts/);
    expect((await counters.findOne({ _id: "c" }))?.n).toBe(0);
  });
});

describe("conditional decrement", () => {
  it("sells exactly the stock to 100 concurrent buyers", async () => {
    const stock = db().db.collection<Stock>("stock");
    await stock.insertOne({ _id: "sku", quantity: 10 });
    const results = await Promise.all(Array.from({ length: 100 }, () => reserve(stock, "sku", 1)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await stock.findOne({ _id: "sku" }))?.quantity).toBe(0);
  });

  it("refuses a quantity larger than what is left, and non-positive quantities", async () => {
    const stock = db().db.collection<Stock>("stock");
    await stock.insertOne({ _id: "sku", quantity: 3 });
    expect(await reserve(stock, "sku", 4)).toBe(false);
    await expect(reserve(stock, "sku", -5)).rejects.toThrow(RangeError);
    await expect(reserve(stock, "sku", 0)).rejects.toThrow(RangeError);
    expect((await stock.findOne({ _id: "sku" }))?.quantity).toBe(3);
  });
});
