import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mongodb } from "@fastify/mongodb"
import { mongoJobsRepository } from "../src/repositories/jobs.ts"
import { testDatabase } from "./database.ts"

// No Fastify here: the repository does not know that an HTTP server exists.
// This matters more for jobs than for leads — the worker is the caller that
// has no request, and these are the conditions it runs in.
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

// The worker's side. It has no request and no owner of its own, which is the
// condition every test below runs in.

test("claimNext turns a pending job into a running one", async () => {
  const created = await repository.create(unicorn, "leadsExport", 3)

  const claimed = await repository.claimNext("leadsExport")

  assert.equal(claimed?.job.id, created.id)
  assert.equal(claimed?.job.status, "running")
  assert.equal(typeof claimed?.job.startedAt, "string")
})

// The one place the owner leaves the data layer: the worker has to know whose
// leads to export, and the job itself still does not carry it.
test("claimNext hands back the owner beside the job, not inside it", async () => {
  await repository.create(unicorn, "leadsExport", 1)

  const claimed = await repository.claimNext("leadsExport")

  assert.equal(claimed?.ownerId, unicorn)
  assert.equal("ownerId" in (claimed?.job ?? {}), false)
})

test("claimNext answers null when nothing is pending", async () => {
  assert.equal(await repository.claimNext("leadsExport"), null)
})

test("a job that is already running is not claimed again", async () => {
  await repository.create(unicorn, "leadsExport", 1)

  await repository.claimNext("leadsExport")

  assert.equal(await repository.claimNext("leadsExport"), null)
})

// What the atomic claim is for. find-then-update would hand the same job to
// both of these, and it would be exported twice.
test("two claims at once never hand back the same job", async () => {
  await repository.create(unicorn, "leadsExport", 1)
  await repository.create(rainbow, "leadsExport", 1)

  const [first, second] = await Promise.all([
    repository.claimNext("leadsExport"),
    repository.claimNext("leadsExport")
  ])

  assert.ok(first && second)
  assert.notEqual(first.job.id, second.job.id)
})

test("the oldest pending job is claimed first", async () => {
  const older = await db.collection("jobs").insertOne({
    ownerId: unicorn,
    kind: "leadsExport",
    status: "pending",
    progress: { processed: 0, total: 1 },
    createdAt: new Date("2026-11-01T10:00:00.000Z")
  })
  await db.collection("jobs").insertOne({
    ownerId: unicorn,
    kind: "leadsExport",
    status: "pending",
    progress: { processed: 0, total: 1 },
    createdAt: new Date("2026-11-05T10:00:00.000Z")
  })

  const claimed = await repository.claimNext("leadsExport")

  assert.equal(claimed?.job.id, older.insertedId.toHexString())
})

// Claimed first, because that is the only state the worker calls this in and
// the only one the filter accepts.
test("recordProgress moves processed and leaves the total alone", async () => {
  const created = await repository.create(unicorn, "leadsExport", 10)
  await repository.claimNext("leadsExport")

  await repository.recordProgress(created.id, 4)

  const job = await repository.findById(unicorn, "leadsExport", created.id)
  assert.deepEqual(job?.progress, { processed: 4, total: 10 })
})

// The id a worker holds says nothing about when it was handed out, so each of
// the three filters on the status as well. Three tests, because each method
// would be a different kind of wrong on its own.
test("recordProgress does nothing to a job that was never claimed", async () => {
  const created = await repository.create(unicorn, "leadsExport", 10)

  await repository.recordProgress(created.id, 4)

  const job = await repository.findById(unicorn, "leadsExport", created.id)
  assert.deepEqual(job?.progress, { processed: 0, total: 10 })
  assert.equal(job?.status, "pending")
})

test("finish does not bring a job that already failed back to done", async () => {
  const created = await repository.create(unicorn, "leadsExport", 1)
  await repository.claimNext("leadsExport")
  await repository.fail(created.id, "the disk was full")

  await repository.finish(created.id)

  const job = await repository.findById(unicorn, "leadsExport", created.id)
  assert.equal(job?.status, "failed")
  assert.equal((job as { error?: string }).error, "the disk was full")
})

test("fail does not reopen a job that is already done", async () => {
  const created = await repository.create(unicorn, "leadsExport", 1)
  await repository.claimNext("leadsExport")
  await repository.finish(created.id)

  await repository.fail(created.id, "too late")

  const job = await repository.findById(unicorn, "leadsExport", created.id)
  assert.equal(job?.status, "done")
  assert.equal("error" in (job ?? {}), false)
})

test("finish ends the job as done, with the time it ended", async () => {
  const created = await repository.create(unicorn, "leadsExport", 1)
  await repository.claimNext("leadsExport")

  await repository.finish(created.id)

  const job = await repository.findById(unicorn, "leadsExport", created.id)
  assert.equal(job?.status, "done")
  assert.equal(typeof (job as { finishedAt?: string }).finishedAt, "string")
})

test("fail ends the job as failed, and says why", async () => {
  const created = await repository.create(unicorn, "leadsExport", 1)
  await repository.claimNext("leadsExport")

  await repository.fail(created.id, "the disk was full")

  const job = await repository.findById(unicorn, "leadsExport", created.id)
  assert.equal(job?.status, "failed")
  assert.equal((job as { error?: string }).error, "the disk was full")
})

// The claim filters on status and orders by createdAt; this is the index that
// query earns, created when the repository is built.
test("the claim's index is created with the repository", async () => {
  const indexes = await db.collection("jobs").indexes()

  assert.ok(
    indexes.some(index => index.key.status === 1 && index.key.createdAt === 1)
  )
})
