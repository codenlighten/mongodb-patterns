import { describe, expect, it } from "vitest";
import { readPlan } from "../src/explain.js";
import { claim, claimable, claimByReadThenWrite, complete, createQueueIndexes, type Job } from "../src/queue.js";
import { at, barrier, useDb } from "./helpers.js";

const db = useDb();
const LEASE = 30_000;

async function queue(n: number) {
  const jobs = db().db.collection<Job>("jobs");
  await createQueueIndexes(jobs);
  if (n > 0) {
    await jobs.insertMany(
      // Inserted newest first, so "oldest first" cannot be satisfied by insertion order.
      Array.from({ length: n }, (_, i) => ({ status: "queued" as const, createdAt: at(n - 1 - i), attempt: 0 })),
    );
  }
  return jobs;
}

describe("claiming", () => {
  it("hands out the oldest job first", async () => {
    const jobs = await queue(3);
    expect((await claim(jobs, "w", at(100), LEASE))?.createdAt).toEqual(at(0));
    expect((await claim(jobs, "w", at(100), LEASE))?.createdAt).toEqual(at(1));
  });

  it("gives each of 200 jobs to exactly one of eight workers", async () => {
    const jobs = await queue(200);
    const taken = await Promise.all(
      Array.from({ length: 8 }, async (_, w) => {
        const mine: string[] = [];
        // Bounded so that a broken claim fails the test instead of looping for ever.
        for (let i = 0; i <= 200; i++) {
          const job = await claim(jobs, `w${w}`, at(1000), LEASE);
          if (!job) return mine;
          mine.push(job._id.toHexString());
          await complete(jobs, job);
        }
        throw new Error("the queue never emptied");
      }),
    );
    const ids = taken.flat();
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(await jobs.countDocuments({ status: "done" })).toBe(200);
  });

  it("shows the trap: read-then-write gives two workers the same job", async () => {
    const jobs = await queue(2);
    const bothRead = barrier(2);
    const [a, b] = await Promise.all([
      claimByReadThenWrite(jobs, "a", bothRead),
      claimByReadThenWrite(jobs, "b", bothRead),
    ]);
    expect(a?._id).toEqual(b?._id);
    expect(await jobs.countDocuments({ status: "queued" })).toBe(1);
  });
});

describe("leases", () => {
  it("does not hand a leased job to anyone else", async () => {
    const jobs = await queue(1);
    expect(await claim(jobs, "a", at(10), LEASE)).not.toBeNull();
    expect(await claim(jobs, "b", at(39), LEASE)).toBeNull();
  });

  it("hands it over once the lease expires, counting the attempt", async () => {
    const jobs = await queue(1);
    await claim(jobs, "a", at(10), LEASE);
    expect(await claim(jobs, "b", at(40), LEASE)).toMatchObject({ owner: "b", attempt: 2 });
  });

  it("refuses completion from the worker that lost the job", async () => {
    const jobs = await queue(1);
    const stale = await claim(jobs, "a", at(10), LEASE);
    const current = await claim(jobs, "b", at(40), LEASE);
    expect(await complete(jobs, stale!)).toBe(false);
    expect(await complete(jobs, current!)).toBe(true);
    expect(await complete(jobs, current!)).toBe(false);
  });

  it("refuses completion of a job that was put back in the queue", async () => {
    const jobs = await queue(1);
    const claimed = await claim(jobs, "a", at(10), LEASE);
    // An operator requeues it, for example because its input changed.
    await jobs.updateOne({ _id: claimed!._id }, { $set: { status: "queued" }, $unset: { leaseUntil: "" } });
    expect(await complete(jobs, claimed!)).toBe(false);
    expect((await jobs.findOne({ _id: claimed!._id }))?.status).toBe("queued");
  });

  it("fences by attempt even when the same worker name claims again", async () => {
    const jobs = await queue(1);
    const first = await claim(jobs, "a", at(10), LEASE);
    const second = await claim(jobs, "a", at(40), LEASE);
    expect(await complete(jobs, first!)).toBe(false);
    expect(await complete(jobs, second!)).toBe(true);
  });
});

describe("with a long history of finished jobs", () => {
  it("a query with the claim's filter and sort reads none of the finished ones", async () => {
    const jobs = await queue(0);
    await jobs.insertMany(
      Array.from({ length: 5000 }, (_, i) => ({ status: "done" as const, createdAt: at(i), attempt: 1 })),
    );
    await jobs.insertOne({ status: "queued", createdAt: at(6000), attempt: 0 });
    const plan = readPlan(
      await jobs
        .find(claimable(at(7000)), { sort: { createdAt: 1, _id: 1 }, limit: 1 })
        .explain("executionStats"),
    );
    expect(plan.stages).not.toContain("COLLSCAN");
    expect(plan.returned).toBe(1);
    expect(plan.docsExamined).toBeLessThanOrEqual(2);
    expect(plan.keysExamined).toBeLessThanOrEqual(5);
  });

  it("shows the limit: it does read every running job whose lease is still valid", async () => {
    const jobs = await queue(0);
    await jobs.insertMany(
      Array.from({ length: 1000 }, (_, i) => ({
        status: "running" as const,
        createdAt: at(i),
        attempt: 1,
        owner: "busy",
        leaseUntil: at(100_000),
      })),
    );
    await jobs.insertOne({ status: "queued", createdAt: at(6000), attempt: 0 });
    const plan = readPlan(
      await jobs
        .find(claimable(at(7000)), { sort: { createdAt: 1, _id: 1 }, limit: 1 })
        .explain("executionStats"),
    );
    expect(plan.returned).toBe(1);
    // The index orders by age but does not hold `leaseUntil`, so each older running job is fetched and rejected.
    expect(plan.docsExamined).toBeGreaterThanOrEqual(1000);
  });
});
