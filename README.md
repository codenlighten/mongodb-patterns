# mongodb-patterns: eight MongoDB studies, each demonstrated by tests

Runnable studies of how MongoDB behaves when it matters: validation, data modelling, atomic updates, transactions, job queues, indexes, pagination and schema migration. Each study is a short, commented TypeScript file using the official driver, plus tests that show the problem, show the fix, and fail if the fix is removed.

It shows database engineering as evidence: not "add an index" but "with this index the server had to read this many keys and documents".

## Run it

Needs Node 22 and Docker.

```bash
npm ci
docker compose up -d --wait      # a single-node MongoDB 7 replica set on 127.0.0.1:27027
npm test                         # 74 tests, a few seconds
docker compose down -v
```

Set `TEST_MONGO_URL` to use another server (it must be a replica set, because transactions need one; every test makes and drops its own database). The local container has no authentication and listens only on 127.0.0.1; do not expose it. If port 27027 is taken, set `MONGO_PORT` and `TEST_MONGO_URL` to match.

## The studies

| # | Study | What the tests demonstrate |
|---|---|---|
| 1 | [Validation](src/validation.ts) | A JSON Schema validator refuses bad documents on insert and update. A partial unique index allows one active account per address and any number of deleted ones. A plain unique index treats two missing values as duplicates. `strict` blocks unrelated edits to old invalid documents; `moderate` allows them. |
| 2 | [Modelling](src/modelling.ts) | Appending to an embedded array fails for good once the document reaches 16 MiB. With the bucket pattern, 500 concurrent writes lose nothing and no bucket exceeds its cap on the number of readings. |
| 3 | [Atomic updates](src/atomic.ts) | Read-then-write loses an update when two writers read first; `$inc` keeps all 200. A version check makes the loser retry on the new value. A conditional decrement sells exactly 10 items to 100 buyers. |
| 4 | [Transactions](src/transactions.ts) | A refused debit undoes the credit, and a transfer to the same account is refused. A second writer of the same document is aborted at once with a retryable error. An operation that forgets the session survives an abort. Two doctors can both go off call (write skew) unless both transactions also write a shared document; if that document is missing, the guarded version fails instead of proceeding unguarded. |
| 5 | [Job queue](src/queue.ts) | Eight workers claim 200 jobs, each once. Expired leases are handed over, and a stale worker cannot complete a job it lost. Read-then-write hands one job to two workers. With 5,000 finished jobs, a query with the claim's filter and sort reads at most two documents; with 1,000 unexpired running jobs it reads all of them (measured on that query, not on the find-and-update itself). |
| 6 | [Indexes](tests/06_indexes.test.ts) | Equality, sort, range, comparing two indexes by forcing each with `hint` (not what the planner picks by itself): with the range before the sort the server sorts in memory; with the sort first it reads only the ten documents it returns. A covered query reads no documents until `_id` is left in the projection. A collation index serves only queries that ask for the same collation. A partial index is not used when it could miss rows. |
| 7 | [Pagination](src/pagination.ts) | `skip` repeats rows when new ones arrive and examines every skipped key. With newer rows being inserted and existing sort keys unchanged, keyset pages return each original row once; a deep page examines about a page of keys; equal timestamps need a tie-breaker. Deleting or re-dating unread rows would still change what you see. |
| 8 | [Migration](src/migration.ts) | A batched backfill can be interrupted and resumed while readers accept both shapes, keeps a change made while a batch was in flight (an unconditional write reverts it), and finally tightens the validator so that old clients get errors instead of writing a field nobody reads. New writers must be deployed before that step. |

## Counts, not timings

The index and pagination studies assert **how many keys and documents the server examined**, taken from `explain("executionStats")`. For a given server version, data and index these counts do not depend on how fast the machine is, so they can be tested in CI. **No timing or throughput figures are claimed.**

## Test results

74 tests pass, with `tsc --noEmit` and ESLint (type-aware rules) clean. Checked on 2026-11-25 with MongoDB 7.0.45 in Docker, Node 22.23.2 and the `mongodb` driver 7.9.1 on an AMD Ryzen 7 260 running Linux: a clean `npm ci` and `docker compose up`, then ten runs in a row with all 74 passing (2.1 to 2.9 s each).

