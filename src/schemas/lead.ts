import Type from "typebox"

// What a client is allowed to send. With additionalProperties, anything else
// is dropped rather than refused: Fastify runs ajv with removeAdditional.
export const NewLead = Type.Object(
  {
    email: Type.String({ format: "email" }),
    firstName: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
)

export type NewLeadType = Type.Static<typeof NewLead>

// What the API answers: Mongo's _id, turned into a string called id
export const Lead = Type.Object({
  id: Type.String(),
  email: Type.String(),
  firstName: Type.Optional(Type.String())
})

export type LeadType = Type.Static<typeof Lead>

export const Leads = Type.Array(Lead)

export type LeadsType = Type.Static<typeof Leads>
