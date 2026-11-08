import { ObjectId, type mongodb } from "@fastify/mongodb"
import type {
  JobKindType,
  JobType,
  PendingJobType,
  RunningJobType
} from "../schemas/job.ts"
import {
  mongoToApi,
  type ApiToMongoDoc,
  type MongoModel
} from "../utils/mongo.ts"
import type { Override } from "../utils/types.ts"

// MongoDB holds real Dates, so that a query can compare them and an index can
// order them; the API answers the ISO strings of them. Naming the three here
// is the whole cost of having dates: the way out needs nothing, because
// mongoToApi converts every Date it is handed, by its type and not by its
// name. Override replaces only the fields a branch already has, so a pending
// job does not acquire a startedAt from this line.
//
// Forgetting it is a compiler error and not a silent one: the model would
// promise a string where the code writes a Date.
type StoredDates = {
  createdAt: Date
  startedAt: Date
  finishedAt: Date
}

type JobMongoModel = Override<MongoModel<JobType>, StoredDates> & {
  ownerId: string
}
type JobClientDoc = Override<ApiToMongoDoc<JobType>, StoredDates>

// A claimed job and the owner whose data it is about. The owner is handed
// back here and nowhere else: the worker has to know whose leads to export,
// and unlike a request it is acting for no one. Returned as a pair rather
// than folded into the job, so that the exception is visible where it is used
// instead of hiding inside a document shape that travels.
export interface ClaimedJob {
  job: RunningJobType
  ownerId: string
}

// The seam, as for leads: the routes depend on this and not on a database.
//
// The first two methods take the owner, because a request has one and may
// only see its own. The ones below do not: the worker runs everyone's jobs.
// They address a job by the id the claim handed back, so none of them can
// reach a job that was not claimed first.
export interface JobsRepository {
  // A job is born pending, and the type says so. findById answers any of the
  // four, because by the time it is read it could be any of them.
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

  claimNext(kind: JobKindType): Promise<ClaimedJob | null>
  recordProgress(id: string, processed: number): Promise<void>
  finish(id: string): Promise<void>
  fail(id: string, error: string): Promise<void>
}

// Asynchronous because a repository prepares its collection when it is built,
// and this one now has something to prepare. The claim below filters on status
// and orders by createdAt, which is the query that earns this index — reading
// a job by its id still rides the _id index MongoDB creates by itself.
// createIndex is idempotent, so calling it on every build costs nothing.
export async function mongoJobsRepository(
  db: mongodb.Db
): Promise<JobsRepository> {
  const collection = db.collection<JobMongoModel>("jobs")
  await collection.createIndex({ status: 1, createdAt: 1 })

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
      // reached with a malformed one — through HTTP. The worker calls this
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
    },

    async claimNext(kind) {
      // One operation, not two. A findOne followed by an updateOne would be a
      // race: two loops — or the same one restarted beside itself — would read
      // the same pending job and run it twice. MongoDB guarantees atomicity on
      // a single document, which is all a queue needs to hand each job out
      // once. The oldest goes first, which is the sort this index serves.
      const document = await collection.findOneAndUpdate(
        { status: "pending", kind },
        { $set: { status: "running", startedAt: new Date() } },
        { sort: { createdAt: 1 }, returnDocument: "after" }
      )

      // Nothing was pending. The worker asks again on its next tick.
      if (!document) return null

      // Not a guard but a narrowing: returnDocument "after" hands back what
      // the $set just wrote, and this is how the compiler learns which of the
      // four shapes it is holding. No test reaches the line below, because
      // nothing can.
      //
      // It throws rather than answering null because null is taken: it means
      // "nothing was pending" one line above, and the worker reads it as the
      // signal to stop draining and wait for the next tick. Answering it here
      // would make the one case where a job is left `running` with no one on
      // it indistinguishable from the case where all is quiet. A throw lands
      // in the loop's catch, where it is logged and the loop rearms.
      if (document.status !== "running") {
        throw new Error(
          `claimed job ${document._id.toHexString()} is not running`
        )
      }

      const { ownerId, ...job } = document
      return { job: mongoToApi(job), ownerId }
    },

    // The three below address a job by the id the claim handed back, so they
    // need no owner and no kind: whoever holds that id has already been given
    // the job by the only method that hands one out.
    //
    // They all filter on `status: "running"` as well, because an id alone says
    // nothing about *when* it was handed out. Without it, finish() would move
    // a job that had already failed back to done, and a late recordProgress
    // would write into a job that is over. With it, each is a no-op on a job
    // that is no longer the worker's to advance.
    //
    // It is not a lease. Once a job can be reclaimed from a worker presumed
    // dead — _What comes next_ in the README — two workers would both see
    // `running` and this filter would stop neither: it would take a claim
    // token, a worker id or an attempt number, in the filter and in the $set.
    async recordProgress(id, processed) {
      await collection.updateOne(
        { _id: new ObjectId(id), status: "running" },
        { $set: { "progress.processed": processed } }
      )
    },

    async finish(id) {
      await collection.updateOne(
        { _id: new ObjectId(id), status: "running" },
        { $set: { status: "done", finishedAt: new Date() } }
      )
    },

    async fail(id, error) {
      // The message is the worker's own. Nothing a client sent reaches it,
      // and nothing a driver threw does either: the caller decides what is
      // safe to write down.
      await collection.updateOne(
        { _id: new ObjectId(id), status: "running" },
        { $set: { status: "failed", finishedAt: new Date(), error } }
      )
    }
  }
}
