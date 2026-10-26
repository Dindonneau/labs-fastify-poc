import type { FastifyPluginAsync } from "fastify"
import { Health, type HealthType } from "../../schemas/health.ts"

export interface HealthOptions {
  serviceName: string
}

const health: FastifyPluginAsync<HealthOptions> = async (fastify, options) => {
  fastify.get<{ Reply: HealthType }>(
    "/",
    { schema: { response: { 200: Health } } },
    async (_req, res) => {
      return res.send({
        status: "ok",
        service: options.serviceName
      })
    }
  )
}

export default health
