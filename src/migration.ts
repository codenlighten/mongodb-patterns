// Study 8: changing a document's shape while the application keeps writing.
import type { Collection, Db, ObjectId } from "mongodb";

export interface Person {
  _id?: ObjectId;
  /** Version 1 shape. */
  name?: string;
  /** Version 2 shape. */
  schemaVersion?: 2;
  firstName?: string;
  lastName?: string;
}

export function split(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const at = trimmed.lastIndexOf(" ");
  return at < 0
    ? { firstName: trimmed, lastName: "" }
    : { firstName: trimmed.slice(0, at).trim(), lastName: trimmed.slice(at + 1) };
}

/** During the migration every reader accepts both shapes. */
export function displayName(person: Person): string {
  if (person.schemaVersion === 2) return `${person.firstName} ${person.lastName}`.trim();
  return (person.name ?? "").trim();
}

export interface BackfillOptions {
  batchSize: number;
  /** Stop early, as a crash or a deploy would. */
  maxBatches?: number;
  afterRead?: () => Promise<void>;
  /** false gives the BROKEN version, which overwrites changes made since the read. */
  checkUnchanged?: boolean;
}

/**
 * Converts old documents in small batches. Only unconverted documents are selected, so it can be stopped and
 * run again. Each write requires the old value to be the one that was read; if the application changed it in
 * between, the write matches nothing and a later batch picks the document up again.
 */
export async function backfill(people: Collection<Person>, options: BackfillOptions): Promise<number> {
  const { batchSize, maxBatches = Number.POSITIVE_INFINITY, afterRead, checkUnchanged = true } = options;
  let converted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const docs = await people.find({ schemaVersion: { $exists: false } }, { limit: batchSize }).toArray();
    if (docs.length === 0) break;
    await afterRead?.();
    for (const doc of docs) {
      const name = doc.name ?? "";
      const result = await people.updateOne(checkUnchanged ? { _id: doc._id, name: doc.name } : { _id: doc._id }, {
        $set: { schemaVersion: 2, ...split(name) },
        $unset: { name: "" },
      });
      converted += result.modifiedCount;
    }
  }
  return converted;
}

/**
 * Once nothing old remains, refuse the old shape, including an old client that adds `name` back to a
 * converted document (a write readers would silently ignore). Deploy new writers first: after this, old
 * writers get errors.
 */
export async function requireVersionTwo(db: Db, collection: string): Promise<void> {
  await db.command({
    collMod: collection,
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["schemaVersion", "firstName", "lastName"],
        properties: {
          schemaVersion: { enum: [2] },
          firstName: { bsonType: "string" },
          lastName: { bsonType: "string" },
        },
        not: { required: ["name"] },
      },
    },
    validationLevel: "strict",
  });
}
