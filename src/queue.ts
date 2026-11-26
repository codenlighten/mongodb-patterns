// Study 5: a job queue with leases, using one atomic find-and-update to claim.
import type { Collection, Filter, ObjectId, WithId } from "mongodb";

export interface Job {
  _id?: ObjectId;
  status: "queued" | "running" | "done";
  createdAt: Date;
  attempt: number;
  owner?: string;
  leaseUntil?: Date;
}

export async function createQueueIndexes(jobs: Collection<Job>): Promise<void> {
  await jobs.createIndex({ status: 1, createdAt: 1, _id: 1 });
}

export function claimable(now: Date): Filter<Job> {
  return { $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lte: now } }] };
}

/**
 * Claims the oldest available job, including one whose worker let its lease expire. Finding and marking are
 * one operation: if two workers aim at the same job, one update loses, and the server re-checks the filter
 * and moves on to another job.
 */
export async function claim(
  jobs: Collection<Job>,
  worker: string,
  now: Date,
  leaseMs: number,
): Promise<WithId<Job> | null> {
  return jobs.findOneAndUpdate(
    claimable(now),
    {
      $set: { status: "running", owner: worker, leaseUntil: new Date(now.getTime() + leaseMs) },
      $inc: { attempt: 1 },
    },
    { sort: { createdAt: 1, _id: 1 }, returnDocument: "after" },
  );
}

/**
 * Marks a job done only if this claim is still the current one. The attempt number is a fencing token: a
 * worker that stalled past its lease cannot overwrite the result of the worker that took over.
 */
export async function complete(jobs: Collection<Job>, job: WithId<Job>): Promise<boolean> {
  const result = await jobs.updateOne(
    { _id: job._id, status: "running", attempt: job.attempt },
    { $set: { status: "done" }, $unset: { leaseUntil: "" } },
  );
  return result.modifiedCount === 1;
}

/** BROKEN on purpose: two workers can read the same job before either marks it. */
export async function claimByReadThenWrite(
  jobs: Collection<Job>,
  worker: string,
  afterRead: () => Promise<void> = async () => {},
): Promise<WithId<Job> | null> {
  const job = await jobs.findOne({ status: "queued" }, { sort: { createdAt: 1, _id: 1 } });
  if (!job) return null;
  await afterRead();
  await jobs.updateOne({ _id: job._id }, { $set: { status: "running", owner: worker } });
  return job;
}
