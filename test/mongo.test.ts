import assert from "node:assert/strict"
import { test } from "node:test"
import { ObjectId } from "@fastify/mongodb"
import { swapMongoId } from "../src/utils/mongo.ts"

// No database here: swapMongoId is a pure function, so a hand-made ObjectId
// is enough to pin what it promises.

test("_id becomes a string called id, and the other fields are kept", () => {
  const _id = new ObjectId()

  const document = swapMongoId({ _id, email: "unicorn@rainbow.com" })

  assert.deepEqual(document, {
    id: _id.toHexString(),
    email: "unicorn@rainbow.com"
  })
})

test("no _id leaves: an ObjectId never crosses the boundary", () => {
  const document = swapMongoId({ _id: new ObjectId(), colour: "pink" })

  assert.equal("_id" in document, false)
  assert.equal(typeof document.id, "string")
})

// Nothing can store an id today: MongoModel omits it and the body schema
// strips it. The guarantee is for the next entity, not for leads.
test("a stored id does not win over the real _id", () => {
  const _id = new ObjectId()

  const document = swapMongoId({ _id, id: "pink" })

  assert.equal(document.id, _id.toHexString())
})
