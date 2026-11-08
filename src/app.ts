import type { FastifyPluginAsync } from "fastify"
import mongo from "./plugins/mongo.ts"
import worker, { type WorkerOptions } from "./plugins/worker.ts"
import exportJobs from "./routes/exports/index.ts"
import health from "./routes/health/index.ts"
import leads from "./routes/leads/index.ts"

export interface AppOptions {
  serviceName: string
  mongoUrl: string

  // Present when this process should also drain the jobs collection. Left out,
  // the application is an API and nothing runs what it accepts — which is not
  // a degraded mode but the deployment where workers are their own containers,
  // scaled on how much work there is rather than on how much traffic.
  //
  // It is an option and not an environment variable read down in the plugin so
  // that a test can choose: most of the suite wants a job to stay pending.
  worker?: WorkerOptions
}

const app: FastifyPluginAsync<AppOptions> = async (fastify, options) => {
  await fastify.register(mongo, { url: options.mongoUrl })

  await fastify.register(health, {
    prefix: "/health",
    serviceName: options.serviceName
  })

  await fastify.register(leads, { prefix: "/leads" })

  await fastify.register(exportJobs, { prefix: "/exports" })

  // After the routes, and inside this scope: the worker reads fastify.mongo,
  // which the mongo plugin above decorated here. Registered on the server
  // instead, it would not see it — register() opens a child scope, and what a
  // child decorates does not travel up to its parent.
  if (options.worker) await fastify.register(worker, options.worker)
}

export default app
