import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import fp from "fastify-plugin"
import app from "../src/app.ts"
import { getOwner } from "../src/plugins/identity.ts"
import { testDatabase } from "./database.ts"

// Builds the application as the server does, but with the options a test
// chooses. inject() then plays an HTTP request against it: no port is opened.
// One database per test file, so a file that empties a collection cannot
// disturb another running beside it. A MongoDB must be running locally;
// MongoDB creates the database on first write.
const mongoUrl = testDatabase()

async function build(serviceName: string) {
  const server = Fastify()
  await server.register(app, { serviceName, mongoUrl })
  return server
}

test("GET /health answers ok, with the service name it was given", async t => {
  const server = await build("test-service")
  t.after(() => server.close())

  const response = await server.inject({ method: "GET", url: "/health" })

  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers["content-type"]), /^application\/json/)
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "test-service",
    database: "up"
  })
})

test("the service name comes from the options, not from a constant", async t => {
  const alpha = await build("alpha")
  const beta = await build("beta")
  t.after(() => Promise.all([alpha.close(), beta.close()]))

  const fromAlpha = await alpha.inject({ method: "GET", url: "/health" })
  const fromBeta = await beta.inject({ method: "GET", url: "/health" })

  assert.equal(fromAlpha.json().service, "alpha")
  assert.equal(fromBeta.json().service, "beta")
})

test("GET /health answers 503 and degraded once the database is unreachable", async t => {
  // fp() lifts app out of its own scope, so that this test can reach
  // `server.mongo` and cut the connection.
  const server = Fastify()
  await server.register(fp(app), { serviceName: "test-service", mongoUrl })
  t.after(() => server.close())
  // A closed client does not reconnect by itself
  await server.mongo.client.close()

  const response = await server.inject({ method: "GET", url: "/health" })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), {
    status: "degraded",
    service: "test-service",
    database: "down"
  })
})

test("the application refuses to start when the database cannot be reached", async () => {
  const server = Fastify()

  server.register(app, {
    serviceName: "test-service",
    mongoUrl: "mongodb://127.0.0.1:1/unicorn"
  })

  await assert.rejects(
    async () => {
      await server.ready()
    },
    { name: "MongoServerSelectionError" }
  )
})

test("an unknown route is a 404: no catch-all route answers in its place", async t => {
  const server = await build("test-service")
  t.after(() => server.close())

  const response = await server.inject({ method: "GET", url: "/nowhere" })

  assert.equal(response.statusCode, 404)
})

// The counterpart of the leads tests: identity is registered inside the leads
// scope, so the hook stops at its boundary. A health check that had to
// authenticate would be a broken health check, and no exception is written
// anywhere to keep it open — the encapsulation does it.
test("GET /health answers without an identity, unlike /leads", async t => {
  const server = await build("test-service")
  t.after(() => server.close())

  const health = await server.inject({ method: "GET", url: "/health" })
  const leads = await server.inject({ method: "GET", url: "/leads" })

  assert.equal(health.statusCode, 200)
  assert.equal(leads.statusCode, 401)
})

// Nothing declares request.ownerId globally, so reading it where identity was
// never registered is a named Fastify error rather than undefined. That
// matters: a filter built on undefined becomes { ownerId: null } in MongoDB
// and answers with the documents that have no owner.
test("reading the owner outside the identity scope raises, it does not answer undefined", async t => {
  const server = Fastify()
  await server.register(fp(app), { serviceName: "test-service", mongoUrl })
  t.after(() => server.close())

  server.get("/outside", async request => ({ owner: getOwner(request) }))
  await server.ready()

  const response = await server.inject({ method: "GET", url: "/outside" })

  assert.equal(response.statusCode, 500)
  assert.equal(response.json().code, "FST_ERR_DEC_UNDECLARED")
})
