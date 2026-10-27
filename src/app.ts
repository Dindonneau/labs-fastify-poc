import type { FastifyPluginAsync } from "fastify"
import mongo from "./plugins/mongo.ts"
import health from "./routes/health/index.ts"
import leads from "./routes/leads/index.ts"

export interface AppOptions {
  serviceName: string
  mongoUrl: string
}

const app: FastifyPluginAsync<AppOptions> = async (fastify, options) => {
  await fastify.register(mongo, { url: options.mongoUrl })

  await fastify.register(health, {
    prefix: "/health",
    serviceName: options.serviceName
  })

  await fastify.register(leads, { prefix: "/leads" })
}

export default app
