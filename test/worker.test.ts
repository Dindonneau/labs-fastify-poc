import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, beforeEach, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { mongodb } from "@fastify/mongodb"
import Fastify, { type FastifyInstance } from "fastify"
import app from "../src/app.ts"
import { testDatabase } from "./database.ts"

const mongoUrl = testDatabase()

const unicorn = { "x-owner-id": "unicorn" }
const rainbow = { "x-owner-id": "rainbow" }

// A directory of its own, dropped when the file ends: this worker writes real
// files, and a suite that leaves them behind is one that passes once.
const exportDir = await mkdtemp(join(tmpdir(), "fastify-poc-exports-"))
after(() => rm(exportDir, { recursive: true, force: true }))

// The collections are emptied from a connection of this file's own rather than
// through the server, so that a test can leave a job behind for a server that
// has not started yet — which is what a restart looks like from here.
const client = new mongodb.MongoClient(mongoUrl)
const db = client.db()

beforeEach(async () => {
  await db.collection("leads").deleteMany({})
  await db.collection("jobs").deleteMany({})
})

after(() => client.close())

// app is registered as it is, without fp(): nothing here reaches inside it.
// 20 ms between polls and a progress write every two leads, because the point
// is to watch the loop turn rather than to wait for it.
//
// The logger writes into an array the caller can read, because one test below
// asserts on what the worker did *not* say. level "error" keeps it to what
// that test is about.
async function buildWith(logged: string[]) {
  const server = Fastify({
    logger: {
      level: "error",
      stream: { write: line => void logged.push(line) }
    }
  })

  await server.register(app, {
    serviceName: "test-service",
    mongoUrl,
    worker: { exportDir, pollIntervalMs: 20, progressEvery: 2 }
  })

  // register() is awaited for its effect and answers nothing: returning the
  // instance is what the callers need, and what keeps them from a possibly
  // undefined server.
  return server
}

async function build() {
  const server = await buildWith([])

  // onReady is what arms the loop, and the first inject() would trigger it
  // anyway: asking for it here makes the moment the worker starts explicit.
  await server.ready()
  return server
}

type Headers = Record<string, string>

const addLead = (server: FastifyInstance, headers: Headers, email: string) =>
  server.inject({ method: "POST", url: "/leads", headers, payload: { email } })

const createExport = (server: FastifyInstance, headers: Headers) =>
  server.inject({ method: "POST", url: "/exports", headers })

const pendingJob = (ownerId: string, total: number) => ({
  ownerId,
  kind: "leadsExport",
  status: "pending",
  progress: { processed: 0, total },
  createdAt: new Date()
})

const linesOf = async (id: string) => {
  const content = await readFile(join(exportDir, `${id}.ndjson`), "utf8")
  return content.split("\n").filter(line => line !== "")
}

// The useEffect of a front end, written in Node: ask, wait, ask again, and
// stop on a terminal status. Every inject() below is a request a browser would
// have made, so this is the client side of the whole pattern, asserted.
async function pollUntilDone(
  server: FastifyInstance,
  headers: Headers,
  id: string
) {
  const statuses: string[] = []

  for (let attempt = 0; attempt < 250; attempt += 1) {
    const response = await server.inject({
      method: "GET",
      url: `/exports/${id}`,
      headers
    })

    const job = response.json()
    statuses.push(job.status)

    if (job.status === "done" || job.status === "failed") {
      return { job, statuses, retryAfter: response.headers["retry-after"] }
    }

    await delay(10)
  }

  throw new Error("the job never reached a terminal status")
}

test("the worker claims the job, runs it and finishes it", async t => {
  const server = await build()
  t.after(() => server.close())

  await addLead(server, unicorn, "unicorn@rainbow.com")
  const created = (await createExport(server, unicorn)).json()

  const { job } = await pollUntilDone(server, unicorn, created.id)

  assert.equal(job.status, "done")
  assert.equal(typeof job.startedAt, "string")
  assert.equal(typeof job.finishedAt, "string")
})

test("the export is one JSON line per lead", async t => {
  const server = await build()
  t.after(() => server.close())

  for (const email of ["unicorn@rainbow.com", "unicorn2@rainbow.com"]) {
    await addLead(server, unicorn, email)
  }
  const created = (await createExport(server, unicorn)).json()

  await pollUntilDone(server, unicorn, created.id)

  const lines = await linesOf(created.id)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(line => JSON.parse(line).email).sort(), [
    "unicorn2@rainbow.com",
    "unicorn@rainbow.com"
  ])
})

// The id is the one the API answers, not the ObjectId: nothing above the data
// layer should have to know the difference, the file name included.
test("each line is a lead as the API answers it, with an id and no ownerId", async t => {
  const server = await build()
  t.after(() => server.close())

  await addLead(server, unicorn, "unicorn@rainbow.com")
  const created = (await createExport(server, unicorn)).json()

  await pollUntilDone(server, unicorn, created.id)

  const [line] = await linesOf(created.id)
  const lead = JSON.parse(line!)

  assert.match(lead.id, /^[0-9a-f]{24}$/)
  assert.equal(lead.email, "unicorn@rainbow.com")
  assert.equal("ownerId" in lead, false)
  assert.equal("_id" in lead, false)
})

