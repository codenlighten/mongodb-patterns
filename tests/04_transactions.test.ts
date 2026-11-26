import { MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  goOffCall,
  InsufficientFunds,
  transfer,
  type Account,
  type Doctor,
  type Shift,
} from "../src/transactions.js";
import { barrier, sleep, useDb } from "./helpers.js";

const db = useDb();

async function bank() {
  const accounts = db().db.collection<Account>("accounts");
  await accounts.insertMany([
    { _id: "ann", balance: 100 },
    { _id: "bob", balance: 100 },
  ]);
  return accounts;
}
const balances = async (accounts: Awaited<ReturnType<typeof bank>>) =>
  (await accounts.find({}, { sort: { _id: 1 } }).toArray()).map((a) => a.balance);

describe("transfers", () => {
  it("moves money between two documents", async () => {
    const accounts = await bank();
    await transfer(db().client, db().db, "ann", "bob", 30);
    expect(await balances(accounts)).toEqual([70, 130]);
  });

  it("undoes the credit when the debit is refused", async () => {
    const accounts = await bank();
    await expect(transfer(db().client, db().db, "ann", "bob", 101)).rejects.toThrow(InsufficientFunds);
    expect(await balances(accounts)).toEqual([100, 100]);
  });

  it("refuses a transfer to the same account, which would pass the funds check with its own credit", async () => {
    const accounts = await bank();
    await expect(transfer(db().client, db().db, "ann", "ann", 500)).rejects.toThrow(RangeError);
    expect(await balances(accounts)).toEqual([100, 100]);
  });

  it("conserves the total across 40 concurrent opposing transfers", async () => {
    const accounts = await bank();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 ? transfer(db().client, db().db, "ann", "bob", 2) : transfer(db().client, db().db, "bob", "ann", 1),
      ),
    );
    expect(await balances(accounts)).toEqual([80, 120]);
  });
});

describe("how transactions behave", () => {
  it("aborts the second writer of a document at once instead of making it wait", async () => {
    const accounts = await bank();
    const first = db().client.startSession();
    const second = db().client.startSession();
    try {
      first.startTransaction();
      second.startTransaction();
      await accounts.updateOne({ _id: "ann" }, { $inc: { balance: 1 } }, { session: first });
      const error = await accounts
        .updateOne({ _id: "ann" }, { $inc: { balance: 1 } }, { session: second })
        .then(() => undefined)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MongoServerError);
      expect((error as MongoServerError).codeName).toBe("WriteConflict");
      expect((error as MongoServerError).hasErrorLabel("TransientTransactionError")).toBe(true);
      await first.commitTransaction();
    } finally {
      await first.endSession();
      await second.endSession();
    }
    expect(await balances(accounts)).toEqual([101, 100]);
  });

  it("hides uncommitted writes from readers outside the transaction", async () => {
    const accounts = await bank();
    await db().client.withSession(async (session) => {
      session.startTransaction();
      await accounts.updateOne({ _id: "ann" }, { $set: { balance: 0 } }, { session });
      expect((await accounts.findOne({ _id: "ann" }))?.balance).toBe(100);
      expect((await accounts.findOne({ _id: "ann" }, { session }))?.balance).toBe(0);
      await session.abortTransaction();
    });
  });

  it("shows the trap: an operation without the session is not part of the transaction", async () => {
    const accounts = await bank();
    await db().client.withSession(async (session) => {
      session.startTransaction();
      await accounts.insertOne({ _id: "inside", balance: 1 }, { session });
      await accounts.insertOne({ _id: "forgot-the-session", balance: 1 });
      await session.abortTransaction();
    });
    expect(await accounts.findOne({ _id: "inside" })).toBeNull();
    expect(await accounts.findOne({ _id: "forgot-the-session" })).not.toBeNull();
  });
});

describe("write skew", () => {
  async function rota() {
    const doctors = db().db.collection<Doctor>("doctors");
    await doctors.insertMany([
      { _id: "ann", onCall: true },
      { _id: "bob", onCall: true },
    ]);
    await db().db.collection<Shift>("shifts").insertOne({ _id: "night", version: 0 });
    return doctors;
  }

  it("both leave, because each transaction writes a different document", async () => {
    const doctors = await rota();
    const bothChecked = barrier(2);
    const left = await Promise.all(
      ["ann", "bob"].map((n) => goOffCall(db().client, db().db, n, { guard: false, afterCheck: bothChecked })),
    );
    expect(left).toEqual([true, true]);
    expect(await doctors.countDocuments({ onCall: true })).toBe(0);
  });

  it("refuses to go ahead if the guard document is missing", async () => {
    const doctors = await rota();
    await db().db.collection<Shift>("shifts").deleteMany({});
    await expect(goOffCall(db().client, db().db, "ann", { guard: true })).rejects.toThrow(/no shift document/);
    expect(await doctors.countDocuments({ onCall: true })).toBe(2);
  });

  it("one stays when both also write the shared shift document", async () => {
    const doctors = await rota();
    const left = await Promise.all(
      ["ann", "bob"].map((n) =>
        goOffCall(db().client, db().db, n, { guard: true, afterCheck: () => sleep(100) }),
      ),
    );
    expect(left.filter(Boolean)).toHaveLength(1);
    expect(await doctors.countDocuments({ onCall: true })).toBe(1);
  });
});
