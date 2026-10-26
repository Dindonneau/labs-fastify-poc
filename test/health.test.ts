import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import app from "../src/app.ts"

// Builds the application as the server does, but with the options a test
// chooses. inject() then plays an HTTP request against it: no port is opened.
async function build(serviceName: string) {
  const server = Fastify()
  await server.register(app, { serviceName })
  return server
}

test("GET /health answers ok, with the service name it was given", async t => {
  const server = await build("test-service")
  t.after(() => server.close())

  const response = await server.inject({ method: "GET", url: "/health" })

  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers["content-type"]), /^application\/json/)
  assert.deepEqual(response.json(), { status: "ok", service: "test-service" })
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

test("an unknown route is a 404: no catch-all route answers in its place", async t => {
  const server = await build("test-service")
  t.after(() => server.close())

  const response = await server.inject({ method: "GET", url: "/nowhere" })

  assert.equal(response.statusCode, 404)
})
