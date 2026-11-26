// Study 1: the database refuses bad data, whichever code path writes it.
import type { Collection, Db, Document } from "mongodb";

export interface User {
  email: string;
  status: "active" | "deleted";
  createdAt: Date;
  handle?: string;
}

export const userValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["email", "status", "createdAt"],
    properties: {
      email: { bsonType: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
      status: { enum: ["active", "deleted"] },
      createdAt: { bsonType: "date" },
      handle: { bsonType: "string" },
    },
  },
};

export async function createUsers(db: Db, level: "strict" | "moderate" = "strict"): Promise<Collection<User>> {
  const users = await db.createCollection<User>("users", { validator: userValidator, validationLevel: level });
  // Unique among active users only: a deleted account does not hold its address forever.
  await users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { status: "active" } });
  // An optional field that must be unique when present. Without the filter, two documents that both
  // lack `handle` count as duplicates of each other.
  await users.createIndex({ handle: 1 }, { unique: true, partialFilterExpression: { handle: { $exists: true } } });
  return users;
}
