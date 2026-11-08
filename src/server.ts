import Fastify from "fastify"
import app from "./app.ts"
import { loadConfig, type IConfig } from "./config.ts"
import { logErrorMessage } from "./utils/error.ts"

// A misconfigured start should say what is wrong and stop, not print a stack.
function readConfig(): IConfig {
  try {
    return loadConfig()
  } catch (error) {
    logErrorMessage(error)
    process.exit(1)
  }
}

const config = readConfig()
const server = Fastify({ logger: true })

// One process serves the API and runs the jobs, which is what a POC wants: a
// deployment that splits them starts the same image twice and leaves the
// worker option out of the one that only answers requests.
await server.register(app, {
  serviceName: config.serviceName,
  mongoUrl: config.mongoUrl,
  worker: { exportDir: config.exportDir }
})
// Nothing calls close() on its own: Fastify installs no signal handler and
// neither does Node, so Ctrl-C, a `node --watch` restart and a `docker stop`
// all kill the process outright. Without these lines the worker's onClose —
// the flag, the wait for the export in flight, the cleared timer — would only
// ever run in tests, and every real shutdown would be a kill: a job left
// `running` for ever and a truncated file in EXPORT_DIR.
//
// once and not on, so a second signal gets Node's default behaviour back.
// That is the way out when a large export is holding the shutdown, and it is
// also what a deployment does when its grace period runs out.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.log.info({ signal }, "shutting down")

    // The process is not stopped here. The poll timer is unref'd and close()
    // shuts the MongoDB connection and the listening socket, so the event
    // loop empties by itself once the job in flight is done.
    server.close().catch(error => {
      server.log.error({ err: error }, "shutdown failed")
      process.exit(1)
    })
  })
}

await server.listen({ port: config.port, host: config.host })
