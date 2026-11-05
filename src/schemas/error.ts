import Type from "typebox"

// The shape Fastify answers errors in, declared so a route that answers one
// can say so in its response schema. Fastify adds a `code` of its own to the
// errors it raises itself; this is the three fields every one of them carries.
export const ApiError = Type.Object({
  statusCode: Type.Integer(),
  error: Type.String(),
  message: Type.String()
})

export type ApiErrorType = Type.Static<typeof ApiError>
