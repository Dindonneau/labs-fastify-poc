# minilem

A small API for managing leads and exporting them, built around one idea: an export should be a job that lives in the database, not in the memory of a request. Stop the server halfway through and the export is meant to pick up where it left off, and every user is meant to see only their own data.

It is a proof of concept, built step by step on Fastify so that each piece is understood before the next one is added. This README describes what exists today. What is still to come is listed at the end.

## Status

Early. A server that starts, one route (`GET /health`), and the structure everything else will hang on. There is no database, no authentication and no export yet.

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

It listens on `127.0.0.1:8081`.

```bash
curl 127.0.0.1:8081/health
# {"status":"ok","service":"minilem"}
```

To run what would actually ship:

```bash
npm run build && npm start
```

There are no tests yet; `npm test` is still the placeholder `npm init` wrote.

## Layout

```
src/
  server.ts                creates the instance and listens
  app.ts                   composes the application, and nothing else
  routes/
    health/index.ts        GET /health
  schemas/
    health.ts              the response schema and the type derived from it
```

## How it is put together

`server.ts` creates the Fastify instance and listens. `app.ts` only composes the application: its settings arrive as the options of `register()`, typed by `AppOptions`, and it hands them down to the routes it registers.

So `app.ts` does not know who built it. The server will give it one configuration, and the tests, once they exist, another, with a database of their own. `serviceName` is scaffolding that makes the mechanism visible; real options replace it.

Every route declares its contract: a TypeBox schema, and the type derived from it. The generic makes the compiler reject a handler that returns the wrong type, and the schema stops any field it does not declare from reaching the client. The two describe the same shape, and neither replaces the other: a generic is erased at runtime, a schema is compiled by Fastify at startup.

The project is ESM. Relative imports carry their `.ts` extension, which `rewriteRelativeImportExtensions` rewrites to `.js` in the build. The reasoning is in the [lemfast README](https://github.com/Dindonneau/lemfast#departures-from-the-guides).

## What comes next

In order, each step on its own:

1. Configuration read from the environment, so the same application can run against a development database or a test one.
2. Tests that build the application without opening a port, using `fastify.inject`, against a database of their own.
3. MongoDB, and leads that belong to a user.
4. Identifying the caller, and filtering every query by owner.
5. The export as a job document, with a status and a progress.
6. A worker that runs it, started and stopped with the server.
7. Resuming unfinished jobs at startup, checked by killing the process rather than stopping it politely.
8. Progress the client can read.
9. Error handling and a clean shutdown.

## Related

[lemfast](https://github.com/Dindonneau/lemfast) is where the Fastify concepts this project builds on were worked through: plugins and encapsulation, decorators, schemas, and the asynchronous bootstrapping of a database connection.
