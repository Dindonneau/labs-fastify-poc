import assert from "node:assert/strict"
import { test } from "node:test"
import { mongodb, ObjectId } from "@fastify/mongodb"
import { requireDb, mongoToApi } from "../src/utils/mongo.ts"

// No database here: mongoToApi is a pure function, so a hand-made ObjectId
// is enough to pin what it promises.

test("_id becomes a string called id, and the other fields are kept", () => {
  const _id = new ObjectId()

  const document = mongoToApi({ _id, email: "unicorn@rainbow.com" })

  assert.deepEqual(document, {
    id: _id.toHexString(),
    email: "unicorn@rainbow.com"
  })
})

test("no _id leaves: an ObjectId never crosses the boundary", () => {
  const document = mongoToApi({ _id: new ObjectId(), colour: "pink" })

  assert.equal("_id" in document, false)
  assert.equal(typeof document.id, "string")
})

// Nothing can store an id today: MongoModel omits it and the body schema
// strips it. The guarantee is for the next entity, not for leads.
test("a stored id does not win over the real _id", () => {
  const _id = new ObjectId()

  const document = mongoToApi({ _id, id: "pink" })

  assert.equal(document.id, _id.toHexString())
})

// JSON has no Date, so the conversion is keyed on the value's type and not on
// a list of field names: nothing has to be declared for a new dated field.
test("a Date becomes its ISO string, whatever the field is called", () => {
  const createdAt = new Date("2026-11-05T10:00:00.000Z")

  const document = mongoToApi({ _id: new ObjectId(), createdAt })

  assert.equal(document.createdAt, "2026-11-05T10:00:00.000Z")
})

test("every Date in the document is converted, not only the first", () => {
  const document = mongoToApi({
    _id: new ObjectId(),
    createdAt: new Date("2026-11-05T10:00:00.000Z"),
    startedAt: new Date("2026-11-05T11:00:00.000Z"),
    email: "unicorn@rainbow.com"
  })

  assert.deepEqual(
    [document.createdAt, document.startedAt, document.email],
    [
      "2026-11-05T10:00:00.000Z",
      "2026-11-05T11:00:00.000Z",
      "unicorn@rainbow.com"
    ]
  )
})

// A date two levels down is still a date. The difference does not show over
// HTTP — Date and ObjectId both have a toJSON, so the serialiser finishes the
// job — but it shows to whoever reads the object in memory, which is what the
// export worker does.
test("a Date nested in a sub-document is converted too", () => {
  const at = new Date("2026-11-05T10:00:00.000Z")

  const document = mongoToApi({ _id: new ObjectId(), inner: { at } })

  assert.equal(document.inner.at, "2026-11-05T10:00:00.000Z")
})

test("a Date inside an array is converted", () => {
  const document = mongoToApi({
    _id: new ObjectId(),
    runs: [{ at: new Date("2026-11-05T10:00:00.000Z") }]
  })

  assert.deepEqual(document.runs, [{ at: "2026-11-05T10:00:00.000Z" }])
})

// An ObjectId that is not the document's own _id: a reference to another
// document, which the next step will have.
test("a nested ObjectId becomes its hexadecimal string", () => {
  const leadId = new ObjectId()

  const document = mongoToApi({ _id: new ObjectId(), leadId })

  assert.equal(document.leadId, leadId.toHexString())
})

// The pass walks into an object with Object.prototype and nothing else. A BSON
// value taken apart field by field would not survive the trip.
test("a BSON value that is not a plain object comes out intact", () => {
  const amount = mongodb.Decimal128.fromString("1.25")

  const document = mongoToApi({ _id: new ObjectId(), amount })

  assert.equal(document.amount, amount)
  assert.equal(document.amount.toString(), "1.25")
})

test("a document with no Date at all comes out unchanged", () => {
  const _id = new ObjectId()

  const document = mongoToApi({ _id, progress: { processed: 0, total: 3 } })

  assert.deepEqual(document, {
    id: _id.toHexString(),
    progress: { processed: 0, total: 3 }
  })
})

test("requireDb hands back the database it was given", () => {
  // A stand-in: requireDb only cares that something is there
  const db = {} as mongodb.Db

  assert.equal(requireDb(db), db)
})

// The message is what someone reads when the boot fails, so it is part of
// what this function promises: it has to say what to fix.
test("requireDb refuses undefined, and names what to fix", () => {
  assert.throws(() => requireDb(undefined), /MONGO_URL must name a database/)
})
