# fastify-poc

A small API for managing leads and exporting them, built around one idea: an export should be a job that lives in the database, not in the memory of a request. Stop the server halfway through and the export is meant to pick up where it left off, and every user is meant to see only their own data.

It is a proof of concept, built step by step on Fastify so that each piece is understood before the next one is added. This README describes what exists today. What is still to come is listed at the end.

## Status

A server that starts from a configuration read from its environment, connects to MongoDB, leads that belong to whoever created them, exports that run as background jobs and produce a file, a `GET /health` that reports whether the database answers, and the tests that cover all of it.

The job pattern is complete end to end: `POST /exports` answers `202` without doing the work, a worker claims the job and writes an NDJSON file while recording its progress, and `GET /exports/:id` answers that progress with a `Retry-After` telling the caller when to come back. A job left `pending` by a stopped process is picked up when the next one starts, and no recovery pass had to be written for it — the claim _is_ the recovery.

**Three things are deliberately missing**, and each is named where it belongs below rather than only here:

- **nothing serves the file.** The job says `done` and the export sits in `EXPORT_DIR`; there is no route to download it. See _Exporting_;
- **a job left `running` stays `running` for ever.** A polite stop is handled, and it is wired to `SIGINT` and `SIGTERM` so it happens outside the tests too. What is not handled is a worker killed outright — a second Ctrl-C, a `SIGKILL`, an OOM — or one that failed and could not even record the failure. Resuming a `pending` job is solved; reclaiming one that was already claimed needs a lease, and that is in _What comes next_;
- **a failure is final.** There is no retry and no dead-letter.

`GET /leads` returns an owner's leads all at once: no limit, no pagination. And **there is no authentication**: a caller states who they are in a header and is believed. That too is a deliberate boundary rather than an oversight — see _Who is asking_.

## Stack

- Fastify 5.12
- TypeBox 1.4 — schemas written in TypeScript, types derived from them
- TypeScript 7
- Node 24 — `.nvmrc` pins `lts/krypton`
- MongoDB — through `@fastify/mongodb`; a local server is needed to run it and to run the tests

## Running it

```bash
nvm use
npm install
cp .env.example .env # MONGO_URL has no default
npm run dev          # reloads on save, straight from the sources
```

By default it listens on `127.0.0.1:8081`.

```bash
curl 127.0.0.1:8081/health
# {"status":"ok","service":"fastify-poc","database":"up"}

curl -X POST 127.0.0.1:8081/leads \
  -H 'content-type: application/json' -H 'x-owner-id: unicorn' \
  -d '{"email":"unicorn@rainbow.com","firstName":"Unicorn"}'
# {"id":"6adf…","email":"unicorn@rainbow.com","firstName":"Unicorn"}

curl 127.0.0.1:8081/leads -H 'x-owner-id: unicorn'
# [{"id":"6adf…","email":"unicorn@rainbow.com","firstName":"Unicorn"}]

curl 127.0.0.1:8081/leads -H 'x-owner-id: rainbow'
# []  — another owner, another set of leads

curl 127.0.0.1:8081/leads
# {"statusCode":401,"error":"Unauthorized","message":"x-owner-id is required"}

curl -X POST 127.0.0.1:8081/exports -H 'x-owner-id: unicorn' -i
# HTTP/1.1 202 Accepted
# location: /exports/6b01…
# {"id":"6b01…","kind":"leadsExport","progress":{"processed":0,"total":1},
#  "status":"pending","createdAt":"2026-11-08T10:00:00.000Z"}

curl 127.0.0.1:8081/exports/6b01… -H 'x-owner-id: unicorn' -i
# HTTP/1.1 200 OK
# retry-after: 1        — the server says when to come back, so the client
# {"status":"pending", …}  does not have to guess an interval

curl 127.0.0.1:8081/exports/6b01… -H 'x-owner-id: unicorn' -i
# HTTP/1.1 200 OK       — no retry-after: there is nothing left to wait for
# {"status":"done","progress":{"processed":1,"total":1},
#  "startedAt":"2026-11-08T10:00:00.344Z","finishedAt":"2026-11-08T10:00:00.351Z", …}

cat exports/6b01….ndjson
# {"email":"unicorn@rainbow.com","firstName":"Unicorn","id":"6adf…"}

curl 127.0.0.1:8081/exports/6b01… -H 'x-owner-id: rainbow'
# {"statusCode":404,"error":"Not Found","message":"No such export"}

curl 127.0.0.1:8081/exports/nope -H 'x-owner-id: unicorn'
# {"statusCode":400,"code":"FST_ERR_VALIDATION", …}
```

