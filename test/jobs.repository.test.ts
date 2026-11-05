import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mongodb } from "@fastify/mongodb"
import { mongoJobsRepository } from "../src/repositories/jobs.ts"
import { testDatabase } from "./database.ts"

// No Fastify here: the repository does not know that an HTTP server exists.
// This matters more for jobs than for leads — the worker of the next step is
// the caller that has no request, and these are the conditions it will run in.
const url = testDatabase()
const client = new mongodb.MongoClient(url)
const db = client.db()
const repository = await mongoJobsRepository(db)

const unicorn = "unicorn"
const rainbow = "rainbow"

beforeEach(() => db.collection("jobs").deleteMany({}))
after(() => client.close())

test("create hands back a pending job with the id Mongo gave it", async () => {
  const job = await repository.create(unicorn, "leadsExport", 12)

  assert.match(job.id, /^[0-9a-f]{24}$/)
  assert.equal(job.kind, "leadsExport")
  assert.equal(job.status, "pending")
  assert.deepEqual(job.progress, { processed: 0, total: 12 })
})

test("findById hands back the job its owner created", async () => {
  const created = await repository.create(unicorn, "leadsExport", 3)

  assert.deepEqual(
    await repository.findById(unicorn, "leadsExport", created.id),
    created
  )
})

// The same null for three different reasons, which is what keeps a route from
// answering a 403 to one of them and a 404 to the others.
test("another owner's job is not found", async () => {
  const created = await repository.create(unicorn, "leadsExport", 1)

  assert.equal(
    await repository.findById(rainbow, "leadsExport", created.id),
    null
  )
})

test("a job that does not exist is not found", async () => {
  assert.equal(
    await repository.findById(unicorn, "leadsExport", "0".repeat(24)),
    null
  )
})

// The kind is part of the filter, so one route cannot reach another's jobs.
// Only one kind exists in the union today, so the other one is written straight
// into the collection: this is the test that will still hold when a second
// kind is declared.
test("a job of another kind is not found through this kind", async () => {
  const { insertedId } = await db.collection("jobs").insertOne({
    ownerId: unicorn,
    kind: "somethingElse",
    status: "pending",
    progress: { processed: 0, total: 0 },
    createdAt: new Date()
  })

  assert.equal(
    await repository.findById(unicorn, "leadsExport", insertedId.toHexString()),
    null
  )
})

// Over HTTP the route's pattern answers 400 before this is reached. The worker
// has no schema in front of it, and new ObjectId() throws on anything that is
// not 24 hexadecimal characters.
test("a malformed id is not found, and does not throw", async () => {
  assert.equal(await repository.findById(unicorn, "leadsExport", "nope"), null)
})

// The same name as in leads.repository.test.ts would read as one test run
// twice in the output of a run, so it says which collection it is about.
test("a job's ownerId is stored but never handed back", async () => {
  const job = await repository.create(unicorn, "leadsExport", 0)

  const stored = await db.collection("jobs").findOne({})

  assert.equal(stored?.ownerId, unicorn)
  assert.equal("ownerId" in job, false)
})

// The one field beyond the id where the two shapes differ: a Date is what a
// query can compare and an index can order, a string is what JSON carries.
test("createdAt is stored as a Date and handed back as an ISO string", async () => {
  const job = await repository.create(unicorn, "leadsExport", 0)

  const stored = await db.collection("jobs").findOne({})

  assert.ok(stored?.createdAt instanceof Date)
  assert.equal(typeof job.createdAt, "string")
  assert.equal(job.createdAt, stored.createdAt.toISOString())
})
