import type { mongodb } from "@fastify/mongodb"
import type { LeadType, NewLeadType } from "../schemas/lead.ts"
import { swapMongoId, type MongoModel } from "../utils/mongo.ts"

type LeadMongoModel = MongoModel<LeadType>

// The seam: the routes depend on this, not on a database
export interface LeadsRepository {
  create(lead: NewLeadType): Promise<LeadType>
  list(): Promise<LeadType[]>
}

// The driver is reached through @fastify/mongodb, which re-exports it: it is
// the declared dependency, mongodb itself only arrives underneath it.
export function mongoLeadsRepository(db: mongodb.Db): LeadsRepository {
  const collection = db.collection<LeadMongoModel>("leads")

  return {
    async create(lead) {
      // insertOne writes _id into the object it is handed. That object is
      // the request body here, so the spread keeps the mutation on a copy.
      const { insertedId } = await collection.insertOne({ ...lead })
      return swapMongoId({ ...lead, _id: insertedId })
    },

    async list() {
      // No limit on purpose: a page belongs with the owner filter of the
      // next step, since what it holds depends on who is asking.
      const documents = await collection.find().toArray()
      return documents.map(swapMongoId)
    }
  }
}
