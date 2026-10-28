import type { mongodb, ObjectId } from "@fastify/mongodb"
import type { Prettify } from "./types.ts"

export type Doc = mongodb.Document

export type MongoModel<T extends Doc> = Prettify<Omit<T, "_id" | "id">>

export type MongoDoc<T extends Doc> = Prettify<T & { _id: ObjectId }>

export type MongoToApiDoc<T extends Doc> = Prettify<
  Omit<T, "_id"> & { id: string }
>

export type ApiToMongoDoc<T extends Doc> = Prettify<
  Omit<T, "id"> & { _id: ObjectId }
>

export const swapMongoId = <T extends Doc>(
  mongoDocument: MongoDoc<T>
): MongoToApiDoc<T> => {
  const { _id, ...restOfDocument } = mongoDocument
  // id last: a document that already carries one must not win over the real _id
  return { ...restOfDocument, id: _id.toString() }
}

// @fastify/mongodb leaves db undefined when the URL names no database. The
// message names MONGO_URL although this is a util, because it is read as a
// boot failure: it should say what to fix, not which layer noticed.
export const requireDb = (db: mongodb.Db | undefined): mongodb.Db => {
  if (!db) throw new Error("MONGO_URL must name a database")
  return db
}