There is no route that serves that file: reading it means looking in `EXPORT_DIR`. See _Exporting_.

`/health` needs no header. It is not an exception written anywhere: see _Who is asking_.

Every setting has a default except `MONGO_URL`. To change one, edit your `.env` (copied from `.env.example`); `npm run dev` reloads when the file changes. Without a `.env`, it prints `.env not found. Continuing without it.` (twice, once per process under `--watch`). That is only harmless if `MONGO_URL` is set in the real environment; otherwise the server stops with `MONGO_URL is required`.

To run what would actually ship:

```bash
npm run build
MONGO_URL=mongodb://127.0.0.1:27017/fastify-poc npm start
```

`npm start` reads no `.env`, so every setting it needs comes from the environment.

`npm test` runs the tests. No server needs to be running, but a MongoDB must be reachable on `127.0.0.1:27017`. The tests use one database, `fastify-poc-test`, never the application's own, and `test/database.ts` **drops it when the file that asked for it is done**: a local MongoDB is shared with whatever else its owner works on, so the tests leave nothing behind.

Test files run one at a time, through `--test-concurrency=1`. Two of them empty the same collection, and running them side by side would make one database unsafe — not reproducibly so, since the parallel suite passes, but by construction. One database costs about 400 ms a run; a database per test file costs one database per test file, for ever.

Only files named `*.test.ts` are run, so `test/database.ts` is not mistaken for a test.

`npm test` does not check types: Node only strips the annotations. `npm run typecheck` does, for the application and for the tests. `npm run format` applies Prettier and `npm run format:check` only reports; the choices behind it are below.

## Layout

```
src/
  server.ts                reads the configuration, creates the instance and listens
  config.ts                turns the environment into typed, validated settings
  app.ts                   composes the application, and nothing else
  plugins/
    mongo.ts               opens the MongoDB connection, closes it on shutdown
    identity.ts            the only file that knows how a caller is identified
    worker.ts              the loop that claims a job and writes its export
  repositories/
    leads.ts               reads and writes leads; where ObjectId stops
    jobs.ts                reads and writes jobs, of whatever kind
  routes/
    health/index.ts        GET /health, and the database's state
    leads/index.ts         POST /leads and GET /leads
    exports/index.ts       POST /exports and GET /exports/:id
  schemas/
    health.ts              the response schema and the type derived from it
    lead.ts                what a client may send, and what is answered
    job.ts                 one shape per job status, and their union
    error.ts               the three fields every error answer carries
  utils/
    validators.ts          what a valid host and a valid port are
    mongo.ts               turns a stored document into the API's, and guards the database
    retry.ts               how long a polling client is told to wait
    string.ts, array.ts    small helpers
    types.ts               Prettify, Override and DistributiveOmit
    error.ts               prints an error's message rather than its stack
test/
  config.test.ts           loadConfig, fed made-up environments
  health.test.ts           GET /health, played through inject()
  leads.test.ts            creating and listing, played through inject()
  leads.repository.test.ts the leads repository alone, with no HTTP involved
  exports.test.ts          creating and reading a job, played through inject()
  jobs.repository.test.ts  the jobs repository alone, with no HTTP involved
  worker.test.ts           a job polled until it is done, and the file it produced
  mongo.test.ts            mongoToApi, with no database involved
  retry.test.ts            retryAfterSeconds, with no clock involved
  database.ts              the test database, dropped when the file ends
  tsconfig.json            what `npm run typecheck`, and the editor, use to check the tests
.env.example               the settings that exist, with their defaults
.prettierrc                the formatting every file here is written in
```

## How it is put together

`server.ts` creates the Fastify instance and listens. `app.ts` only composes the application: its settings arrive as the options of `register()`, typed by `AppOptions`, and it hands them down to the routes it registers.

