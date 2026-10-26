# fastify-poc

A small API for managing leads and exporting them, built around one idea: an export should be a job that lives in the database, not in the memory of a request. Stop the server halfway through and the export is meant to pick up where it left off, and every user is meant to see only their own data.

It is a proof of concept, built step by step on Fastify so that each piece is understood before the next one is added. This README describes what exists today. What is still to come is listed at the end.

## Status

Early. A server that starts from a configuration read from its environment, one route (`GET /health`), the tests that cover both, and the structure everything else will hang on. There is no database, no authentication and no export yet.

## Stack

- Fastify 5.12
- TypeBox 1.4 — schemas written in TypeScript, types derived from them
- TypeScript 7
- Node 24 — `.nvmrc` pins `lts/krypton`

## Running it

```bash
nvm use
npm install
npm run dev          # reloads on save, straight from the sources
```

By default it listens on `127.0.0.1:8081`.

```bash
curl 127.0.0.1:8081/health
# {"status":"ok","service":"fastify-poc"}
```

Every setting has a default, so nothing is required. To change one, copy `.env.example` to `.env` and edit it; `npm run dev` reloads when the file changes. Without a `.env`, it prints `.env not found. Continuing without it.` (twice, once per process under `--watch`), which is normal.

To run what would actually ship:

```bash
npm run build && npm start
```

`npm test` runs the tests, with no server running and no database needed. Only files named `*.test.ts` are run, so a helper placed in `test/` is not mistaken for a test.

`npm test` does not check types: Node only strips the annotations. `npm run typecheck` does, for the application and for the tests.

## Layout

```
src/
  server.ts                reads the configuration, creates the instance and listens
  config.ts                turns the environment into typed, validated settings
  app.ts                   composes the application, and nothing else
  routes/
    health/index.ts        GET /health
  schemas/
    health.ts              the response schema and the type derived from it
  utils/
    validators.ts          what a valid host and a valid port are
    string.ts, array.ts    small helpers
    error.ts               prints an error's message rather than its stack
test/
  config.test.ts           loadConfig, fed made-up environments
  health.test.ts           GET /health, played through inject()
  tsconfig.json            what `npm run typecheck`, and the editor, use to check the tests
.env.example               the settings that exist, with their defaults
```

## How it is put together

`server.ts` creates the Fastify instance and listens. `app.ts` only composes the application: its settings arrive as the options of `register()`, typed by `AppOptions`, and it hands them down to the routes it registers.

So `app.ts` does not know who built it. The server gives it the settings it needs, and each test gives it its own.

### Configuration

`config.ts` reads the settings once, at startup. An environment only holds strings, or nothing at all when a variable is absent, so this is where each value gets its real type (`PORT` becomes a number) and where a bad one is refused. A start with `PORT=abc` stops with exit code 1 and a message that lists every problem at once, rather than a stack trace. A value that is well formed but cannot be used, such as an address that is not on this machine, still fails later, at `listen`.

| Variable | Default | |
|---|---|---|
| `HOST` | `127.0.0.1` | the address to listen on |
| `PORT` | `8081` | an integer from 1 to 65535 |
| `SERVICE_NAME` | `fastify-poc` | reported by `/health` |

`loadConfig` takes the environment as an argument instead of reading `process.env` itself, so a test hands it a made-up one and never touches the real environment.

`npm run dev` loads `.env` with Node's own `--env-file-if-exists`, with no package involved. A variable set in the real environment wins over the file. `.env` is not committed, and `.env.example` is. `npm start` does not read a file at all: a deployed process gets its settings from the environment it runs in.

Every route declares its contract: a TypeBox schema, and the type derived from it. The generic makes the compiler reject a handler that returns the wrong type, and the schema stops any field it does not declare from reaching the client. The two describe the same shape, and neither replaces the other: a generic is erased at runtime, a schema is compiled by Fastify at startup.

The project is ESM. Relative imports carry their `.ts` extension, which `rewriteRelativeImportExtensions` rewrites to `.js` in the build. The reasoning is in the [fastify-training README](https://github.com/Dindonneau/labs-fastify-training#departures-from-the-guides).

## What comes next

In order, each step on its own:

1. MongoDB, and leads that belong to a user. The database URL becomes the first setting with no default, and the tests get a database of their own.
2. Identifying the caller, and filtering every query by owner.
3. The export as a job document, with a status and a progress.
4. A worker that runs it, started and stopped with the server.
5. Resuming unfinished jobs at startup, checked by killing the process rather than stopping it politely.
6. Progress the client can read.
7. Error handling and a clean shutdown.

## Related

[fastify-training](https://github.com/Dindonneau/labs-fastify-training) is where the Fastify concepts this project builds on were worked through: plugins and encapsulation, decorators, schemas, and the asynchronous bootstrapping of a database connection.
