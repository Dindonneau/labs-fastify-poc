import mongodb from "@fastify/mongodb"
import fp from "fastify-plugin"

export interface MongoOptions {
  url: string
}

// Wrapped in fp() so that `fastify.mongo` is visible outside this plugin,
// to the routes registered after it. The connection is opened here, before
// the server listens, and closed by @fastify/mongodb when the app closes.
const mongo = fp<MongoOptions>(
  async (fastify, options) => {
    // Fail in 2 s rather than the plugin's default 7.5 s when the database is unreachable
    await fastify.register(mongodb, {
      url: options.url,
      serverSelectionTimeoutMS: 2000
    })
  },
  { name: "mongo" }
)

export default mongo
