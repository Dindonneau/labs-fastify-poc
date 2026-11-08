import assert from "node:assert/strict"
import { test } from "node:test"
import type { JobType } from "../src/schemas/job.ts"
import { retryAfterSeconds } from "../src/utils/retry.ts"

// A pure function taking the time as an argument, so the estimate can be
// asserted on exactly rather than approximately: no clock is read here.
const startedAt = "2026-11-08T10:00:00.000Z"
const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000)

const base = {
  id: "0".repeat(24),
  kind: "leadsExport" as const,
  createdAt: startedAt
}

const pending = (processed = 0, total = 100): JobType => ({
  ...base,
  status: "pending",
  progress: { processed, total }
})

const running = (processed: number, total = 100): JobType => ({
  ...base,
  status: "running",
  startedAt,
  progress: { processed, total }
})

test("a pending job is answered the floor: there is no rate to read yet", () => {
  assert.equal(retryAfterSeconds(pending(), at(5)), 1)
})

test("a running job that has written nothing is answered the floor too", () => {
  assert.equal(retryAfterSeconds(running(0), at(5)), 1)
})

test("the remaining time is extrapolated from the rate so far", () => {
  // 50 of 100 in 20 s: half the work in 20 s, so about 20 s left
  assert.equal(retryAfterSeconds(running(50), at(20)), 20)

  // 80 of 100 in 20 s: a quarter of the written work is left, so 5 s
  assert.equal(retryAfterSeconds(running(80), at(20)), 5)
})

// 50 of 100 in 0.8 s leaves 0.8 s, which is still a whole second to a header
// that carries none.
test("the estimate is rounded up: a 0.8 s wait is still a second", () => {
  assert.equal(retryAfterSeconds(running(50), at(0.8)), 1)
})

// Two values the arithmetic could produce and a header cannot carry. Neither
// is reachable through the API — the schema requires a date-time, and both
// times are written by the same process — but a document written by hand is
// not covered by a schema, and an API and a worker in separate deployments do
// not share a clock.
test("a startedAt that is not a date is answered the floor, not NaN", () => {
  const broken: JobType = {
    ...base,
    status: "running",
    startedAt: "whenever",
    progress: { processed: 50, total: 100 }
  }

  assert.equal(retryAfterSeconds(broken, at(20)), 1)
})

test("a clock behind the worker's own does not give a negative wait", () => {
  assert.equal(retryAfterSeconds(running(50), at(-30)), 1)
})

// The ceiling is the longest a client is ever told to stay blind, whatever
// the arithmetic says.
test("a long estimate is capped at 30 seconds", () => {
  assert.equal(retryAfterSeconds(running(1), at(10)), 30)
  assert.equal(retryAfterSeconds(running(1, 1_000_000), at(60)), 30)
})

// The total was counted when the job was created, so the collection may have
// grown since and a job can pass its own snapshot.
test("a job past its total is answered the floor, not a negative wait", () => {
  assert.equal(retryAfterSeconds(running(120), at(20)), 1)
  assert.equal(retryAfterSeconds(running(100), at(20)), 1)
})

// Null is what makes the caller leave the header out. A Retry-After here
// would send a client back for an answer it is already holding.
test("a job that will not change again is answered null", () => {
  const done: JobType = {
    ...base,
    status: "done",
    startedAt,
    finishedAt: at(30).toISOString(),
    progress: { processed: 100, total: 100 }
  }

  const failed: JobType = {
    ...base,
    status: "failed",
    startedAt,
    finishedAt: at(30).toISOString(),
    error: "the export could not be written",
    progress: { processed: 12, total: 100 }
  }

  assert.equal(retryAfterSeconds(done, at(31)), null)
  assert.equal(retryAfterSeconds(failed, at(31)), null)
})
