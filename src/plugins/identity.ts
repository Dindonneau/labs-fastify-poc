import fp from "fastify-plugin"
import type { FastifyRequest } from "fastify"

export const OWNER_ID_KEY = "ownerId"

// The only file that knows how a caller is identified. Everything downstream
// goes through getOwner() and never reads a header, so replacing this with real
// tokens is a rewrite of the hook below and of nothing else.
//
// Nothing here touches Fastify's global interfaces. A `declare module` would
// tell every file in the project that request.ownerId is a string, including
// the ones outside this plugin's scope, where the decoration does not exist at
// all — and a filter built on that undefined would quietly become
// { ownerId: null } and answer with the documents that have no owner.
//
// Wrapped in fp() so the hook reaches the scope that registers it: without it,
// register() opens a child scope and the hook guards that empty scope instead
// of the routes beside it. One scope up is enough and not too far — whoever
// registers this is encapsulated in turn, which is what leaves /health open
// with no exception written anywhere.
const identity = fp(
  async fastify => {
    fastify.decorateRequest(OWNER_ID_KEY, null)

    fastify.addHook("onRequest", async (request, reply) => {
      const ownerId = request.headers["x-owner-id"]

      if (typeof ownerId !== "string" || ownerId.trim() === "") {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "x-owner-id is required"
        })
      }

      request.setDecorator(OWNER_ID_KEY, ownerId.trim())
    })
  },
  { name: "identity" }
)

// Reading it outside a scope where identity is registered raises
// FST_ERR_DEC_UNDECLARED rather than handing back undefined. Fastify does that
// check itself; this only keeps the key and its type in the file that owns them.
export const getOwner = (request: FastifyRequest): string =>
  request.getDecorator<string>(OWNER_ID_KEY)

export default identity
