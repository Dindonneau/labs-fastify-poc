import type { FastifyPluginAsync } from "fastify"

export interface HealthOptions {
  serviceName: string
}

const health: FastifyPluginAsync<HealthOptions> = async (fastify, options) => {
  fastify.get("/", async () => ({
    status: "ok",
    service: options.serviceName,
  }))
}

export default health
