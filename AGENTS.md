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

## Sample data

Examples, tests, documentation and commit messages use `unicorn` and `rainbow`, and `unicorn@rainbow.com` for an address. Never a real name, a real email or anything that identifies a person or a company.

## Formatting

Prettier, `printWidth` 80, in `.prettierrc`. It is a target rather than a limit: Prettier never splits a string literal or a comment, so some test names run past 80 on purpose. The reasoning is in the README, under _Formatting_.

## Boundaries worth keeping

These are easy to break without noticing, and the structure exists for them:

- a route never names a collection or an `_id`, and never holds a driver object — it goes through the repository interface. `requireDb(fastify.mongo.db)` is the one place a route touches the database;
- `fastify.mongo.db` is typed `Db | undefined`, and that is information rather than noise to cast away. The version that needs no check, `client.db()`, answers a database silently **named `test`** when the URL names none, so every document lands in the wrong place without a word. Go through `requireDb`, and leave the repository's own parameter non-optional so the compiler refuses a call that skips it;
- `ObjectId` stops at `swapMongoId`, in `src/utils/mongo.ts`. Nothing above the data layer holds a driver type;
- the driver is reached through `@fastify/mongodb`, which re-exports it. `mongodb` is not a declared dependency, so importing it directly only works by accident;
- every route declares a TypeBox schema and the type derived from it. The schema is not optional because the generic exists: one is erased at runtime, the other is compiled at startup.

A validation note that surprises people: Fastify runs ajv with `removeAdditional`, so `additionalProperties: false` **strips** an undeclared field instead of answering 400.
