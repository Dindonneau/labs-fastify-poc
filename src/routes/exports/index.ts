import type { FastifyPluginAsync } from "fastify"
import identity, { getOwner } from "../../plugins/identity.ts"
import { mongoJobsRepository } from "../../repositories/jobs.ts"
import { mongoLeadsRepository } from "../../repositories/leads.ts"
import { ApiError, type ApiErrorType } from "../../schemas/error.ts"
import {
  Job,
  JobId,
  PendingJob,
  type JobIdType,
  type JobType,
  type PendingJobType
} from "../../schemas/job.ts"
import { requireDb } from "../../utils/mongo.ts"

// The route is /exports because that is what a client asks for; the collection
// is jobs because that is what the worker will drain. One kind of job is
// created here, and reaching a job of another kind through this route is not
// possible: the kind is part of every query.
const KIND = "leadsExport"

const exportJobs: FastifyPluginAsync = async fastify => {
  // Registered here, as in the leads routes: the hook guards this scope only,
  // which is how /health stays reachable without a header.
  await fastify.register(identity)

  const db = requireDb(fastify.mongo.db)
  const jobs = await mongoJobsRepository(db)
  const leads = await mongoLeadsRepository(db)

  // 202 and not 201: the job exists, and nothing has run it. Location is where
  // its progress will be readable, which is the only promise this answer makes.
  //
  // No body schema, although the project declares one everywhere else, because
  // there is no body: a declared `Type.Object({})` answers 400 "body must be
  // object" to a POST sent without one, which is how this route is called.
  // The answer is a pending job, not a job: the narrower branch is what the
  // schema declares, so a job of any other status could not be answered here.
  fastify.post<{ Reply: { 202: PendingJobType } }>(
    "/",
    { schema: { response: { 202: PendingJob } } },
    async (request, reply) => {
      const owner = getOwner(request)
      const total = await leads.count(owner)
      const job = await jobs.create(owner, KIND, total)

      // code() last, and on its own line: it is what narrows what send()
      // accepts to the body this status code declares, and a header() in
      // between hands back a reply that has forgotten the code.
      reply.header("location", `/exports/${job.id}`)
      return reply.code(202).send(job)
    }
  )

  fastify.get<{
    Params: JobIdType
    Reply: { 200: JobType; 404: ApiErrorType }
  }>(
    "/:id",
    { schema: { params: JobId, response: { 200: Job, 404: ApiError } } },
    async (request, reply) => {
      const job = await jobs.findById(
        getOwner(request),
        KIND,
        request.params.id
      )

      // 404 and not 403 for a job that belongs to someone else: a 403 would
      // confirm that it exists. The repository hands back the same null for a
      // job that is absent, one that is another owner's and one of another
      // kind, so this answer cannot accidentally tell them apart.
      if (!job) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "No such export"
        })
      }

      return reply.code(200).send(job)
    }
  )
}

export default exportJobs
