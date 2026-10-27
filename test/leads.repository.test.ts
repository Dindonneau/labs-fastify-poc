import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mongodb } from "@fastify/mongodb"
import { mongoLeadsRepository } from "../src/repositories/leads.ts"

// No Fastify here: the repository does not know that an HTTP server exists.
// The driver comes through @fastify/mongodb, which re-exports it, so this test
// imports nothing the package.json does not declare. Its own database, as
// every test file has: they run in parallel and each one empties a collection.
const url = "mongodb://127.0.0.1:27017/fastify-poc-test-repository"
const client = new mongodb.MongoClient(url)
const db = client.db()
const repository = mongoLeadsRepository(db)

beforeEach(() => db.collection("leads").deleteMany({}))
after(() => client.close())

test("create hands back the lead with the id Mongo gave it, as a string", async () => {
  const lead = await repository.create({
    email: "unicorn@rainbow.com",
    firstName: "Unicorn"
  })

  assert.equal(typeof lead.id, "string")
  assert.match(lead.id, /^[0-9a-f]{24}$/)
  assert.equal(lead.email, "unicorn@rainbow.com")
  assert.equal(lead.firstName, "Unicorn")
})

test("list hands back strings too: no ObjectId crosses the boundary", async () => {
  await repository.create({ email: "unicorn@rainbow.com" })

  const [lead, ...rest] = await repository.list()

  assert.equal(rest.length, 0)
  assert.equal(typeof lead?.id, "string")
  assert.deepEqual(Object.keys(lead ?? {}).sort(), ["email", "id"])
})

test("what is stored keeps Mongo's own _id: the mapping is on the way out", async () => {
  const lead = await repository.create({ email: "unicorn@rainbow.com" })

  const stored = await db.collection("leads").findOne({})

  assert.equal(stored?._id.toHexString(), lead.id)
  assert.equal(stored?.id, undefined)
})

test("list is empty when nothing was created", async () => {
  assert.deepEqual(await repository.list(), [])
})
