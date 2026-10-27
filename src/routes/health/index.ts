import type { FastifyPluginAsync } from "fastify"
import { Health, type HealthType } from "../../schemas/health.ts"

export interface HealthOptions {
  serviceName: string
}

const health: FastifyPluginAsync<HealthOptions> = async (fastify, options) => {
  // Through the client: fastify.mongo.db only exists if the URL names a database
  async function isDatabaseUp() {
    try {
      await fastify.mongo.client.db("admin").command({ ping: 1 })
      return true
    } catch {
      return false
    }
  }

  fastify.get<{ Reply: HealthType }>(
    "/",
    { schema: { response: { 200: Health, 503: Health } } },
    async (_req, res) => {
      const service = options.serviceName

      if (await isDatabaseUp()) {
        return res.send({ status: "ok", service, database: "up" })
      }
      return res
        .code(503)
        .send({ status: "degraded", service, database: "down" })
    }
  )
}

export default health
