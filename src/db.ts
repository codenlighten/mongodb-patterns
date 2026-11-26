import { randomBytes } from "node:crypto";
import { MongoClient, type Db } from "mongodb";

/** `directConnection` talks to the one node without resolving the replica set's member names. */
export const MONGO_URL = process.env.TEST_MONGO_URL ?? "mongodb://127.0.0.1:27027/?directConnection=true";

export interface Throwaway {
  client: MongoClient;
  db: Db;
  drop(): Promise<void>;
}

/** A database with a random name that is dropped afterwards, so studies never see each other's data. */
export async function throwawayDb(url: string = MONGO_URL): Promise<Throwaway> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(`study_${randomBytes(6).toString("hex")}`);
  return {
    client,
    db,
    async drop() {
      try {
        await db.dropDatabase();
      } finally {
        await client.close();
      }
    },
  };
}
