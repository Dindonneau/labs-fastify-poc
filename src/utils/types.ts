// Shows a derived type as the shape it ends up being rather than the chain of
// Omits and intersections it was built from. The mapped type re-reads every
// property, and the `& {}` is what forces the result to be evaluated now: left
// out, an editor keeps printing the alias it was asked about.
//
// It is an identity for the compiler. The mapped type is homomorphic, so the
// optional and readonly modifiers come through, and so does the index signature
// that the Doc constraint in mongo.ts relies on. Nothing of it reaches runtime.
export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}
