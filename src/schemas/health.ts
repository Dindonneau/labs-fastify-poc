import Type from "typebox"

export const Health = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
  service: Type.String(),
  database: Type.Union([Type.Literal("up"), Type.Literal("down")])
})

export type HealthType = Type.Static<typeof Health>
