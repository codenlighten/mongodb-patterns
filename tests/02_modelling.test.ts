import { describe, expect, it } from "vitest";
import { appendComment, appendReading, type Bucket, type Post } from "../src/modelling.js";
import { useDb } from "./helpers.js";

const db = useDb();
const MiB = 1024 * 1024;

describe("an unbounded embedded array", () => {
  it("works until the document reaches 16 MiB, then every further append fails", async () => {
    const posts = db().db.collection<Post>("posts");
    const { insertedId } = await posts.insertOne({ comments: [] });
    const big = "x".repeat(MiB);
    for (let i = 0; i < 15; i++) await appendComment(posts, insertedId, big);
    await expect(appendComment(posts, insertedId, big)).rejects.toThrow(/larger than 16777216/);
    const stored = await posts.findOne({ _id: insertedId });
    expect(stored?.comments).toHaveLength(15);
  });
});

describe("the bucket pattern", () => {
  it("fills one bucket at a time when writers take turns", async () => {
    const buckets = db().db.collection<Bucket>("buckets");
    for (let i = 0; i < 25; i++) await appendReading(buckets, "s1", i, 10);
    const all = await buckets.find({ sensor: "s1" }).toArray();
    expect(all.map((b) => b.count).sort((a, b) => b - a)).toEqual([10, 10, 5]);
  });

  it("never exceeds the cap or loses a reading under 500 concurrent writes", async () => {
    const buckets = db().db.collection<Bucket>("buckets");
    await buckets.createIndex({ sensor: 1, count: 1 });
    await Promise.all(Array.from({ length: 500 }, (_, i) => appendReading(buckets, "s1", i, 20)));
    const all = await buckets.find().toArray();
    for (const b of all) {
      expect(b.count).toBeLessThanOrEqual(20);
      expect(b.readings).toHaveLength(b.count);
    }
    const readings = all.flatMap((b) => b.readings).sort((a, b) => a - b);
    expect(readings).toEqual(Array.from({ length: 500 }, (_, i) => i));
    // Deliberately not asserted: the number of buckets. Concurrent upserts may open more than 25.
    expect(all.length).toBeGreaterThanOrEqual(25);
  });

  it.each([0, -1, 2.5, Number.NaN])("refuses a cap of %s", async (cap) => {
    const buckets = db().db.collection<Bucket>("buckets");
    await expect(appendReading(buckets, "s1", 1, cap)).rejects.toThrow(RangeError);
    expect(await buckets.countDocuments()).toBe(0);
  });

  it("keeps sensors apart", async () => {
    const buckets = db().db.collection<Bucket>("buckets");
    await appendReading(buckets, "s1", 1, 10);
    await appendReading(buckets, "s2", 2, 10);
    expect(await buckets.countDocuments()).toBe(2);
  });
});
