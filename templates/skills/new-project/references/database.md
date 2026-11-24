# Database: fast at its size, up to 10 billion rows and more

- Applies when the project keeps data in a database: `full` at rows tier L or XL; `not needed` at rows tier 0
  (nothing is stored).
- Light form: at rows tier S or M. Everything here applies except the part "Partitioning" and the rules marked L or
  XL. The proof is the tier's own line under "Proof".

Every table has its own tier (the skill's step 2). A rule marked with a tier acts on the tables of that tier and
above. A "big table" is a table of tier M or above. A rule without a mark acts on every table. Backups, the two
database users, constraints, parameterized queries and the money rules are the same at every tier. A rule that names
big tables acts only where one exists. The pooling rule carries its own exception (one app process at traffic tier
S). The rules are written for PostgreSQL, the default; for another database the owner approved, keep their intent and
write the translation in `decisions.md`.

## Setup

1. One connection pool in the data module, from the app's database address (the app role). Migrations connect with
   their own address (the migrations role). Reads in one folder (queries), writes in another (mutations).
2. All reads go through the data module, so a read replica can be added later in that one place without touching
   queries. Reads that must see a write just made stay on the primary.
3. Two database users: the app's (data only, no schema changes) and the migrations' (schema changes).
4. Migrations are numbered SQL files (`migrations/0001_init.sql` ...), run by one command (for example
   `npm run db:migrate`) and tracked in a `schema_migrations` table. Never edit one that already ran.
5. Migrations on big tables: `lock_timeout`, batched backfills and `CREATE INDEX CONCURRENTLY`. It cannot run inside
   a transaction, so the runner supports a no-transaction marker. On a partitioned table, create the index `ON ONLY`
   the parent, build each partition's index concurrently, then attach it.
6. Time limits are set on the app role (`ALTER ROLE ... SET`) so they hold through the pooler: `statement_timeout`
   (about 5 s) and `idle_in_transaction_session_timeout`. Long jobs raise it with `SET LOCAL` inside their
   transaction. Migrations and the partition job run as the migrations role.
7. Pooling: PgBouncer in transaction mode or the host's pooler. With transaction pooling, no session state (`SET`,
   session advisory locks, `LISTEN`). One app process at traffic tier S may use the driver's own pool; it still keeps
   no session state, so a pooler can be added later without a code change.

## Small, fast tables

8. Primary keys: UUIDv7 when the id appears in addresses or the API (`uuidv7()` on PostgreSQL 18 and later, else
   made in the app). `bigint generated always as identity` for internal high-volume tables. Never a random UUIDv4 as
   a primary key.
9. The sign-in library's tables follow its documented schema, generated as SQL into the numbered migrations, so there
   is one migration system. Set its id option to match these rules where it has one.
10. The smallest correct type for every column.
11. Money as `bigint` in the smallest unit (cents, paise) with a currency code. Never floating point.
12. `timestamptz` in UTC, shown in the user's time zone. `created_at` and `updated_at` set automatically.
13. Foreign keys and constraints everywhere.
14. Hot rows stay narrow: large text or JSON in a side table, files in storage (only the key in the database). Never
    `jsonb` for a field that is filtered or joined on.
15. lz4 compression on large text and `jsonb` columns where the server supports it.

## Partitioning (tables of tier L and XL)

16. A table that can pass about 100 million rows in three years, or in ten years when it grows for ever (events,
    messages, logs, transactions, audit), is range-partitioned by time from day one: monthly, or daily when very hot.
    Its primary key includes the partition key.
17. A scheduled job makes future partitions ahead of time, and a test checks that they exist.
18. Every query on a partitioned table filters by the partition key, so only the needed partitions are read. A
    partitioned table looked up by id uses a UUIDv7 id with `created_at` set from its timestamp, so a lookup by id
    also filters on `created_at` and reads one partition.
19. A unique index on a partitioned table must include the partition key. Rules that hold across all time (a
    provider's payment id, a webhook's event id, a mail address) therefore live in a normal table. A table that
    points at a partitioned table also stores its partition key, so the foreign key covers its full primary key.

## Retention (every table)

20. The retention of each table is written in `decisions.md`. Old data leaves a partitioned table by dropping whole
    partitions (instant, no bloat), archived to storage first when needed. Never a mass `DELETE` on a big table: a
    big table without partitions loses its old rows in small batches, by a job.
21. High-volume analytics stays off the request path. A separate analytics store (for example ClickHouse) only with
    the owner's approval.

## Indexes

22. Every index comes from a real query. In a composite index: equality columns first, then the range or sort column,
    matching `ORDER BY`.
23. `INCLUDE` columns on hot list queries for index-only scans. Partial indexes for hot subsets
    (`WHERE status = 'pending'`). BRIN on the time column of huge append-only tables (tier L and XL).
24. Every foreign key column is indexed.
25. No duplicate, overlapping or unused index: each one costs write speed and disk.
26. Search: `tsvector` with GIN, or `pg_trgm`. A separate search engine only with the owner's approval.

## Queries

27. Every request-path query is index-backed, reads a bounded number of rows, names its columns (never `SELECT *`)
    and has a `LIMIT` (a page of at most 100).
28. Parameterized queries only.
29. Keyset (cursor) pagination. No `OFFSET` on big tables.
30. No exact `COUNT(*)` on big tables. Show "more", or keep counter rows.
31. Dashboards and reports on big tables read rollup tables that jobs update. Never an aggregate over a raw big table
    per request.
32. No N+1: one query with a `JOIN` or `= ANY($1)`.
33. Transactions for multi-step writes. Keep them short, and never call another service inside one.
34. Bulk writes in batches (multi-row insert, `unnest` or `COPY`). Upserts with `ON CONFLICT`.
35. No function on an indexed column in a `WHERE` unless a matching expression index exists.

## Operations

36. `pg_stat_statements` on. Queries slower than 100 ms are logged.
37. Autovacuum tuned per big table. A fill factor of about 90 on update-heavy tables.
38. Daily backups plus point-in-time recovery. A restore tried once and written in the deployment docs.
39. A health command (for example `npm run db:health`) shows the slowest queries, unused or duplicate indexes,
    foreign keys without an index, sequential scans on big tables, bloat, table and index sizes, and missing future
    partitions.

## Proof, by rows tier (10 billion rows cannot be loaded locally, so the shape is proven)

40. Rows tier S: no scale seed and no plan test. The proof is the database tests and the health command showing no
    foreign key without an index, no duplicate index and no slow query.
41. Rows tier M and above: a scale seed (for example `npm run db:seed:scale`) fills every table of tier M with 1
    million or more realistic rows and every table of tier L or XL with 10 million or more, using `generate_series`
    or `COPY`. Estimate its time first.
42. Rows tier M and above: an automated plan test runs `EXPLAIN (ANALYZE, BUFFERS)` on every request-path query at
    that scale. It fails on a sequential scan of a big table, a missing partition prune, or a query slower than 10 ms
    on a warm cache (50 ms for full-text search).
43. Rows tier XL, the ten-billion proof: a query that is index-bounded and partition-pruned stays about as fast at
    10 billion rows, because it still reads the same few pages. That plan plus the measured time is the proof, and
    the report gives both for every request-path query on an XL table. At tier L the passed plan test is the proof.
