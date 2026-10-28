# fastify-poc

A small API for managing leads and exporting them, built around one idea: an export should be a job that lives in the database, not in the memory of a request. Stop the server halfway through and the export is meant to pick up where it left off, and every user is meant to see only their own data.

It is a proof of concept, built step by step on Fastify so that each piece is understood before the next one is added. This README describes what exists today. What is still to come is listed at the end.

## Status

Early. A server that starts from a configuration read from its environment, connects to MongoDB, leads that belong to whoever created them, a `GET /health` that reports whether the database answers, and the tests that cover all of it.

There is no export yet, and `GET /leads` returns an owner's leads all at once: no limit, no pagination. **There is no authentication either**: a caller states who they are in a header and is believed. That is a deliberate boundary, not an oversight — see _Who is asking_ below.

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
```

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
  repositories/
    leads.ts               reads and writes leads; where ObjectId stops
  routes/
    health/index.ts        GET /health, and the database's state
    leads/index.ts         POST /leads and GET /leads
  schemas/
    health.ts              the response schema and the type derived from it
    lead.ts                what a client may send, and what is answered
  utils/
    validators.ts          what a valid host and a valid port are
    mongo.ts               swaps Mongo's _id for the API's id, and guards the database
    string.ts, array.ts    small helpers
    types.ts               Prettify, so a derived type reads as its result
    error.ts               prints an error's message rather than its stack
test/
  config.test.ts           loadConfig, fed made-up environments
  health.test.ts           GET /health, played through inject()
  leads.test.ts            creating and listing, played through inject()
  leads.repository.test.ts the repository alone, with no HTTP involved
  mongo.test.ts            swapMongoId, with no database involved
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

The conversion itself lives in `utils/mongo.ts`, in one generic function. `swapMongoId` turns a stored document into the shape the API answers, whatever the entity, and four types go with it, all four constrained by `Doc` — the driver's own `Document`: `MongoModel<T>` for what is stored, `MongoDoc<T>` for what the driver hands back, `MongoToApiDoc<T>` for what leaves, and `ApiToMongoDoc<T>` for the way back, the API's own shape as the database holds it, with `id` replaced by `_id`. `MongoModel<LeadType>` is derived from the response schema, so the fields of a lead are declared once and in one place.

That last one is what `list` asserts on its `find()`, which keeps the projected document derived from the response schema: `LeadType` holds no owner, so neither does the type of what the query is expected to return. Naming instead what to remove from the stored model says the same thing today and drifts apart from it the day a second private field appears. It is an assertion and nothing more — `find<T>()` tells the driver what to expect and verifies none of it — so the projection and the type have to be kept saying the same thing.

All four pass through `Prettify`, in `utils/types.ts`, which only changes what an editor prints: the shape it comes out as instead of the `Omit` it was written as. For the compiler it is an identity, and nothing of it reaches runtime.

`GET /leads` still reads an owner's leads in one go, with no limit and no cursor. The reason to defer it has run out — the owner filter it was waiting for is here — so it is now plainly a missing feature rather than a deliberate order of work, and it is in _What comes next_.

A repository for a single entity and two routes is more structure than they need on their own, and it is here early on purpose: the worker in _What comes next_ has to create and read leads with no HTTP request in sight. That second caller is what the seam is for.

The conversion is placed there rather than in a response hook on purpose. An `ObjectId` would serialize to its hexadecimal string by itself, since the driver gives it a `toJSON`, so a hook renaming `_id` for every route would work — but it would convert at the exit of the HTTP layer, leaving every service, log and future worker in between holding driver objects. Converting at the exit of the data layer means the rest of the application never learns which database is underneath. It is also the shape the Mongoose world reaches for with its `toJSON` transforms, except that an ODM owns the typing too.

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

**This is not authentication.** The caller states who they are and is believed; anyone can claim to be anyone. It is here to make the next steps real — a lead belongs to someone, and the export worker will have to respect that — without spending the step on a solved problem. Replacing it with signed tokens is a rewrite of that one hook, and of the test helper that builds the headers. That is the whole point of putting it in a file of its own.

The hook is registered inside the leads scope, not in `app.ts`, so `/health` answers without a header. There is no exception list and no route excluded by name: Fastify's encapsulation stops the hook at the boundary of the plugin that registered it. A health check that had to authenticate would be a broken health check.

That encapsulation cuts both ways, and it is worth knowing which way. `register()` opens a _child_ scope, so a hook added by a plugin registered that way guards the child and not the routes beside it — the hook silently never runs. `fastify-plugin` lifts it one level, into the scope that registered it, which is the leads plugin here. One level up is enough to guard the routes and not so far as to reach `/health`.

The decoration is stored and read with Fastify's `setDecorator` and `getDecorator`, and **nothing declares it on Fastify's global interfaces**. A `declare module "fastify"` would tell every file in the project that `request.ownerId` is a string — including the files outside this plugin's scope, where the decoration does not exist at all. The type would be lying, and the lie has a cost: a query built on that `undefined` becomes `{ ownerId: null }` in MongoDB and answers with the documents that have no owner, silently. Reading it out of scope instead raises `FST_ERR_DEC_UNDECLARED`, which is Fastify's own check, not one written here. The same two ways of typing a decoration are compared side by side in [fastify-training](https://github.com/Dindonneau/labs-fastify-training).

The owner is stored but never answered back: `list` projects it away, because the caller already knows who they are. Every query filters on `ownerId`, so the repository creates that index when it is built — which is why building it is asynchronous. `_id` is the only index MongoDB creates by itself.

### Configuration

`config.ts` reads the settings once, at startup. An environment only holds strings, or nothing at all when a variable is absent, so this is where each value gets its real type (`PORT` becomes a number) and where a bad one is refused. A start with `PORT=abc` stops with exit code 1 and a message that lists every problem at once, rather than a stack trace. A value that is well formed but cannot be used, such as an address that is not on this machine, still fails later, at `listen`.

| Variable       | Default        |                                                              |
| -------------- | -------------- | ------------------------------------------------------------ |
| `HOST`         | `127.0.0.1`    | the address to listen on                                     |
| `PORT`         | `8081`         | an integer from 1 to 65535                                   |
| `SERVICE_NAME` | `fastify-poc`  | reported by `/health`                                        |
| `MONGO_URL`    | none, required | a `mongodb://` or `mongodb+srv://` URL that names a database |

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

In order, each step on its own:

1. The export as a job document, with a status and a progress.
2. A worker that runs it, started and stopped with the server.
3. Resuming unfinished jobs at startup, checked by killing the process rather than stopping it politely.
4. Progress the client can read.
5. Error handling and a clean shutdown.
6. A limit and a cursor on `GET /leads`.

Signed tokens in place of the `x-owner-id` header would be a seventh, and a small one: it is one hook and one test helper. It is left out on purpose — the two things this project exists to show are the resilient job and the per-owner scoping, and authentication is neither.

## Related

[fastify-training](https://github.com/Dindonneau/labs-fastify-training) is where the Fastify concepts this project builds on were worked through: plugins and encapsulation, decorators, schemas, and the asynchronous bootstrapping of a database connection.
