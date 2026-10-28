import type { FastifyPluginAsync } from "fastify"
import identity, { getOwner } from "../../plugins/identity.ts"
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
  // Registered here rather than in app.ts: the hook only applies to the scope
  // that registers it, which is how /health stays reachable without a header.
  await fastify.register(identity)

  const repository = await mongoLeadsRepository(requireDb(fastify.mongo.db))

  fastify.post<{ Body: NewLeadType; Reply: LeadType }>(
    "/",
    { schema: { body: NewLead, response: { 201: Lead } } },
    async (request, reply) => {
      const currentOwner = getOwner(request)
      const lead = await repository.create(currentOwner, request.body)
      return reply.code(201).send(lead)
    }
  )

  fastify.get<{ Reply: LeadsType }>(
    "/",
    { schema: { response: { 200: Leads } } },
    async (request, reply) => {
      const currentOwner = getOwner(request)
      return reply.send(await repository.list(currentOwner))
    }
  )
}

export default leads
