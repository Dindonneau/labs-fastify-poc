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

// Omit does not distribute: Omit<A | B, K> keeps only the keys A and B share,
// so the fields that belong to a single branch disappear — in silence, which
// is the part that matters. A naked type parameter in a conditional does
// distribute, and that is the whole of what this adds.
//
// A job is a union of one shape per status, so every type below that reaches
// for Omit goes through this one.
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

// Replaces the fields U names and leaves every other one alone. It exists for
// the one conversion that cannot be derived: a document leaving MongoDB has
// its dates converted by their type, with no name to declare anywhere, but
// nothing in a `string` says which one is to become a Date on the way in.
export type Override<T, U> = Prettify<DistributiveOmit<T, keyof U> & U>
