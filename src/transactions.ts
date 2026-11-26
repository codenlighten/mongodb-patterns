// Study 4: multi-document transactions, write conflicts and write skew.
import type { Db, MongoClient } from "mongodb";

export interface Account {
  _id: string;
  balance: number;
}

export interface Doctor {
  _id: string;
  onCall: boolean;
}

export interface Shift {
  _id: string;
  version: number;
}

export class InsufficientFunds extends Error {}

/** Both balances change, or neither does. `withTransaction` retries transient conflicts. */
export async function transfer(client: MongoClient, db: Db, from: string, to: string, amount: number): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError("amount must be a positive integer");
  // Paying yourself would credit first and then pass the funds check with the money just credited.
  if (from === to) throw new RangeError("cannot transfer to the same account");
  const accounts = db.collection<Account>("accounts");
  await client.withSession((session) =>
    session.withTransaction(async () => {
      const credit = await accounts.updateOne({ _id: to }, { $inc: { balance: amount } }, { session });
      if (credit.matchedCount !== 1) throw new Error(`no account ${to}`);
      const debit = await accounts.updateOne(
        { _id: from, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { session },
      );
      if (debit.modifiedCount !== 1) throw new InsufficientFunds(`${from} cannot pay ${amount}`);
    }),
  );
}

/**
 * Rule: at least one doctor stays on call. Transactions give snapshot isolation, so two of them can each
 * see two doctors on call and each remove a different one: they write different documents and never
 * conflict. With `guard`, both also write the same shift document, which forces a conflict; the loser is
 * retried and sees the new state.
 */
export async function goOffCall(
  client: MongoClient,
  db: Db,
  name: string,
  options: { guard: boolean; afterCheck?: () => Promise<void> },
): Promise<boolean> {
  const doctors = db.collection<Doctor>("doctors");
  const shifts = db.collection<Shift>("shifts");
  let left = false;
  await client.withSession((session) =>
    session.withTransaction(async () => {
      left = false;
      if (options.guard) {
        const held = await shifts.updateOne({ _id: "night" }, { $inc: { version: 1 } }, { session });
        // Writing nothing would conflict with nobody: the guard would be silently off.
        if (held.matchedCount !== 1) throw new Error("no shift document to guard with");
      }
      const onCall = await doctors.countDocuments({ onCall: true }, { session });
      await options.afterCheck?.();
      if (onCall < 2) return;
      const result = await doctors.updateOne({ _id: name, onCall: true }, { $set: { onCall: false } }, { session });
      left = result.modifiedCount === 1;
    }),
  );
  return left;
}
