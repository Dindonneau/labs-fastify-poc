import Type from "typebox"

// One collection holds every kind of job, so a worker can claim whatever is
// pending of the kind it knows how to run. One kind exists today, and a union
// of one is not a mistake: it is what makes the second kind a compiler error
// everywhere it is not handled yet.
//
// The field is `kind` and not `type` because the schema constant would then be
// `JobType`, which is the name the job document's own derived type needs.
export const JobKind = Type.Union([Type.Literal("leadsExport")])

export type JobKindType = Type.Static<typeof JobKind>

// total is a snapshot, counted when the job is created: a lead created after
// that is not part of this export. Saying so is the point of counting it here
// rather than leaving it at 0 — a progress out of 0 means nothing to read.
export const Progress = Type.Object({
  processed: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 })
})

export type ProgressType = Type.Static<typeof Progress>

// What every job carries, whatever its status. createdAt is in the document
// from the start because it is what the worker orders by when it claims
// the oldest pending job.
const jobFields = {
  id: Type.String(),
  kind: JobKind,
  progress: Progress,
  createdAt: Type.String({ format: "date-time" })
}

// A job is one of four shapes, told apart by its status, rather than one shape
// with a status in it. The four carry the same fields today and they will not:
// a running job has a startedAt, a finished one has a finishedAt, a failed one
// says why. Declared this way, each of those belongs to the status that has
// it, the compiler refuses to read it from a status that does not, and the
// response schema refuses to answer a job that is missing one.
//
// Composed from a plain object rather than through Type.Intersect, so that
// every branch stays a flat object schema: an allOf would leave
// fast-json-stringify a union of intersections to resolve.
export const PendingJob = Type.Object({
  ...jobFields,
  status: Type.Literal("pending")
})

// startedAt arrives with the claim, in the same atomic update that moves the
// status, so a running job cannot exist without one.
export const RunningJob = Type.Object({
  ...jobFields,
  status: Type.Literal("running"),
  startedAt: Type.String({ format: "date-time" })
})

export const DoneJob = Type.Object({
  ...jobFields,
  status: Type.Literal("done"),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.String({ format: "date-time" })
})

// A job can only fail after it was claimed, so it has both times too, and the
// reason. The message is the worker's own; nothing a client sent reaches it.
export const FailedJob = Type.Object({
  ...jobFields,
  status: Type.Literal("failed"),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.String({ format: "date-time" }),
  error: Type.String()
})

export const Job = Type.Union([PendingJob, RunningJob, DoneJob, FailedJob])

export type PendingJobType = Type.Static<typeof PendingJob>
export type RunningJobType = Type.Static<typeof RunningJob>
export type DoneJobType = Type.Static<typeof DoneJob>
export type FailedJobType = Type.Static<typeof FailedJob>

export type JobType = Type.Static<typeof Job>

// 24 hexadecimal characters is what an ObjectId looks like. Declaring it is
// what turns a malformed id into a 400 before the handler runs: new ObjectId()
// throws a BSONError on anything else, which would come out as a 500.
export const JobId = Type.Object({
  id: Type.String({ pattern: "^[0-9a-fA-F]{24}$" })
})

export type JobIdType = Type.Static<typeof JobId>
