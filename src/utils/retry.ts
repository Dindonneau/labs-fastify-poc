import type { JobType } from "../schemas/job.ts"

// A client that polls has to choose an interval, and only the server knows how
// long the work has left. Retry-After (RFC 9110) is how it says so, and the
// client reads a number instead of guessing one.
//
// The floor keeps a client from hammering, and the ceiling is the real point
// of the bounds: it is the longest a caller is ever told to stay blind, so an
// estimate that comes out at four minutes still answers 30 seconds. It is a
// hint and not an order — a progress bar that wants to move faster may poll
// faster, and nothing here refuses it.
const MINIMUM_SECONDS = 1
const MAXIMUM_SECONDS = 30

// Null means there is nothing left to wait for, and the caller leaves the
// header out: a done or failed job will not change again, and a Retry-After on
// it would send a client back for an answer it already has.
export function retryAfterSeconds(job: JobType, now: Date): number | null {
  if (job.status === "done" || job.status === "failed") return null

  // Nothing has been claimed, so there is nothing to extrapolate from: how
  // long it waits depends on the worker, which this process may not even run.
  if (job.status === "pending") return MINIMUM_SECONDS

  const { processed, total } = job.progress

  // No lead written yet, so no rate; and a job whose snapshot total has
  // already been passed is one lead away from finishing, not ahead of time.
  // The total was counted when the job was created and the collection has
  // moved since, which is why this is a case and not an impossibility.
  if (processed === 0 || processed >= total) return MINIMUM_SECONDS

  const elapsed = now.getTime() - new Date(job.startedAt).getTime()
  const remaining = ((total - processed) * elapsed) / processed

  // A startedAt that is not a date gives NaN, which Math.max and Math.min
  // both hand straight back — and `Retry-After: NaN` is a header no client
  // can read. The schema makes it unreachable through the API; a document
  // written by hand, or by a version of this code that predates the field,
  // is not covered by a schema. A clock behind the worker's own gives a
  // negative elapsed instead, and the floor already answers for that.
  if (!Number.isFinite(remaining)) return MINIMUM_SECONDS

  return Math.min(
    MAXIMUM_SECONDS,
    Math.max(MINIMUM_SECONDS, Math.ceil(remaining / 1000))
  )
}
