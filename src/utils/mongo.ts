import type { mongodb, ObjectId } from "@fastify/mongodb"

export type Doc = mongodb.Document

export type MongoModel<T extends Doc> = Omit<T, "_id" | "id">
export type MongoDoc<T extends Doc> = T & { _id: ObjectId }

export type ApiDoc<T extends Doc> = Omit<T, "_id"> & { id: string }

export const swapMongoId = <T extends Doc>(
  mongoDocument: MongoDoc<T>
): ApiDoc<T> => {
  const { _id, ...restOfDocument } = mongoDocument
  // id last: a document that already carries one must not win over the real _id
  return { ...restOfDocument, id: _id.toString() }
}
