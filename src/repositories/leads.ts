import type { mongodb } from "@fastify/mongodb"
import type { LeadType, NewLeadType } from "../schemas/lead.ts"
import {
  mongoToApi,
  type ApiToMongoDoc,
  type MongoModel
} from "../utils/mongo.ts"

type LeadMongoModel = MongoModel<LeadType> & { ownerId: string }
type LeadClientDoc = ApiToMongoDoc<LeadType>

// The seam: the routes depend on this, not on a database. Every method takes
// the owner, so none of them can be called without one.
export interface LeadsRepository {
  create(ownerId: string, lead: NewLeadType): Promise<LeadType>
  list(ownerId: string): Promise<LeadType[]>
  count(ownerId: string): Promise<number>

  // What list() cannot be for the worker. Declared as AsyncIterable rather
  // than as the generator the implementation happens to be: a caller only ever
  // walks it, and an array is as valid a way of answering this as a cursor.
  stream(ownerId: string): AsyncIterable<LeadType>
}

// The driver is reached through @fastify/mongodb, which re-exports it: it is
// the declared dependency, mongodb itself only arrives underneath it.
//
// Asynchronous because the collection is prepared here rather than by whoever
// builds the repository: every query filters on ownerId, so it earns the
// project's first index — _id is the only one MongoDB creates by itself.
// createIndex is idempotent, so calling it on every build costs nothing.
export async function mongoLeadsRepository(
  db: mongodb.Db
): Promise<LeadsRepository> {
  const collection = db.collection<LeadMongoModel>("leads")
  await collection.createIndex({ ownerId: 1 })

  return {
    async create(ownerId, lead) {
      // insertOne writes _id into the object it is handed, so it is given a
      // copy and never the request body. The owner is added here, not by the
      // client: the body schema has no place for it.
      const { insertedId } = await collection.insertOne({ ...lead, ownerId })
      return mongoToApi({ ...lead, _id: insertedId })
    },

    async list(ownerId) {
      // The projection drops ownerId before it can travel: the caller knows
      // who they are, and nothing above this line should hold it.
      const documents = await collection
        .find<LeadClientDoc>({ ownerId }, { projection: { ownerId: 0 } })
        .toArray()
      return documents.map(mongoToApi)
    },

    // What an export's progress is counted out of. It goes through the ownerId
    // index and loads no document, where list(ownerId).length would read every
    // lead to arrive at the same number.
    async count(ownerId) {
      return collection.countDocuments({ ownerId })
    },

    // The same query as list(), without the toArray() that makes it unusable
    // past a certain size: the cursor keeps one batch in memory whether the
    // owner has ten leads or five million, and the caller gets them one at a
    // time. list() stays for the route, which answers a JSON array and so has
    // to hold the whole of it anyway.
    //
    // mongoToApi is applied here and not by the caller, so the driver's types
    // stop at this line in this direction too.
    async *stream(ownerId) {
      const cursor = collection.find<LeadClientDoc>(
        { ownerId },
        { projection: { ownerId: 0 } }
      )

      for await (const document of cursor) yield mongoToApi(document)
    }
  }
}
