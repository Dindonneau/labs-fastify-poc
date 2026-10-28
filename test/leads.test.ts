import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import fp from "fastify-plugin"
import app from "../src/app.ts"
import { testDatabase } from "./database.ts"

const mongoUrl = testDatabase()

// fp() lifts app out of its own scope, so that a test can reach server.mongo
// and empty the collection. This file has that database to itself, and every
// test in it starts from an empty collection.
// Every request goes through this, so swapping the header for a signed token
// later is a change here and nowhere else.
const asOwner = (ownerId: string) => ({ "x-owner-id": ownerId })

const unicorn = asOwner("unicorn")
const rainbow = asOwner("rainbow")

async function build() {
  const server = Fastify()
  await server.register(fp(app), { serviceName: "test-service", mongoUrl })
  await server.mongo.db?.collection("leads").deleteMany({})
  return server
}

test("POST /leads creates a lead and answers 201 with the id Mongo gave it", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com", firstName: "Unicorn" }
  })

  assert.equal(response.statusCode, 201)
  const lead = response.json()
  assert.equal(lead.email, "unicorn@rainbow.com")
  assert.equal(lead.firstName, "Unicorn")
  assert.match(lead.id, /^[0-9a-f]{24}$/)
})

test("a created lead is then listed by GET /leads", async t => {
  const server = await build()
  t.after(() => server.close())

  const created = await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com" }
  })
  const response = await server.inject({
    method: "GET",
    url: "/leads",
    headers: unicorn
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), [
    { id: created.json().id, email: "unicorn@rainbow.com" }
  ])
})

test("GET /leads is an empty array when nothing was created", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await server.inject({
    method: "GET",
    url: "/leads",
    headers: unicorn
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), [])
})

test("firstName is optional", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com" }
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(Object.keys(response.json()).sort(), ["email", "id"])
})

// The body schema answers before the handler runs: nothing reaches Mongo.
for (const [what, payload] of [
  ["no email", { firstName: "Unicorn" }],
  ["an email that is not one", { email: "unicorn" }],
  ["an empty firstName", { email: "unicorn@rainbow.com", firstName: "" }]
] as const) {
  test(`a lead with ${what} is refused with a 400, and nothing is stored`, async t => {
    const server = await build()
    t.after(() => server.close())

    const response = await server.inject({
      method: "POST",
      url: "/leads",
      headers: unicorn,
      payload
    })

    assert.equal(response.statusCode, 400)
    const listed = await server.inject({
      method: "GET",
      url: "/leads",
      headers: unicorn
    })
    assert.deepEqual(listed.json(), [])
  })
}

// Fastify runs ajv with removeAdditional, so additionalProperties: false
// strips what it does not declare instead of answering 400.
test("a field the schema does not declare is dropped, not refused", async t => {
  const server = await build()
  t.after(() => server.close())

  const response = await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com", colour: "pink" }
  })

  assert.equal(response.statusCode, 201)
  assert.equal(response.json().colour, undefined)

  const stored = await server.mongo.db?.collection("leads").findOne({})
  assert.equal(stored?.colour, undefined)
})

test("an id sent by the client is ignored: Mongo gives the real one", async t => {
  const server = await build()
  t.after(() => server.close())

  const chosen = "0".repeat(24)
  const response = await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com", id: chosen }
  })

  assert.equal(response.statusCode, 201)
  assert.notEqual(response.json().id, chosen)
})

test("the application refuses to start when MONGO_URL names no database", async t => {
  const server = Fastify()
  // The connection did open, so it must be closed even though the boot failed
  t.after(() => server.close())
  server.register(app, {
    serviceName: "test-service",
    mongoUrl: "mongodb://127.0.0.1:27017"
  })

  await assert.rejects(async () => {
    await server.ready()
  }, /MONGO_URL must name a database/)
})

// What the whole step is for: the owner comes from the request, never from
// the body, and it decides what the caller is allowed to see.
test("a lead created by one owner is invisible to another", async t => {
  const server = await build()
  t.after(() => server.close())

  await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com" }
  })

  const mine = await server.inject({
    method: "GET",
    url: "/leads",
    headers: unicorn
  })
  const theirs = await server.inject({
    method: "GET",
    url: "/leads",
    headers: rainbow
  })

  assert.equal(mine.json().length, 1)
  assert.deepEqual(theirs.json(), [])
})

test("an ownerId sent in the body is ignored: the header decides", async t => {
  const server = await build()
  t.after(() => server.close())

  await server.inject({
    method: "POST",
    url: "/leads",
    headers: unicorn,
    payload: { email: "unicorn@rainbow.com", ownerId: "rainbow" }
  })

  const theirs = await server.inject({
    method: "GET",
    url: "/leads",
    headers: rainbow
  })

  assert.deepEqual(theirs.json(), [])
})

for (const [what, headers] of [
  ["no x-owner-id at all", {}],
  ["an empty x-owner-id", { "x-owner-id": "" }],
  ["a blank x-owner-id", { "x-owner-id": "   " }]
] as const) {
  test(`a request with ${what} is answered 401`, async t => {
    const server = await build()
    t.after(() => server.close())

    const response = await server.inject({
      method: "GET",
      url: "/leads",
      headers
    })

    assert.equal(response.statusCode, 401)
  })
}
