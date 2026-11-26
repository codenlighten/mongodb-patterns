import { describe, expect, it } from "vitest";
import { backfill, displayName, requireVersionTwo, split, type Person } from "../src/migration.js";
import { useDb } from "./helpers.js";

const db = useDb();

async function people(names: string[]) {
  const collection = db().db.collection<Person>("people");
  await collection.insertMany(names.map((name) => ({ name })));
  return collection;
}
const shown = async (c: Awaited<ReturnType<typeof people>>) => (await c.find().toArray()).map(displayName).sort();
const names = Array.from({ length: 25 }, (_, i) => `First${String(i).padStart(2, "0")} Last`);

describe("splitting a name", () => {
  it.each([
    ["Ada Lovelace", "Ada", "Lovelace"],
    ["Ada King Lovelace", "Ada King", "Lovelace"],
    ["Plato", "Plato", ""],
    ["  Ada   Lovelace  ", "Ada", "Lovelace"],
  ])("%j", (name, firstName, lastName) => {
    expect(split(name)).toEqual({ firstName, lastName });
  });
});

describe("backfill", () => {
  it("converts everything in batches without changing what readers see", async () => {
    const c = await people(names);
    expect(await backfill(c, { batchSize: 10 })).toBe(25);
    expect(await c.countDocuments({ schemaVersion: 2, name: { $exists: false } })).toBe(25);
    expect(await shown(c)).toEqual(names);
  });

  it("can stop part way, serves both shapes, and resumes", async () => {
    const c = await people(names);
    expect(await backfill(c, { batchSize: 10, maxBatches: 1 })).toBe(10);
    expect(await shown(c)).toEqual(names);
    expect(await backfill(c, { batchSize: 10 })).toBe(15);
    expect(await backfill(c, { batchSize: 10 })).toBe(0);
  });

  async function renameDuringBackfill(options: { checkUnchanged?: boolean } = {}) {
    const c = await people(["Ada Byron", "Alan Turing"]);
    let renamed = false;
    await backfill(c, {
      batchSize: 10,
      ...options,
      afterRead: async () => {
        if (renamed) return;
        renamed = true;
        await c.updateOne({ name: "Ada Byron" }, { $set: { name: "Ada Lovelace" } });
      },
    });
    return shown(c);
  }

  it("keeps a change the application made while the batch was in flight", async () => {
    // No option given: this is the default a caller gets.
    expect(await renameDuringBackfill()).toEqual(["Ada Lovelace", "Alan Turing"]);
  });

  it("shows the trap: an unconditional write puts the old value back", async () => {
    expect(await renameDuringBackfill({ checkUnchanged: false })).toEqual(["Ada Byron", "Alan Turing"]);
  });

  it("then refuses an old client writing the old field to a converted document", async () => {
    const c = await people(["Ada Lovelace"]);
    await backfill(c, { batchSize: 10 });
    await requireVersionTwo(db().db, "people");
    await expect(c.updateOne({}, { $set: { name: "Ada Byron" } })).rejects.toMatchObject({ code: 121 });
    expect(await shown(c)).toEqual(["Ada Lovelace"]);
  });

  it.each([["firstName"], ["lastName"]])("then requires %s to be a string", async (field) => {
    const c = await people(["Ada Lovelace"]);
    await backfill(c, { batchSize: 10 });
    await requireVersionTwo(db().db, "people");
    await expect(c.updateOne({}, { $set: { [field]: 5 } })).rejects.toMatchObject({ code: 121 });
  });

  it("then refuses the old shape", async () => {
    const c = await people(names);
    await backfill(c, { batchSize: 10 });
    await requireVersionTwo(db().db, "people");
    await expect(c.insertOne({ name: "Old Client" })).rejects.toMatchObject({ code: 121 });
    await expect(c.insertOne({ schemaVersion: 2, firstName: "New", lastName: "Client" })).resolves.toBeTruthy();
  });
});
