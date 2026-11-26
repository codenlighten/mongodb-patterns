import { describe, expect, it } from "vitest";
import { createUsers, userValidator, type User } from "../src/validation.js";
import { at, useDb } from "./helpers.js";

const db = useDb();
const user = (over: Partial<User> = {}): User => ({ email: "ann@example.test", status: "active", createdAt: at(0), ...over });
const DUPLICATE = { code: 11000 };
const INVALID = { code: 121 };

describe("schema validation", () => {
  it("accepts a well formed user", async () => {
    const users = await createUsers(db().db);
    await expect(users.insertOne(user())).resolves.toMatchObject({ acknowledged: true });
  });

  it.each([
    ["no email", { email: undefined }],
    ["an email without @", { email: "ann.example.test" }],
    ["a number as email", { email: 5 }],
    ["an unknown status", { status: "banned" }],
    ["a date stored as a string", { createdAt: "2026-01-01" }],
  ])("refuses %s", async (_name, bad) => {
    const users = await createUsers(db().db);
    const doc: Record<string, unknown> = { ...user(), ...bad };
    for (const key of Object.keys(doc)) if (doc[key] === undefined) delete doc[key];
    await expect(users.insertOne(doc as unknown as User)).rejects.toMatchObject(INVALID);
    expect(await users.countDocuments()).toBe(0);
  });

  it("refuses an update that would make a document invalid", async () => {
    const users = await createUsers(db().db);
    await users.insertOne(user());
    await expect(users.updateOne({}, { $set: { status: "nope" } } as object)).rejects.toMatchObject(INVALID);
  });
});

describe("partial unique indexes", () => {
  it("allows one active account per address, and any number of deleted ones", async () => {
    const users = await createUsers(db().db);
    await users.insertMany([user({ status: "deleted" }), user({ status: "deleted" }), user()]);
    await expect(users.insertOne(user())).rejects.toMatchObject(DUPLICATE);
  });

  it("refuses to reactivate a deleted account whose address is taken", async () => {
    const users = await createUsers(db().db);
    const old = await users.insertOne(user({ status: "deleted" }));
    await users.insertOne(user());
    await expect(users.updateOne({ _id: old.insertedId }, { $set: { status: "active" } })).rejects.toMatchObject(
      DUPLICATE,
    );
  });

  it("lets many users have no handle, but never share one", async () => {
    const users = await createUsers(db().db);
    await users.insertMany([user({ email: "a@x.test" }), user({ email: "b@x.test" })]);
    await users.insertOne(user({ email: "c@x.test", handle: "ann" }));
    await expect(users.insertOne(user({ email: "d@x.test", handle: "ann" }))).rejects.toMatchObject(DUPLICATE);
  });

  it("shows the trap: a plain unique index treats two missing values as equal", async () => {
    const plain = db().db.collection("plain");
    await plain.createIndex({ handle: 1 }, { unique: true });
    await plain.insertOne({ n: 1 });
    await expect(plain.insertOne({ n: 2 })).rejects.toMatchObject(DUPLICATE);
  });
});

describe("validation level, for data that predates the rules", () => {
  async function legacy(level: "strict" | "moderate") {
    const { db: database } = db();
    await database.createCollection("users");
    await database.collection("users").insertOne({ legacy: true });
    await database.command({ collMod: "users", validator: userValidator, validationLevel: level });
    return database.collection("users");
  }

  it("strict blocks even an unrelated update to an old invalid document", async () => {
    const users = await legacy("strict");
    await expect(users.updateOne({ legacy: true }, { $set: { note: "x" } })).rejects.toMatchObject(INVALID);
  });

  it("moderate leaves old invalid documents editable but still checks new ones", async () => {
    const users = await legacy("moderate");
    await expect(users.updateOne({ legacy: true }, { $set: { note: "x" } })).resolves.toMatchObject({
      modifiedCount: 1,
    });
    await expect(users.insertOne({ legacy: true })).rejects.toMatchObject(INVALID);
  });
});