test("the progress ends at what was written", async t => {
  const server = await build()
  t.after(() => server.close())

  for (const email of [
    "unicorn3@rainbow.com",
    "unicorn4@rainbow.com",
    "unicorn5@rainbow.com"
  ]) {
    await addLead(server, unicorn, email)
  }
  const created = (await createExport(server, unicorn)).json()

  const { job } = await pollUntilDone(server, unicorn, created.id)

  assert.deepEqual(job.progress, { processed: 3, total: 3 })
  assert.equal((await linesOf(created.id)).length, 3)
})

test("an export holds the owner's leads and no one else's", async t => {
  const server = await build()
  t.after(() => server.close())

  await addLead(server, unicorn, "unicorn@rainbow.com")
  await addLead(server, rainbow, "rainbow@unicorn.com")
  const created = (await createExport(server, unicorn)).json()

  const { job } = await pollUntilDone(server, unicorn, created.id)

  assert.equal(job.progress.total, 1)
  assert.deepEqual(
    (await linesOf(created.id)).map(line => JSON.parse(line).email),
    ["unicorn@rainbow.com"]
  )
})

// No assertion that "running" was ever seen: two leads can be claimed and
// written between two polls, which is exactly what the pattern allows. What
// must hold is that a client never sees the order break — and that the header
// telling it to come back stops once there is nothing left to wait for.
test("a polling client only ever sees the status move forward", async t => {
  const server = await build()
  t.after(() => server.close())

  await addLead(server, unicorn, "unicorn@rainbow.com")
  const created = (await createExport(server, unicorn)).json()

  const { statuses, retryAfter } = await pollUntilDone(
    server,
    unicorn,
    created.id
  )

  const order = ["pending", "running", "done", "failed"]
  const ranks = statuses.map(status => order.indexOf(status))

  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => a - b)
  )
  assert.equal(statuses.at(-1), "done")
  assert.equal(retryAfter, undefined)
})

// The promise in this project's own description. The job is in the collection
// before the server exists, which is what a restart leaves behind, and no
// recovery pass had to be written for it: the claim is the recovery.
test("a job left pending by a previous run is picked up on boot", async t => {
  await db.collection("leads").insertOne({
    ownerId: "unicorn",
    email: "unicorn@rainbow.com"
  })
  const { insertedId } = await db
    .collection("jobs")
    .insertOne(pendingJob("unicorn", 1))

  const server = await build()
  t.after(() => server.close())

  const { job } = await pollUntilDone(server, unicorn, insertedId.toHexString())

  assert.equal(job.status, "done")
  assert.equal(job.progress.processed, 1)
})

// register() opens a child scope, and a hook added in one guards that scope
// rather than the server. onClose is the reason to prove it here rather than
// assume it: a loop that outlived its server would keep claiming jobs through
// a database connection that is being closed underneath it.
//
// The job staying pending is **not** what proves it, and that is the whole
// difficulty of this test. close() also closes the server's MongoClient, so a
// loop that kept ticking would leave the job pending too — by throwing
// MongoNotConnectedError into tick()'s catch, where it is logged and the loop
// carries on. What separates a stopped loop from a broken one is therefore
// what was logged, and the assertion has to be the silence.
test("closing the server stops the loop", async t => {
  const logged: string[] = []
  const server = await buildWith(logged)
  await server.ready()
  t.after(() => server.close())

  await server.close()

  // Written straight into the collection: the server that would have been
  // asked for it is gone.
  const { insertedId } = await db
    .collection("jobs")
    .insertOne(pendingJob("unicorn", 1))

  // Ten ticks that must not happen
  await delay(200)

  const stored = await db.collection("jobs").findOne({ _id: insertedId })
  assert.equal(stored?.status, "pending")
  assert.equal(stored?.progress.processed, 0)

  // Remove the onClose hook from plugins/worker.ts and this is the line that
  // fails, where the two above still pass.
  assert.deepEqual(
    logged.filter(line => line.includes("the worker loop failed")),
    []
  )
})

test("an export that cannot be written is recorded as failed", async t => {
  await db.collection("leads").insertOne({
    ownerId: "unicorn",
    email: "unicorn@rainbow.com"
  })
  const { insertedId } = await db
    .collection("jobs")
    .insertOne(pendingJob("unicorn", 1))
  const id = insertedId.toHexString()

  // A directory where the file is meant to go, so that createWriteStream
  // answers EISDIR: a failure the worker did not cause and cannot fix, which
  // is the only kind worth recording on the job.
  await mkdir(join(exportDir, `${id}.ndjson`))

  const server = await build()
  t.after(() => server.close())

  const { job } = await pollUntilDone(server, unicorn, id)

  assert.equal(job.status, "failed")
  // The worker's own message. What the driver threw named a path and stayed
  // in the log, where a client cannot read it.
  assert.equal(job.error, "the export could not be written")
  assert.equal(typeof job.finishedAt, "string")
})

// The other half of the option: this is the deployment where the API accepts
// jobs and something else entirely runs them.
test("without the worker option, nothing drains the collection", async t => {
  const server = Fastify({ logger: false })
  await server.register(app, { serviceName: "test-service", mongoUrl })
  t.after(() => server.close())
  await server.ready()

  await addLead(server, unicorn, "unicorn@rainbow.com")
  const created = (await createExport(server, unicorn)).json()

  await delay(100)

  const response = await server.inject({
    method: "GET",
    url: `/exports/${created.id}`,
    headers: unicorn
  })

  assert.equal(response.json().status, "pending")
  // And the answer still tells the client when to come back, because a job
  // this process will not run is one another process may already be running.
  assert.equal(Number(response.headers["retry-after"]), 1)
})
