import { ObjectId, type mongodb } from "@fastify/mongodb"
import type { DistributiveOmit, Prettify } from "./types.ts"

export type Doc = mongodb.Document

// Every Omit here goes through DistributiveOmit: a job is a union of one shape
// per status, and a plain Omit would quietly keep only the fields all four
// share. Prettify and MongoJSON are mapped types, which distribute by
// themselves, and an intersection distributes too.
export type MongoModel<T extends Doc> = Prettify<
  DistributiveOmit<T, "_id" | "id">
>

export type MongoDoc<T extends Doc> = Prettify<T & { _id: ObjectId }>

// What a stored value is once JSON has carried it. JSON holds neither a Date
// nor an ObjectId, so the conversion is decided by the value's type and never
// by a field name — which is why this direction needs nothing declared for it,
// unlike the way in. It is also why it recurses: a date two levels down is
// still a date.
//
// The conditional distributes over the union, so an optional Date becomes an
// optional string instead of staying a Date, and the mapped type is
// homomorphic, so readonly, optional, arrays and tuples all come through. An
// `T extends Array<infer U>` branch would be redundant with that, and would
// flatten a tuple [Date, number] into (string | number)[].
//
// The `_bsontype` branch is what keeps the type level and the runtime saying
// the same thing: every BSON class carries that getter, so a Binary, a
// Decimal128 or a Long is left alone here exactly as isPlainObject leaves it
// alone below. Without the branch, the type maps over the instance's own
// properties while the code hands it back untouched.
type MongoJSONValue<V> = V extends Date
  ? string
  : V extends ObjectId
    ? string
    : V extends { _bsontype: string }
      ? V
      : V extends object
        ? { [K in keyof V]: MongoJSONValue<V[K]> }
        : V

// A document is known to be an object, so its own level is a mapped type
// rather than one more conditional: a deferred conditional cannot be spread,
// and mongoToApi below has to spread its result.
export type MongoJSON<T> = { [K in keyof T]: MongoJSONValue<T[K]> }

export type MongoToApiDoc<T extends Doc> = Prettify<
  MongoJSON<DistributiveOmit<T, "_id">> & { id: string }
>

export type ApiToMongoDoc<T extends Doc> = Prettify<
  DistributiveOmit<T, "id"> & { _id: ObjectId }
>

// Only an object with Object.prototype is walked into. A BSON Binary,
// Decimal128 or Long taken apart field by field would not survive it, and
// neither would a Date or an ObjectId — which is why those two are answered
// before this is ever asked.
const isPlainObject = (value: unknown): value is Doc =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype

// Deliberately untyped: a recursion that walks an unknown document cannot
// carry MongoJSON<T> through its own calls without an assertion at every
// return. There is one instead, where its result is used.
const serialize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString()
  if (value instanceof ObjectId) return value.toHexString()
  if (Array.isArray(value)) return value.map(serialize)

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialize(item)])
    )
  }

  return value
}

// Named for what it answers rather than for one of the things it does: Mongo's
// _id becomes the API's id, and every Date and ObjectId underneath becomes a
// string. The type it returns says the same thing.
// The parameter is the document itself rather than MongoDoc<T>: inferring T
// from inside T & { _id } makes TypeScript pick a single branch when it is
// handed a union, and a job is a union of four. Constrained here instead, T
// binds to the whole of what it was given.
export const mongoToApi = <T extends MongoDoc<Doc>>(
  mongoDocument: T
): MongoToApiDoc<T> => {
  const { _id, ...restOfDocument } = mongoDocument

  // The one assertion in the data layer: TypeScript cannot prove that an object
  // rebuilt key by key matches a mapped type — mapped types serve inference,
  // not construction.
  const fields = serialize(restOfDocument) as MongoJSON<
    DistributiveOmit<T, "_id">
  >

  // id last: a document that already carries one must not win over the real _id
  return { ...fields, id: _id.toString() }
}

// @fastify/mongodb leaves db undefined when the URL names no database. The
// message names MONGO_URL although this is a util, because it is read as a
// boot failure: it should say what to fix, not which layer noticed.
export const requireDb = (db: mongodb.Db | undefined): mongodb.Db => {
  if (!db) throw new Error("MONGO_URL must name a database")
  return db
}