Races are forced rather than hoped for: tests that show a lost update, a double claim or write skew use a small barrier so both parties have read before either writes.

## What running it found

- **The database crashed after a few runs.** MongoDB aborted with `Too many open files`. Each test creates and drops a database, the server keeps a file per collection and index, and Docker's default limit in this image was 1024. `docker-compose.yml` now raises it to 64,000; with that the server stayed up through 44 consecutive runs, ending with about 4,800 descriptors open.
- **A type declaration broke the driver's typing.** Interfaces that extended the driver's `Document` made `$push` fail to type-check; plain interfaces fix it.
- **My first expected error message was wrong.** The 16 MiB limit reports "Resulting document after update is larger than 16777216"; the test now asserts that text.
- **Two guarantees had no test** until deliberate breaks showed it (see below).
- **An independent review found three real bugs** that 64 passing tests had missed.

## Independent review

An independent AI review (a different model, asked for factual errors, overclaims and bugs with a concrete failing scenario) found seven problems. All were valid; each fix has a test and, for the code changes, a matching deliberate break.

| Finding | Fix |
|---|---|
| Transferring to the same account passed the funds check using the money just credited, so an empty account could "pay" itself | Refused before any write |
| If the guard document was missing, the write-skew guard matched nothing and silently did nothing | The transaction requires the guard write to match |
| After the final migration step an old client could still set the legacy `name` field, a write readers ignore; name fields were not type-checked | The final validator forbids `name` and requires strings |
| A bucket cap of 0 or less created a new over-full bucket on every write | The cap must be a positive integer; the comment says it bounds readings, not bytes |
| The queue claim was described as cheap after measuring one favourable case | A test shows the unfavourable one: every unexpired running job is read |
| Index comparisons forced with `hint` were described as the planner's choice | Reworded |
| "Keyset pages return each row once" had no condition | Stated: rows inserted newer, existing sort keys unchanged |

## Deliberate breaks

34 changes were made one at a time to the source, the whole suite run and the file restored (the restored tree passes). The runner checks that the database is healthy before and after each run, so a dead server cannot count as a caught bug. **All 34 are caught.** An earlier round, before the review, had two survivors:

| Survivor | Why | Fix |
|---|---|---|
| `complete` ignores the job's status | Nothing tested a job an operator had put back in the queue | New test |
| The backfill defaults to unconditional writes | Every test passed the safety option explicitly, so the default was never exercised | The safe-path test now relies on the default |

The breaks:

- **Validation:** email shape unchecked; email not required; the email index not partial; the handle index not partial.
- **Modelling and atomics:** bucket condition removed; cap off by one; cap unchecked; `$inc` replaced by read-then-write; version check removed; stock condition removed; quantity validation removed.
- **Transactions:** a write outside the transaction; overdraft allowed; self-transfer allowed; the write-skew guard ignored; a missing guard document ignored.
- **Queue:** newest claimed first; expired leases never reclaimed; lease comparison inverted; completion not fenced by attempt; completion ignoring status; index missing.
- **Pagination:** no tie-breaker; cursor row included.
- **Migration:** unconditional backfill (two ways); batch limit ignored; names split at the first space; the new shape not read; the old shape still accepted afterwards; the legacy field still writable; either name field unchecked.
- **The test tooling itself:** the plan reader ignoring child stages.

## Limits

- A single-node replica set. Nothing here tests failover, elections, replication lag, read preferences, write concern behaviour or sharding.
- One server version (MongoDB 7). Query plans, and so the examined counts, can differ in other versions.
- The concurrent tests exercise real interleavings, but only some are forced with a barrier; the others are not deterministic by construction. A different machine could surface a different interleaving.
- The bucket pattern bounds bucket size, not bucket count: concurrent upserts may open more buckets than the minimum.
- The queue is at-least-once: a worker that stalls past its lease can still do the work twice. Fencing only stops it from recording completion.
- Without authentication or TLS: this is a local study environment, not a deployment guide.

## Layout

```
src/      one commented file per study, plus db.ts (throwaway databases) and explain.ts (plan reader)
tests/    tests/0N_*.test.ts matches the study; 06_indexes is the index study itself
```

## Dependencies

The official `mongodb` driver at run time; TypeScript, Vitest and ESLint for development. All are public packages; none of their code is copied here.

## Licence

MIT. See `LICENSE`.
