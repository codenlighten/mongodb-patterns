// Study 2: when an embedded array is the wrong model, and the bucket pattern.
import type { Collection, ObjectId } from "mongodb";

export interface Post {
  _id?: ObjectId;
  comments: string[];
}

/** Fine while the array is small. A document cannot exceed 16 MiB, so an unbounded array ends in errors. */
export async function appendComment(posts: Collection<Post>, id: ObjectId, text: string): Promise<void> {
  await posts.updateOne({ _id: id }, { $push: { comments: text } });
}

export interface Bucket {
  sensor: string;
  count: number;
  readings: number[];
}

/**
 * Appends to a bucket that still has room, creating one if none does. The `count < cap` condition and the
 * push happen atomically on one document, so no bucket holds more than `cap` readings. Concurrent writers
 * may start more than the minimum number of buckets. The cap counts readings, not bytes: choose it so a
 * full bucket stays well under 16 MiB.
 */
export async function appendReading(
  buckets: Collection<Bucket>,
  sensor: string,
  reading: number,
  cap: number,
): Promise<void> {
  // With a cap below 1 no bucket ever has room, so every write would create one holding a reading.
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError("cap must be a positive integer");
  await buckets.updateOne(
    { sensor, count: { $lt: cap } },
    { $push: { readings: reading }, $inc: { count: 1 } },
    { upsert: true },
  );
}