So `app.ts` does not know who built it. The server gives it the settings it needs, and each test gives it its own.

### The database

`plugins/mongo.ts` is wrapped in `fastify-plugin`, so that `fastify.mongo` is visible to the routes registered after it and not only inside the plugin. `app.ts` registers it before them. The connection is opened before the server listens, so a database that cannot be reached stops the start-up (after 2 s rather than the plugin's default 7.5 s) rather than the first request. `@fastify/mongodb` closes it when the application closes.

`GET /health` pings the database. When it answers, the response is `200` with `database: "up"`. When it does not, it is `503` with `status: "degraded"` and `database: "down"`: the process is alive, but it cannot do its job.

### Leads

Two shapes instead of one, because what a client may send is not what the API answers. `NewLead` describes the body: an email in the shape of one, and an optional first name. `Lead` describes the answer, and `Leads` is an array of them, for the list. A client that sends its own `id` does not get to choose it.

`repositories/leads.ts` is where the database stops. It takes `NewLead` objects and hands back `Lead` objects, and nothing above it ever holds an `ObjectId`. `routes/leads` only knows the `LeadsRepository` interface, so it never names a collection, an `_id` or a driver. It reaches the driver through `@fastify/mongodb`, which re-exports it, so nothing imports a package the `package.json` does not declare.

The conversion itself lives in `utils/mongo.ts`, in one generic function. `mongoToApi` turns a stored document into the shape the API answers, whatever the entity: Mongo's `_id` becomes the API's `id`, and every `Date` and `ObjectId` underneath becomes a string. It is named for what it answers rather than for one of the things it does.

Five types go with it, all constrained by `Doc` — the driver's own `Document`. `MongoModel<T>` for what is stored, `MongoDoc<T>` for what the driver hands back, `MongoToApiDoc<T>` for what leaves, `ApiToMongoDoc<T>` for the way back — the API's own shape as the database holds it, with `id` replaced by `_id` — and `MongoJSON<T>`, which the others are built on: what a stored value is once JSON has carried it. `MongoModel<LeadType>` is derived from the response schema, so the fields of a lead are declared once and in one place.

`MongoJSON<T>` decides by the value's type and never by a field name. JSON holds neither a `Date` nor an `ObjectId`, so the conversion out is unconditional — which is what makes that direction free: a dated field added tomorrow is converted with nothing declared for it. It recurses, because a date two levels down is still a date, and it stops at anything carrying a `_bsontype`, the getter every BSON class has, so a `Binary`, a `Decimal128` or a `Long` comes out as itself — exactly what the code does with it. The one type assertion in `src/` is in that function: TypeScript cannot prove that an object rebuilt key by key matches a mapped type, because mapped types serve inference and not construction.

The way in cannot be derived, since nothing in a `string` says which one is a date. It is named where the entity that has it is declared, through `Override<T, U>` in `utils/types.ts`: `repositories/jobs.ts` holds the one line it costs, `Override<MongoModel<JobType>, StoredDates>`, where `StoredDates` names `createdAt`, `startedAt` and `finishedAt`. Forgetting one is a compile error rather than a silent loss — the model would promise a string where the code writes a `Date`.

`Override` **replaces the fields `U` names and adds none**, and that is the whole difference with the intersection it used to be. A union is what makes it matter: a job is one shape per status and only some of them have a `startedAt`, so `Omit<T, keyof U> & U` handed one to every branch, pending included. Written as a mapped type over `keyof T` it is also homomorphic, so it distributes over the union and carries the optional and readonly modifiers by itself, and needs neither `DistributiveOmit` nor `Prettify` around it. The bug it replaced was found by writing the worker, not by reading the type: the three statuses that differ had to exist first.

`ApiToMongoDoc<T>` is what `list` asserts on its `find()`, which keeps the projected document derived from the response schema: `LeadType` holds no owner, so neither does the type of what the query is expected to return. Naming instead what to remove from the stored model says the same thing today and drifts apart from it the day a second private field appears. It is an assertion and nothing more — `find<T>()` tells the driver what to expect and verifies none of it — so the projection and the type have to be kept saying the same thing.

Every `Omit` in those types goes through `DistributiveOmit`, in `utils/types.ts`. `Omit<A | B, K>` keeps only the keys `A` and `B` share, so a field belonging to one branch of a union disappears without a word — and a job is a union of one shape per status. A conditional type whose checked side is a bare type parameter distributes over the union instead, which is the whole of what it adds. `Prettify` sits beside it and only changes what an editor prints: the shape a type comes out as rather than the chain it was written as. For the compiler both are identities, and nothing of either reaches runtime.

`GET /leads` still reads an owner's leads in one go, with no limit and no cursor. The reason to defer it has run out — the owner filter it was waiting for is here — so it is now plainly a missing feature rather than a deliberate order of work, and it is in _What comes next_.

`stream(ownerId)` sits beside `list(ownerId)` for the worker: the same query and the same shapes, without the `toArray()` that makes it unusable past a certain size. A cursor holds one batch whether the owner has ten leads or five million. `list` stays for the route, which answers a JSON array and so has to hold the whole of it anyway, and the two are asserted to agree. It is declared as `AsyncIterable<LeadType>` rather than as the generator it happens to be: a caller only walks it, and an array would be as valid an answer as a cursor.

A repository for a single entity and two routes was more structure than they needed on their own, and it was built early on purpose. The worker is the second caller it was for: it creates nothing, but it reads leads and writes jobs with no HTTP request in sight, and it took no change to the seam to do it.

The conversion is placed there rather than in a response hook on purpose. An `ObjectId` would serialize to its hexadecimal string by itself, since the driver gives it a `toJSON`, so a hook renaming `_id` for every route would work — but it would convert at the exit of the HTTP layer, leaving every service, log and the worker in between holding driver objects. Converting at the exit of the data layer means the rest of the application never learns which database is underneath. It is also the shape the Mongoose world reaches for with its `toJSON` transforms, except that an ODM owns the typing too.

`routes/leads` builds its repository from `fastify.mongo.db`, through `requireDb` in `utils/mongo.ts`. `@fastify/mongodb` only fills `db` when `MONGO_URL` names a database, so its type is `Db | undefined`, and `requireDb` is what turns that into a failed start-up rather than a silent mistake: `client.db()`, the version that needs no check, answers a database named `test` instead. It also keeps the repository's own parameter non-optional, so the compiler refuses a call that skips the check.

It is a second check because `config.ts` only covers one path: `config.ts` reads the environment, which is how `server.ts` starts, while `app.ts` is a plugin whose `mongoUrl` arrives in the options of `register()`. `loadConfig` never runs on that path, and every test takes it.

A body that breaks the schema is answered with a `400` before the handler runs, so nothing reaches the database:

```bash
curl -X POST 127.0.0.1:8081/leads -H 'content-type: application/json' -d '{"email":"nope"}'
# {"statusCode":400,"code":"FST_ERR_VALIDATION","message":"body/email must match format \"email\""}
```

A field the schema does not declare is a different matter: it is **dropped, not refused**. Fastify runs ajv with `removeAdditional`, so `additionalProperties: false` strips it on the way in, just as a response schema strips what it does not declare on the way out. Validation refuses what is wrong; it stays silent about what is merely unknown.

### Who is asking

`plugins/identity.ts` reads an `x-owner-id` header in an `onRequest` hook and stores it on the request. Nothing downstream ever sees a header: the routes call `getOwner(request)`, and the repository takes the owner as its first argument.

**This is not authentication.** The caller states who they are and is believed; anyone can claim to be anyone. It is here to make the rest real — a lead belongs to someone, and the export worker has to respect that — without spending a step on a solved problem. Replacing it with signed tokens is a rewrite of that one hook, and of the test helper that builds the headers. That is the whole point of putting it in a file of its own.

The hook is registered inside the leads scope, not in `app.ts`, so `/health` answers without a header. There is no exception list and no route excluded by name: Fastify's encapsulation stops the hook at the boundary of the plugin that registered it. A health check that had to authenticate would be a broken health check.

That encapsulation cuts both ways, and it is worth knowing which way. `register()` opens a _child_ scope, so a hook added by a plugin registered that way guards the child and not the routes beside it — the hook silently never runs. `fastify-plugin` lifts it one level, into the scope that registered it, which is the leads plugin here. One level up is enough to guard the routes and not so far as to reach `/health`.

The decoration is stored and read with Fastify's `setDecorator` and `getDecorator`, and **nothing declares it on Fastify's global interfaces**. A `declare module "fastify"` would tell every file in the project that `request.ownerId` is a string — including the files outside this plugin's scope, where the decoration does not exist at all. The type would be lying, and the lie has a cost: a query built on that `undefined` becomes `{ ownerId: null }` in MongoDB and answers with the documents that have no owner, silently. Reading it out of scope instead raises `FST_ERR_DEC_UNDECLARED`, which is Fastify's own check, not one written here. The same two ways of typing a decoration are compared side by side in [fastify-training](https://github.com/Dindonneau/labs-fastify-training).

The owner is stored but never answered back: `list` projects it away, because the caller already knows who they are. Every query filters on `ownerId`, so the repository creates that index when it is built — which is why building it is asynchronous. `_id` is the only index MongoDB creates by itself.

### Exporting

`POST /exports` creates a job document and answers `202` with it, and a `Location` header pointing at where its progress is readable. A worker claims the job, writes the export, and records how far it has got. `GET /exports/:id` reads that back.

`202` and not `201`, because the answer promises a job rather than a result. The `Location` header is the only other promise it makes.

**Why a job at all**, since reading 500 000 leads from a local MongoDB and writing them to a file takes 1.6 seconds, measured — 3.2 µs a lead, linear? Because reading MongoDB is not what makes an export slow. What does is everything this machine does not have: a database at the other end of a network, where a cursor pays a round trip a batch; a destination that is an upload rather than a local file; and above all work per lead — one enrichment call of 50 ms against 500 000 leads is seven hours. The pattern is not earned by volume. It is earned by not knowing, when the request arrives, which caller is the one with five million leads.

The route is `/exports` because that is what a client asks for; the collection is `jobs` because that is what the worker drains. One kind of job exists, `leadsExport`, declared as a union of a single literal — which is not a mistake, it is what makes a second kind a compiler error everywhere it is not handled yet. The kind is part of every query, so a job of another kind cannot be reached through this route.

A job is **one of four shapes told apart by its status**, not one shape with a status in it. They carry the same fields today and they will not: a running job has a `startedAt`, a finished one a `finishedAt`, a failed one says why. Declared this way, each of those belongs to the status that has it, the compiler refuses to read it from a status that does not, and the response schema refuses to answer a job that is missing one. It is also what lets `create` say it returns a **pending** job rather than a job of any status, and `POST /exports` declare that narrower branch as its response.

`GET /exports/:id` answers **404 and not 403** for a job that belongs to someone else. A `403` would confirm that it exists. The route cannot answer one even by accident: `findById` hands back the same `null` for a job that is absent, one that is another owner's, and one of another kind.

The `:id` is declared as 24 hexadecimal characters, so a malformed one is a `400` before the handler runs. Without that, `new ObjectId()` throws a `BSONError` and the caller gets a `500` for what is their own mistake. The repository checks it again with `ObjectId.isValid`, because the worker calls it with no schema in front of it.

`POST /exports` is the one route with no body schema, although everything else here declares one. A declared `Type.Object({})` answers `400 "body must be object"` to a POST sent **without** a body, which is how this route is called. The consequence is accepted and worth stating: a body sent anyway is not stripped, it is simply never read.

The `total` is counted when the job is created, through `leads.count(ownerId)` — a `countDocuments` that goes through the owner index and loads nothing, where `list(ownerId).length` would read every lead to reach the same number. It is a snapshot: a lead created afterwards is not part of this export, and a test says so, because that is a decision rather than an accident. The consequence is that the `processed` a job ends on is what the cursor actually produced and not necessarily the `total` it was created with, so a progress bar can read slightly over 100%.

Both repository factories are asynchronous, because building one may have to touch the database: each creates the index its own queries earn. For leads that is `{ ownerId }`; for jobs it is `{ status, createdAt }`, which the claim below filters and sorts on. Reading a job by its id still rides the `_id` index MongoDB creates by itself.

#### Claiming a job

The worker's first problem is not doing the work, it is making sure the work is done once. `claimNext` is a single `findOneAndUpdate`:

```ts
const document = await collection.findOneAndUpdate(
  { status: "pending", kind },
  { $set: { status: "running", startedAt: new Date() } },
  { sort: { createdAt: 1 }, returnDocument: "after" }
)
```

A `findOne` followed by an `updateOne` would read the same pending job twice and export it twice. That is not theoretical: asked to claim one job from two places at once, fifty times over, find-then-update handed back the same job in **50 runs out of 50**, and `findOneAndUpdate` in **0 out of 50**. MongoDB guarantees atomicity on a single document, which is all a queue needs. The oldest goes first, which is the sort that index serves.

This matters the moment there are two instances — which is permanent, because that is how a deployment happens without a gap. A test claims from two places at once and asserts the two ids differ.

`returnDocument: "after"` hands back what the `$set` just wrote, so the job comes out `running` with the `startedAt` it was given, in the same operation. The line that follows it in the repository, `if (document.status !== "running")`, is **a narrowing and not a guard**: the collection is typed as the union of the four shapes, and this is how the compiler learns which one it is holding. It is a branch no test can reach, which is the price of not reaching for an assertion instead.

It throws rather than answering `null`, and that is not a detail. `null` is already taken one line above, where it means _nothing was pending_ — and that is what the worker reads as the signal to stop draining and wait for its next tick. Answering it here too would make the one case where a job has been set to `running` with no one on it indistinguishable from the case where everything is quiet, which is the shape of a bug nobody ever sees. The throw lands in the loop's `catch`, where it is logged and the loop rearms. An impossible state is worth a line in the log; it is not worth borrowing the vocabulary of the ordinary answer.

`claimNext` hands back `{ job, ownerId }`. It is the one place the owner leaves the data layer, because the worker has to know whose leads to export and, unlike a request, it is acting for no one. It is a pair rather than an owner folded into the job, so that the exception is visible where it is used instead of travelling inside a document shape.

#### The worker

`plugins/worker.ts` is a plugin, and the loop is **armed by `onReady` and stopped by `onClose`**. `onReady` and not the body of the plugin: the body runs while the application is still being built, and a job claimed then would run against a half-registered server. It is also what makes a job left `pending` by a previous process get picked up on boot, with no recovery pass written for it.

It is `setTimeout` rearmed by the tick it fires, never `setInterval`: a tick that outlasts its interval must not have the next one start beside it. And it **drains** rather than taking one job per tick — the interval says how long to wait when there was nothing to claim, and is not a rate limit on work.

`onClose` sets the flag, then **waits for the job in flight**, then clears the timer. In that order, so a tick about to finish cannot rearm behind the `clearTimeout`. A large export therefore holds the shutdown for as long as it needs to finish, which is what a deployment's grace period is for: a file half written by a worker that was told to stop is the same lie as one left behind by a crash.

None of that happens on its own, and this is the part that is easy to get wrong: **Fastify installs no signal handler, and neither does Node.** Without the `process.once("SIGINT" | "SIGTERM")` in `server.ts`, Ctrl-C, a `node --watch` restart and a `docker stop` all kill the process outright, and the whole sequence above would only ever run in tests. Measured on a 400 000-lead export, with `SIGTERM` sent once 7 000 lines were written:

|          | without the handler              | with it                |
| -------- | -------------------------------- | ---------------------- |
| exit     | killed by the signal, after 9 ms | code 0, after 1 270 ms |
| the job  | `running`, for ever              | `done`                 |
| the file | 8 000 lines of 400 000           | 400 000                |

`once` and not `on`, so a second signal gets Node's default behaviour back. That is the way out when a large export is holding the shutdown, and it is what a deployment does when its grace period runs out. The process is not stopped by hand either: the poll timer is `unref`'d and `close()` shuts the connection and the socket, so the event loop empties by itself.

That hook is worth a test rather than an assumption. `register()` opens a child scope, and a hook added in one guards that scope and not the server — a loop that outlived its server would keep claiming jobs through a connection being closed underneath it. The test closes the server, writes a pending job straight into the collection, waits ten times the poll interval and asserts it is still `pending`.

The worker is an option of `AppOptions` rather than always present. Left out, the application is an API and nothing runs what it accepts — which is not a degraded mode but the deployment where workers are their own containers, scaled on how much work there is instead of on how much traffic. `server.ts` passes it; most of the test suite does not, because most of it wants a job to stay `pending`.

#### Writing the export

NDJSON, one JSON object a line, and not a single JSON array: a reader takes one line at a time, and a file still being written is still parseable up to its last complete line. An array would have to be closed to be valid at all. Each line is a lead exactly as the API answers it — an `id`, no `ownerId`, no `_id` — because it goes through the same `mongoToApi` as a response does.

It is written through `stream/promises`' `pipeline`, fed by an async generator, and not by a loop of `file.write()`. `write()` answers `false` when the buffer is full, and a loop that ignores it holds the whole export in memory — which is the one thing walking a cursor was for. `pipeline` waits for the drain and closes the file on the way out either way.

Progress is written every `progressEvery` leads, a thousand by default, and once more at the end for the last partial batch. The default is measured rather than guessed: on 50 000 leads, one write per thousand took **0.20 s** and one write per lead took **3.02 s**, so the progress would have cost fifteen times the export it reports on. The batched run still showed a polling client five intermediate values, which is five more than a progress bar needs.

A failure is caught, logged with the error the driver threw, and recorded on the job as `failed` with the worker's own message — nothing a driver said reaches a client, because it names hosts and paths. The partial file is removed: nothing in it says it is incomplete, so a client downloading it would read a truncated export as a whole one.

**Nothing serves that file.** The job says `done` and the export is in `EXPORT_DIR` under the job's id. A `GET /exports/:id/file` is the obvious next route and it is not written, which is a gap rather than a decision. In a deployment with more than one machine it would not be a route at all: the file would go to object storage and the job would answer a signed URL, because a local file is only readable from the instance that wrote it.

#### Telling a client when to come back

`GET /exports/:id` answers a `Retry-After` while the job can still change, and no header at all once it cannot. Polling is what this pattern leaves a client with, and the point of the header is that **the interval stops being the client's guess**: the server knows the rate and how much is left, the client knows neither.

`utils/retry.ts` extrapolates from the progress and the time since `startedAt`, with a floor of one second and a ceiling of thirty. The ceiling is the real decision — it is the longest a caller is ever told to stay blind, so an estimate of four minutes still answers thirty seconds. A pending job, or a running one that has written nothing, is answered the floor: there is no rate to read yet. It is a hint and not an order, and a client wanting a bar that moves faster may poll faster.

It takes the time as an argument instead of reading a clock, which is why its tests assert exact numbers rather than ranges. Headers are not declared in the response schema: Fastify validates and serialises the body, and a header it does not know about goes out untouched.

Polling is cheap enough that the alternatives are not an optimisation here. One `GET /exports/:id` costs **94.5 µs** of server time, so one process answering nothing else serves about **10 500 a second** — ten thousand clients polling every two seconds would be 47% of it. Server-sent events would not remove that polling so much as move it: the worker runs in another process than the one holding the connection, so the pushing instance learns nothing unless a change stream or a Redis channel tells it, and this project's MongoDB is a standalone, where `$changeStream` is refused outright. Polling also keeps the state where it belongs — a reload, a closed tab, a dropped connection and a redeploy all leave `GET /exports/:id` answering, where a held connection loses the thread and has to rebuild it. A WebSocket would buy bidirectionality that nothing here needs.

The honest heuristic is the event rate, not the transport's modernity: three state transitions and a number that climbs is polling; a stream of log lines is SSE; a chat is a WebSocket.

### Configuration

`config.ts` reads the settings once, at startup. An environment only holds strings, or nothing at all when a variable is absent, so this is where each value gets its real type (`PORT` becomes a number) and where a bad one is refused. A start with `PORT=abc` stops with exit code 1 and a message that lists every problem at once, rather than a stack trace. A value that is well formed but cannot be used, such as an address that is not on this machine, still fails later, at `listen`.

| Variable       | Default        |                                                              |
| -------------- | -------------- | ------------------------------------------------------------ |
| `HOST`         | `127.0.0.1`    | the address to listen on                                     |
| `PORT`         | `8081`         | an integer from 1 to 65535                                   |
| `SERVICE_NAME` | `fastify-poc`  | reported by `/health`                                        |
| `MONGO_URL`    | none, required | a `mongodb://` or `mongodb+srv://` URL that names a database |
| `EXPORT_DIR`   | `exports`      | where the worker writes; created if it is missing            |

A relative `EXPORT_DIR` is resolved against the working directory, which is what makes the default readable by whoever just ran the server; a deployment points it at a mounted volume. The worker creates it rather than demanding it exist, because the worker is the only thing that writes there.

`loadConfig` takes the environment as an argument instead of reading `process.env` itself, so a test hands it a made-up one and never touches the real environment.

`npm run dev` loads `.env` with Node's own `--env-file-if-exists`, with no package involved. A variable set in the real environment wins over the file. `.env` is not committed, and `.env.example` is. `npm start` does not read a file at all: a deployed process gets its settings from the environment it runs in.

Every route declares its contract: a TypeBox schema, and the type derived from it. The generic makes the compiler reject a handler that returns the wrong type, and the schema stops any field it does not declare from reaching the client. The two describe the same shape, and neither replaces the other: a generic is erased at runtime, a schema is compiled by Fastify at startup.

The project is ESM. Relative imports carry their `.ts` extension, which `rewriteRelativeImportExtensions` rewrites to `.js` in the build. The reasoning is in the [fastify-training README](https://github.com/Dindonneau/labs-fastify-training#departures-from-the-guides).

### Formatting

Prettier owns it, through a `.prettierrc` so that an editor formats this repository the same way whatever its own settings say. `printWidth` is 80: Prettier's default, its documented recommendation, and where the TypeScript projects that use it land — NestJS, Next.js, tRPC and `create-t3-app` all sit at 80, and Angular's 100 is the exception rather than the rule.

Fastify itself uses no Prettier at all. The core and its plugins run ESLint with `neostandard`, which has no line-length rule, and their code is short regardless: `@fastify/mongodb` never reaches 75 columns. So 80 is a choice made here, not something the framework asks for.

It is a target and not a limit. Prettier describes `printWidth` as "roughly how long you'd like lines to be" and leaves a line long when it cannot break it — a string literal and a comment are never split, so a handful of test names run past 80 on purpose. Anyone expecting ESLint's `max-len` will read that as a violation; it is not one.

Nothing runs by itself: there is no hook and no CI, so the formatter, the typechecker and the tests all have to be asked for.

## What comes next

Done so far: a worker started and stopped with the server, a `pending` job resumed on boot, progress a client can read, a failure recorded on the job and a shutdown that waits for the file it was writing.

What is left, in order, each step on its own:

1. **A route that serves the export**, `GET /exports/:id/file`. The job reaches `done` and nothing hands the file over, which is the most visible gap today.
2. **A lease, so an abandoned job can be reclaimed.** Stopping the server is handled: `SIGINT` and `SIGTERM` reach `close()`, and `onClose` waits for the job in flight. Two paths are not. A worker killed outright leaves the job `running`, because the only thing that moves it is the process that is gone. And a worker whose `jobs.fail()` throws — the database being away is exactly when `run()` fails — leaves it `running` too, with its partial file already removed. Both want the same answer: a `startedAt` older than some bound becoming claimable again, plus a heartbeat so a slow job is not stolen from a worker that is still alive. A `status: "running"` filter on the three advancing methods is in place today, which stops `finish` from resurrecting a failed job but is not a lease — once a job can be reclaimed, two workers would both see `running` and it would stop neither.
3. **A retry and somewhere for what keeps failing to go.** A failure is final today.
4. **A limit and a cursor on `GET /leads`.**

Signed tokens in place of the `x-owner-id` header would be a fifth, and a small one: it is one hook and one test helper. It is left out on purpose — the two things this project exists to show are the resilient job and the per-owner scoping, and authentication is neither.

Server-sent events are **not** on this list as an improvement to the polling, and the reasoning is under _Telling a client when to come back_. Writing one would be worth doing to learn the response lifecycle it needs, which is a different reason.

## Related

[fastify-training](https://github.com/Dindonneau/labs-fastify-training) is where the Fastify concepts this project builds on were worked through: plugins and encapsulation, decorators, schemas, and the asynchronous bootstrapping of a database connection.
