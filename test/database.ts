import { after } from "node:test"
import { mongodb } from "@fastify/mongodb"

// One database for the whole suite, never the one the application uses, and
// dropped when the file that asked for it is done. A local MongoDB is shared
// with whatever else its owner works on, so the tests leave nothing behind.
//
// `npm test` runs test files one at a time, so two of them never empty the
// same collection at once — the only reason a file would need a database of
// its own. Running them in parallel saves about 400 ms and costs one database
// per test file, for ever.
//
// Not named *.test.ts, so the runner does not mistake it for a test.
export function testDatabase(): string {
  const url = "mongodb://127.0.0.1:27017/fastify-poc-test"

  after(async () => {
    const client = new mongodb.MongoClient(url)
    await client.connect()
    await client.db().dropDatabase()
    await client.close()
  })

  return url
}
