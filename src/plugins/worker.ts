import { createWriteStream } from "node:fs"
import { mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { FastifyPluginAsync } from "fastify"
import { mongoJobsRepository } from "../repositories/jobs.ts"
import { mongoLeadsRepository } from "../repositories/leads.ts"
import type { RunningJobType } from "../schemas/job.ts"
import { requireDb } from "../utils/mongo.ts"

// The kind this worker knows how to run, declared again rather than shared
// with the route that creates it: the route's job is to produce this kind, the
// worker's is to consume it, and a second kind would arrive as a second worker
// rather than as a branch inside this one. A typo is a compiler error, because
// claimNext takes the union of the declared kinds and not a string.
const KIND = "leadsExport"

export interface WorkerOptions {
  exportDir: string

  // How long to wait when there was nothing to claim. Short enough that a job
  // feels immediate, long enough that an idle worker is not a load: at one
  // second this is 86 400 findOneAndUpdate a day, which is nothing, and it is
  // the number a queue of real size would replace with a change stream or a
  // notification rather than by lowering.
  pollIntervalMs?: number

  // How many leads between two progress writes. Measured on 50 000 leads:
  // 0.20 s at one write per thousand, 3.02 s at one per lead — the progress
  // would cost 15 times the export it reports on. A client polling the
  // batched run still saw five intermediate values, which is five more than
  // a progress bar needs.
  progressEvery?: number
}

const worker: FastifyPluginAsync<WorkerOptions> = async (fastify, options) => {
  const { exportDir, pollIntervalMs = 1000, progressEvery = 1000 } = options

  const db = requireDb(fastify.mongo.db)
  const jobs = await mongoJobsRepository(db)
  const leads = await mongoLeadsRepository(db)

  // Created here rather than demanded of whoever deploys this: the worker is
  // the only thing that writes there, so it is the thing that knows it needs
  // to exist. recursive makes it idempotent, and a nested path work.
  await mkdir(exportDir, { recursive: true })

  const fileFor = (id: string) => join(exportDir, `${id}.ndjson`)

  let stopped = false
  let timer: NodeJS.Timeout | undefined

  // The tick in flight, so that closing can wait for it. It never rejects —
  // tick() catches — because onClose awaits it and a rejection there would
  // turn a shutdown into a failure.
  let running: Promise<void> = Promise.resolve()

  // NDJSON and not a single JSON array: a reader takes one line at a time,
  // and a file that is still being written is still parseable up to its last
  // complete line. An array would have to be closed to be valid at all.
  async function writeExport(job: RunningJobType, ownerId: string) {
    let written = 0

    // pipeline, not a loop of file.write(): write() answers false when the
    // buffer is full, and a loop that ignores it holds the whole export in
    // memory — which is the one thing walking a cursor was for. pipeline
    // waits for the drain, and closes the file on the way out either way.
    await pipeline(
      async function* () {
        for await (const lead of leads.stream(ownerId)) {
          yield `${JSON.stringify(lead)}\n`

          written += 1
          if (written % progressEvery === 0) {
            await jobs.recordProgress(job.id, written)
          }
        }
      },
      createWriteStream(fileFor(job.id))
    )

    // The last partial batch, and the only progress a job smaller than one
    // batch ever gets. What the cursor produced, not the total the job was
    // created with: leads may have been added or removed since that snapshot.
    await jobs.recordProgress(job.id, written)

    return written
  }

  async function run(job: RunningJobType, ownerId: string) {
    try {
      const written = await writeExport(job, ownerId)
      await jobs.finish(job.id)

      fastify.log.info({ job: job.id, written }, "export written")
    } catch (error) {
      fastify.log.error({ err: error, job: job.id }, "export failed")

      // A half-written file is worse than none: nothing in it says it is
      // incomplete, so a client downloading it would read a truncated export
      // as a whole one. A failure to remove it is not worth failing over.
      await unlink(fileFor(job.id)).catch(() => {})

      // The worker's own message, and the one that reaches a client. What the
      // driver threw stays in the log above: it names hosts and collections.
      await jobs.fail(job.id, "the export could not be written")
    }
  }

  // Drains instead of running one job per tick: the interval says how long to
  // wait when there is nothing to do, and is not a rate limit on work. Three
  // jobs queued while the worker slept are three jobs run back to back.
  //
  // stopped is read on every turn, so a close takes effect after the job in
  // flight rather than after the queue.
  async function drain() {
    while (!stopped) {
      const claimed = await jobs.claimNext(KIND)
      if (!claimed) return

      await run(claimed.job, claimed.ownerId)
    }
  }

  async function tick() {
    try {
      await drain()
    } catch (error) {
      // run() answers for the export itself, so what reaches here is the
      // claim: a database that went away. The loop is rearmed below, which
      // is what makes a worker survive an outage it did not cause.
      fastify.log.error({ err: error }, "the worker loop failed")
    }

    schedule()
  }

  function schedule() {
    if (stopped) return

    // setTimeout and not setInterval: a tick that outlasts its interval must
    // not have the next one start beside it. Rearmed by the tick it fires, so
    // there is never more than one in the air.
    timer = setTimeout(() => {
      running = tick()
    }, pollIntervalMs)

    // A pending poll is not a reason for the process to stay alive. Without
    // this, a test that forgets to close its server hangs instead of failing.
    timer.unref()
  }

  // onReady and not the body of the plugin: the body runs while the
  // application is still being built, and a job claimed then would run
  // against a half-registered server. onReady is the hook that says every
  // plugin is loaded — and it is also what makes a job left pending by a
  // previous run get picked up on boot, with no recovery pass to write.
  fastify.addHook("onReady", async () => {
    schedule()
  })

  fastify.addHook("onClose", async () => {
    // Order matters: stopped first, so that a tick about to finish does not
    // rearm behind the clearTimeout below.
    stopped = true

    // Waits for the job in flight. A file half written by a worker that was
    // told to stop is the same lie as one left behind by a crash, so a large
    // export holds the close for as long as it needs — which is what a
    // deployment's grace period is for.
    await running

    clearTimeout(timer)
  })
}

export default worker
