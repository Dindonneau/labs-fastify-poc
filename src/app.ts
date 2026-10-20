import type { FastifyPluginAsync } from "fastify"
import health from "./routes/health/index.ts"

export interface AppOptions {
  serviceName: string
}

const app: FastifyPluginAsync<AppOptions> = async (fastify, options) => {
  await fastify.register(health, {
    prefix: "/health",
    serviceName: options.serviceName,
  })
}

export default app
