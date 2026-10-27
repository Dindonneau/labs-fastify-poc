# fastify-poc

A small API for managing leads and exporting them, built around one idea: an export should be a job that lives in the database, not in the memory of a request. Stop the server halfway through and the export is meant to pick up where it left off, and every user is meant to see only their own data.

It is a proof of concept, built step by step on Fastify so that each piece is understood before the next one is added. This README describes what exists today. What is still to come is listed at the end.

## Status

Early. A server that starts from a configuration read from its environment, connects to MongoDB, leads that can be created and listed, a `GET /health` that reports whether the database answers, and the tests that cover all of it. There is no authentication and no export yet, so every lead is visible to everyone, and `GET /leads` returns all of them at once: no limit, no pagination.

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
  -H 'content-type: application/json' \
  -d '{"email":"unicorn@rainbow.com","firstName":"Unicorn"}'
# {"id":"6adf…","email":"unicorn@rainbow.com","firstName":"Unicorn"}

curl 127.0.0.1:8081/leads
# [{"id":"6adf…","email":"unicorn@rainbow.com","firstName":"Unicorn"}]
```

Every setting has a default except `MONGO_URL`. To change one, edit your `.env` (copied from `.env.example`); `npm run dev` reloads when the file changes. Without a `.env`, it prints `.env not found. Continuing without it.` (twice, once per process under `--watch`). That is only harmless if `MONGO_URL` is set in the real environment; otherwise the server stops with `MONGO_URL is required`.

To run what would actually ship:

```bash
npm run build
MONGO_URL=mongodb://127.0.0.1:27017/fastify-poc npm start
```

`npm start` reads no `.env`, so every setting it needs comes from the environment.

`npm test` runs the tests. No server needs to be running, but a MongoDB must be reachable on `127.0.0.1:27017`. Each test file that needs one gets a database of its own, named after it — `fastify-poc-test-health`, `fastify-poc-test-leads`, `fastify-poc-test-repository` — because test files run in parallel and a file that empties a collection would otherwise pull it out from under another. Only files named `*.test.ts` are run, so a helper placed in `test/` is not mistaken for a test.

`npm test` does not check types: Node only strips the annotations. `npm run typecheck` does, for the application and for the tests. `npm run format` applies Prettier and `npm run format:check` only reports; the choices behind it are below.

## Layout

```
src/
  server.ts                reads the configuration, creates the instance and listens
  config.ts                turns the environment into typed, validated settings
  app.ts                   composes the application, and nothing else
  plugins/
    mongo.ts               opens the MongoDB connection, closes it on shutdown
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
    mongo.ts               swaps Mongo's _id for the id the API answers
    string.ts, array.ts    small helpers
    error.ts               prints an error's message rather than its stack
test/
  config.test.ts           loadConfig, fed made-up environments
  health.test.ts           GET /health, played through inject()
  leads.test.ts            creating and listing, played through inject()
  leads.repository.test.ts the repository alone, with no HTTP involved
  mongo.test.ts            swapMongoId, with no database involved
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

The conversion itself lives in `utils/mongo.ts`, in one generic function. `swapMongoId` turns a stored document into the shape the API answers, whatever the entity, and three types go with it, all three constrained by `Doc` — the driver's own `Document`: `MongoModel<T>` for what is stored, `MongoDoc<T>` for what the driver hands back, `ApiDoc<T>` for what leaves. `MongoModel<LeadType>` is derived from the response schema, so the fields of a lead are declared once and in one place.

`GET /leads` reads the whole collection. That is deliberate for now, not an oversight: a limit and a cursor belong with the owner filter of the next step, since what a page holds depends on who is asking.

A repository for a single entity and two routes is more structure than they need on their own, and it is here early on purpose: the worker in _What comes next_ has to create and read leads with no HTTP request in sight. That second caller is what the seam is for.

The conversion is placed there rather than in a response hook on purpose. An `ObjectId` would serialize to its hexadecimal string by itself, since the driver gives it a `toJSON`, so a hook renaming `_id` for every route would work — but it would convert at the exit of the HTTP layer, leaving every service, log and future worker in between holding driver objects. Converting at the exit of the data layer means the rest of the application never learns which database is underneath. It is also the shape the Mongoose world reaches for with its `toJSON` transforms, except that an ODM owns the typing too.

`routes/leads` still reads `fastify.mongo.db` to build the repository, and `@fastify/mongodb` only fills it when `MONGO_URL` names a database — hence the check in `config.ts`, and a second one at registration so a mistake stops the start-up rather than the first request.

A body that breaks the schema is answered with a `400` before the handler runs, so nothing reaches the database:

```bash
curl -X POST 127.0.0.1:8081/leads -H 'content-type: application/json' -d '{"email":"nope"}'
# {"statusCode":400,"code":"FST_ERR_VALIDATION","message":"body/email must match format \"email\""}
```

A field the schema does not declare is a different matter: it is **dropped, not refused**. Fastify runs ajv with `removeAdditional`, so `additionalProperties: false` strips it on the way in, just as a response schema strips what it does not declare on the way out. Validation refuses what is wrong; it stays silent about what is merely unknown.

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

1. Identifying the caller, and filtering every query by owner.
2. The export as a job document, with a status and a progress.
3. A worker that runs it, started and stopped with the server.
4. Resuming unfinished jobs at startup, checked by killing the process rather than stopping it politely.
5. Progress the client can read.
6. Error handling and a clean shutdown.

## Related

[fastify-training](https://github.com/Dindonneau/labs-fastify-training) is where the Fastify concepts this project builds on were worked through: plugins and encapsulation, decorators, schemas, and the asynchronous bootstrapping of a database connection.
