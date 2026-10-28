import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { mongodb } from "@fastify/mongodb"
import { mongoLeadsRepository } from "../src/repositories/leads.ts"
import { testDatabase } from "./database.ts"

// No Fastify here: the repository does not know that an HTTP server exists.
// The driver comes through @fastify/mongodb, which re-exports it, so this test
// imports nothing the package.json does not declare. Its own database, as
// every test file has: they run in parallel and each one empties a collection.
const url = testDatabase()
const client = new mongodb.MongoClient(url)
const db = client.db()
const repository = await mongoLeadsRepository(db)

const unicorn = "unicorn"
const rainbow = "rainbow"

beforeEach(() => db.collection("leads").deleteMany({}))
after(() => client.close())

test("create hands back the lead with the id Mongo gave it, as a string", async () => {
  const lead = await repository.create(unicorn, {
    email: "unicorn@rainbow.com",
    firstName: "Unicorn"
  })

  assert.equal(typeof lead.id, "string")
  assert.match(lead.id, /^[0-9a-f]{24}$/)
  assert.equal(lead.email, "unicorn@rainbow.com")
  assert.equal(lead.firstName, "Unicorn")
})

test("list hands back strings too: no ObjectId crosses the boundary", async () => {
  await repository.create(unicorn, { email: "unicorn@rainbow.com" })

  const [lead, ...rest] = await repository.list(unicorn)

  assert.equal(rest.length, 0)
  assert.equal(typeof lead?.id, "string")
  assert.deepEqual(Object.keys(lead ?? {}).sort(), ["email", "id"])
})

test("what is stored keeps Mongo's own _id: the mapping is on the way out", async () => {
  const lead = await repository.create(unicorn, {
    email: "unicorn@rainbow.com"
  })

  const stored = await db.collection("leads").findOne({})

  assert.equal(stored?._id.toHexString(), lead.id)
  assert.equal(stored?.id, undefined)
})

test("list is empty when nothing was created", async () => {
  assert.deepEqual(await repository.list(unicorn), [])
})

// The point of the whole step: one owner's leads are another's nothing.
test("a lead belongs to the owner who created it, and to no one else", async () => {
  await repository.create(unicorn, { email: "unicorn@rainbow.com" })

  assert.equal((await repository.list(unicorn)).length, 1)
  assert.deepEqual(await repository.list(rainbow), [])
})

test("two owners keep their own leads side by side", async () => {
  await repository.create(unicorn, { email: "unicorn@rainbow.com" })
  await repository.create(rainbow, { email: "rainbow@unicorn.com" })

  assert.deepEqual(
    (await repository.list(unicorn)).map(lead => lead.email),
    ["unicorn@rainbow.com"]
  )
  assert.deepEqual(
    (await repository.list(rainbow)).map(lead => lead.email),
    ["rainbow@unicorn.com"]
  )
})

// The owner is stored, because that is what the filter reads — but the
// projection keeps it from travelling back out.
test("ownerId is stored but never handed back", async () => {
  const lead = await repository.create(unicorn, {
    email: "unicorn@rainbow.com"
  })

  const stored = await db.collection("leads").findOne({})

  assert.equal(stored?.ownerId, unicorn)
  assert.equal("ownerId" in lead, false)
})
