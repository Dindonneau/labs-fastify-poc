import { ObjectId, type mongodb } from "@fastify/mongodb"
import type { JobKindType, JobType, PendingJobType } from "../schemas/job.ts"
import {
  mongoToApi,
  type ApiToMongoDoc,
  type MongoModel
} from "../utils/mongo.ts"
import type { Override } from "../utils/types.ts"

// MongoDB holds a real Date, so that a query can compare it and an index can
// order it; the API answers the ISO string of it. Naming createdAt here is the
// whole cost of having a date: the way out needs nothing, because mongoToApi
// converts every Date it is handed, by its type and not by its name.
//
// Forgetting this line is a compiler error and not a silent one: the model
// would promise a string where create() writes a Date.
type JobMongoModel = Override<MongoModel<JobType>, { createdAt: Date }> & {
  ownerId: string
}
type JobClientDoc = Override<ApiToMongoDoc<JobType>, { createdAt: Date }>

// The seam, as for leads: the routes depend on this and not on a database.
// Every method takes the owner and the kind, so a job can be reached neither
// by another owner nor through the route of another kind.
export interface JobsRepository {
  // A job is born pending, and the type says so: nothing in this step moves it.
  // findById answers any of the four, because by then it could be any of them.
  create(
    ownerId: string,
    kind: JobKindType,
    total: number
  ): Promise<PendingJobType>
  findById(
    ownerId: string,
    kind: JobKindType,
    id: string
  ): Promise<JobType | null>
}

// Asynchronous like every repository here, because building one may have to
// touch the database — the leads repository creates its index that way. This
// one has nothing to prepare yet: reading a job by its id rides the _id index
// MongoDB creates by itself, and the worker's claim query is what will earn
// { status, createdAt }, in the worker's own step. Uniform rather than exact,
// so that adding it later changes this file and not the route.
export async function mongoJobsRepository(
  db: mongodb.Db
): Promise<JobsRepository> {
  const collection = db.collection<JobMongoModel>("jobs")

  return {
    async create(ownerId, kind, total) {
      // A job is born pending with nothing processed. The owner is added on
      // the way to the collection and not here, so what comes back out cannot
      // carry it: insertOne writes _id into the object it is handed, which is
      // why it is handed a copy.
      const job = {
        kind,
        status: "pending" as const,
        progress: { processed: 0, total },
        createdAt: new Date()
      }

      const { insertedId } = await collection.insertOne({ ...job, ownerId })
      return mongoToApi({ ...job, _id: insertedId })
    },

    async findById(ownerId, kind, id) {
      // The route validates the id against a pattern, so this cannot be
      // reached with a malformed one — through HTTP. The worker will call this
      // repository with no schema in front of it, and new ObjectId() throws on
      // anything that is not 24 hexadecimal characters.
      if (!ObjectId.isValid(id)) return null

      // Three conditions, one answer: a job that does not exist, one that
      // belongs to someone else and one of another kind are indistinguishable
      // from here, which is what keeps the route from telling them apart.
      const document = await collection.findOne<JobClientDoc>(
        { _id: new ObjectId(id), ownerId, kind },
        { projection: { ownerId: 0 } }
      )

      return document && mongoToApi(document)
    }
  }
}
