// Study 7: paging through data that changes while you read it.
import type { Collection, Filter, ObjectId, WithId } from "mongodb";

export interface Event {
  _id?: ObjectId;
  createdAt: Date;
  label: string;
}

export interface Cursor {
  createdAt: Date;
  _id: ObjectId;
}

export const newestFirst = { createdAt: -1, _id: -1 } as const;

export async function pageBySkip(events: Collection<Event>, page: number, size: number): Promise<WithId<Event>[]> {
  return events.find({}, { sort: newestFirst, skip: page * size, limit: size }).toArray();
}

/** Everything strictly older than the cursor; `_id` breaks ties between equal timestamps. */
export function after(cursor: Cursor | undefined): Filter<Event> {
  if (!cursor) return {};
  return {
    $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }],
  };
}

export async function pageByKeyset(
  events: Collection<Event>,
  size: number,
  cursor?: Cursor,
): Promise<WithId<Event>[]> {
  return events.find(after(cursor), { sort: newestFirst, limit: size }).toArray();
}

/** BROKEN on purpose: rows sharing the cursor's timestamp are skipped. */
export async function pageByTimeOnly(
  events: Collection<Event>,
  size: number,
  before?: Date,
): Promise<WithId<Event>[]> {
  const filter: Filter<Event> = before ? { createdAt: { $lt: before } } : {};
  return events.find(filter, { sort: newestFirst, limit: size }).toArray();
}
