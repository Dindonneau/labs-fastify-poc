import type { FastifyPluginAsync } from "fastify"
import { mongoLeadsRepository } from "../../repositories/leads.ts"
import {
  Lead,
  Leads,
  NewLead,
  type LeadType,
  type LeadsType,
  type NewLeadType
} from "../../schemas/lead.ts"
import { requireDb } from "../../utils/mongo.ts"

const leads: FastifyPluginAsync = async fastify => {
  const db = requireDb(fastify.mongo.db)
  const repository = mongoLeadsRepository(db)

  fastify.post<{ Body: NewLeadType; Reply: LeadType }>(
    "/",
    { schema: { body: NewLead, response: { 201: Lead } } },
    async (request, reply) => {
      return reply.code(201).send(await repository.create(request.body))
    }
  )

  fastify.get<{ Reply: LeadsType }>(
    "/",
    { schema: { response: { 200: Leads } } },
    async (_request, reply) => {
      return reply.send(await repository.list())
    }
  )
}

export default leads
