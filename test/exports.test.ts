import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import app from "../src/app.ts"
import { testDatabase } from "./database.ts"

const mongoUrl = testDatabase()

const asOwner = (ownerId: string) => ({ "x-owner-id": ownerId })

const unicorn = asOwner("unicorn")
const rainbow = asOwner("rainbow")

// fp() lifts app out of its own scope, so that a test can reach server.mongo
// and empty the collections. Both of them: a job counts the leads that exist
// when it is created, so a lead left behind would change another test's total.
async function build() {
  const server = Fastify()
  await server.register(fp(app), { serviceName: "test-service", mongoUrl })
  await server.mongo.db?.collection("leads").deleteMany({})
  await server.mongo.db?.collection("jobs").deleteMany({})
  return server
}

const addLead = (
  server: FastifyInstance,
  headers: Record<string, string>,
  email: string
) =>
  server.inject({ method: "POST", url: "/leads", headers, payload: { email } })

const createExport = (
  server: FastifyInstance,
  headers: Record<string, string>
) => server.inject({ method: "POST", url: "/exports", headers })

test("POST /exports answers 202 with a pending job and where to read it", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await createExport(server, unicorn)

  assert.equal(response.statusCode, 202)
  const job = response.json()
  assert.match(job.id, /^[0-9a-f]{24}$/)
  assert.equal(job.kind, "leadsExport")
  assert.equal(job.status, "pending")
  assert.deepEqual(job.progress, { processed: 0, total: 0 })
  assert.equal(response.headers.location, `/exports/${job.id}`)
})

// 202 is the whole point of the step: the answer promises a job, not a result.
test("nothing has run the job: it is still pending in the collection", async t => {
  const server = await build()
  t.after(() => server.close())

  await createExport(server, unicorn)

  const stored = await server.mongo.db?.collection("jobs").findOne({})
  assert.equal(stored?.status, "pending")
  assert.equal(stored?.progress.processed, 0)
})

test("the total counts the leads the owner has, and only those", async t => {
  const server = await build()
  t.after(() => server.close())

  await addLead(server, unicorn, "unicorn@rainbow.com")
  await addLead(server, unicorn, "unicorn2@rainbow.com")
  await addLead(server, rainbow, "rainbow@unicorn.com")

  const response = await createExport(server, unicorn)

  assert.equal(response.json().progress.total, 2)
})

// The total is a snapshot, and saying so in a test is what makes it a decision
// rather than an accident the worker has to live with.
test("a lead created after the job is not in its total", async t => {
  const server = await build()
  t.after(() => server.close())

  await addLead(server, unicorn, "unicorn@rainbow.com")
  const created = await createExport(server, unicorn)
  await addLead(server, unicorn, "unicorn2@rainbow.com")

  const response = await server.inject({
    method: "GET",
    url: `/exports/${created.json().id}`,
    headers: unicorn
  })

  assert.equal(response.json().progress.total, 1)
})

test("GET /exports/:id hands back the job that was created", async t => {
  const server = await build()
  t.after(() => server.close())

  const created = await createExport(server, unicorn)

  const response = await server.inject({
    method: "GET",
    url: `/exports/${created.json().id}`,
    headers: unicorn
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), created.json())
})

test("createdAt is answered as an ISO string", async t => {
  const server = await build()
  t.after(() => server.close())

  const { createdAt } = (await createExport(server, unicorn)).json()

  assert.equal(typeof createdAt, "string")
  assert.equal(new Date(createdAt).toISOString(), createdAt)
})

// A 403 would confirm that the job exists. The route cannot answer one: the
// repository hands back the same null as for a job that is not there.
test("another owner's job is a 404, and says nothing more", async t => {
  const server = await build()
  t.after(() => server.close())

  const created = await createExport(server, unicorn)

  const response = await server.inject({
    method: "GET",
    url: `/exports/${created.json().id}`,
    headers: rainbow
  })

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: "Not Found",
    message: "No such export"
  })
})

test("a job that does not exist is the same 404", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await server.inject({
    method: "GET",
    url: `/exports/${"0".repeat(24)}`,
    headers: unicorn
  })

  assert.equal(response.statusCode, 404)
  assert.equal(response.json().message, "No such export")
})

// The params schema answers before the handler runs, so new ObjectId() is
// never handed anything it would throw on.
test("an id that is not an ObjectId is a 400, not a 500", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await server.inject({
    method: "GET",
    url: "/exports/nope",
    headers: unicorn
  })

  assert.equal(response.statusCode, 400)
  assert.equal(response.json().code, "FST_ERR_VALIDATION")
})

// identity is reused as it is, so this passes without a line written for it.
for (const [method, url] of [
  ["POST", "/exports"],
  ["GET", `/exports/${"0".repeat(24)}`]
] as const) {
  test(`${method} ${url} without an x-owner-id is answered 401`, async t => {
    const server = await build()
    t.after(() => server.close())

    const response = await server.inject({ method, url })

    assert.equal(response.statusCode, 401)
  })
}

// Nothing in this file runs jobs, which is what makes these two deterministic:
// the job cannot finish between the POST and the GET.
test("a job that can still change says when to come back", async t => {
  const server = await build()
  t.after(() => server.close())

  const created = await createExport(server, unicorn)

  const response = await server.inject({
    method: "GET",
    url: `/exports/${created.json().id}`,
    headers: unicorn
  })

  assert.equal(Number(response.headers["retry-after"]), 1)
})

// A Retry-After here would send a client back for an answer it already holds.
test("a job that will not change again sends no retry-after", async t => {
  const server = await build()
  t.after(() => server.close())

  const { insertedId } = await server.mongo.db!.collection("jobs").insertOne({
    ownerId: "unicorn",
    kind: "leadsExport",
    status: "done",
    progress: { processed: 1, total: 1 },
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: new Date()
  })

  const response = await server.inject({
    method: "GET",
    url: `/exports/${insertedId.toHexString()}`,
    headers: unicorn
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().status, "done")
  assert.equal(response.headers["retry-after"], undefined)
})

test("the job document keeps the owner, and the answer does not", async t => {
  const server = await build()
  t.after(() => server.close())

  const job = (await createExport(server, unicorn)).json()

  const stored = await server.mongo.db?.collection("jobs").findOne({})
  assert.equal(stored?.ownerId, "unicorn")
  assert.equal("ownerId" in job, false)
})
