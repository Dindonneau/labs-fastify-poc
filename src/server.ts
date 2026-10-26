import Fastify from "fastify"
import app from "./app.ts"
import { loadConfig, type IConfig } from "./config.ts"
import { logErrorMessage } from "./utils/error.ts"

// A misconfigured start should say what is wrong and stop, not print a stack.
function readConfig(): IConfig {
  try {
    return loadConfig()
  } catch (error) {
    logErrorMessage(error)
    process.exit(1)
  }
}

const config = readConfig()
const server = Fastify({ logger: true })

await server.register(app, {
  serviceName: config.serviceName,
  mongoUrl: config.mongoUrl
})
await server.listen({ port: config.port, host: config.host })
