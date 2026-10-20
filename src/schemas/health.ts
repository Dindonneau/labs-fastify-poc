import Type from "typebox"

export const Health = Type.Object({
  status: Type.String(),
  service: Type.String(),
})

export type HealthType = Type.Static<typeof Health>
