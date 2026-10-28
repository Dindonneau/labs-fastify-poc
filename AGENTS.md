# AGENTS.md

Conventions for anyone working on this repository, human or agent. The README explains what the code does and why it is shaped that way; this file covers how work is carried out.

## Commands

|                     |                                                                     |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | reloads on save, straight from the sources; `MONGO_URL` is required |
| `npm test`          | the test suite; a MongoDB has to be reachable on `127.0.0.1:27017`  |
| `npm run typecheck` | `npm test` does not check types — Node only strips the annotations  |
| `npm run format`    | applies Prettier; `npm run format:check` only reports               |

Nothing runs on its own: there is no hook and no CI. Run the typechecker, the tests and the formatter before proposing a change, and say what they returned rather than that they should pass.

## Language

Everything committed is in English: code, comments, identifiers, file and directory names, commit messages, pull request titles and descriptions, README. Whatever language a discussion happens in, what lands in the repository is English.

## Git

Branches are `main` and `dev`. Work happens on a branch taken from `dev`, named `feat/…`, `fix/…`, `refactor/…` or `docs/…` with a camelCase suffix, and reaches `dev` through a pull request. `dev` is promoted to `main`.

Commit messages follow Conventional Commits. A change that mixes concerns is split across commits — the behaviour in one, the tooling or the reformatting in another — so that each diff can be read on its own. Never `git add .`; stage the files the commit is about.

## Tests and the local database

A test file that needs a database takes it from `testDatabase()` in `test/database.ts`, which hands back the one test database and drops it when the file ends. Never point a test at the application's database, and never add a second test database: files run one at a time (`--test-concurrency=1`) precisely so that one is enough. A developer's local MongoDB is shared with their other projects, and anything a test leaves there, they have to clean up by hand.

## Sample data

Examples, tests, documentation and commit messages use `unicorn` and `rainbow`, and `unicorn@rainbow.com` for an address. Never a real name, a real email or anything that identifies a person or a company.

## Formatting

Prettier, `printWidth` 80, in `.prettierrc`. It is a target rather than a limit: Prettier never splits a string literal or a comment, so some test names run past 80 on purpose. The reasoning is in the README, under _Formatting_.

## Boundaries worth keeping

These are easy to break without noticing, and the structure exists for them:

- a route never names a collection or an `_id`, and never holds a driver object — it goes through the repository interface. `requireDb(fastify.mongo.db)` is the one place a route touches the database;
- `fastify.mongo.db` is typed `Db | undefined`, and that is information rather than noise to cast away. The version that needs no check, `client.db()`, answers a database silently **named `test`** when the URL names none, so every document lands in the wrong place without a word. Go through `requireDb`, and leave the repository's own parameter non-optional so the compiler refuses a call that skips it;
- the owner comes from `getOwner(request)` and never from a body, a query string or a route parameter — a caller does not get to name whose data they are reading. `plugins/identity.ts` is the only file that reads the header, and every repository method takes the owner first, so none can be called without one;
- a request or reply decoration is declared with `decorateRequest` and read with `getDecorator`, never through `declare module "fastify"`. The global interface would promise the decoration to files outside the scope that has it, where it does not exist — and a MongoDB filter built on that `undefined` becomes `{ field: null }` and answers with the documents that have no value, in silence. `getDecorator` raises `FST_ERR_DEC_UNDECLARED` instead;
- `ObjectId` stops at `swapMongoId`, in `src/utils/mongo.ts`. Nothing above the data layer holds a driver type;
- the driver is reached through `@fastify/mongodb`, which re-exports it. `mongodb` is not a declared dependency, so importing it directly only works by accident;
- every route declares a TypeBox schema and the type derived from it. The schema is not optional because the generic exists: one is erased at runtime, the other is compiled at startup.

Two behaviours that surprise people, both found the hard way here:

- Fastify runs ajv with `removeAdditional`, so `additionalProperties: false` **strips** an undeclared field instead of answering 400;
- `register()` opens a **child** scope, so a hook added by a plugin registered that way guards that child and not the routes beside it. It never runs, and nothing says so. `fastify-plugin` lifts it into the scope that registered it. Before adding a hook in a plugin, write the test that proves it runs — and, for a guard, the test that proves it does **not** run where it should not, such as `/health`.
