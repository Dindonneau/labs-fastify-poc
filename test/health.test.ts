import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import fp from "fastify-plugin"
import app from "../src/app.ts"

// Builds the application as the server does, but with the options a test
// chooses. inject() then plays an HTTP request against it: no port is opened.
// The tests use a database of their own, so they never touch real data. It
// needs a MongoDB running locally; MongoDB creates it on first write.
const mongoUrl = "mongodb://127.0.0.1:27017/fastify-poc-test"

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
  assert.deepEqual(response.json(), { status: "ok", service: "test-service", database: "up" })
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

  server.register(app, { serviceName: "test-service", mongoUrl: "mongodb://127.0.0.1:1/unicorn" })

  await assert.rejects(
    async () => {
      await server.ready()
    },
    { name: "MongoServerSelectionError" }
  )
})

test("a database URL without a database name still reports the database as up", async t => {
  const server = Fastify()
  await server.register(app, { serviceName: "test-service", mongoUrl: "mongodb://127.0.0.1:27017" })
  t.after(() => server.close())

  const response = await server.inject({ method: "GET", url: "/health" })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().database, "up")
})

test("an unknown route is a 404: no catch-all route answers in its place", async t => {
  const server = await build("test-service")
  t.after(() => server.close())

  const response = await server.inject({ method: "GET", url: "/nowhere" })

  assert.equal(response.statusCode, 404)
})
