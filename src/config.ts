import { listArrayContent } from "./utils/array.ts"
import { isEmptyString } from "./utils/string.ts"
import { isValidHost, isValidMongoUrl, isValidPort } from "./utils/validators.ts"

export interface IConfig {
  host: string
  port: number
  serviceName: string
  mongoUrl: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IConfig {
  const problems: string[] = []

  const host = env.HOST ?? "127.0.0.1"
  if (!isValidHost(host)) problems.push(`HOST is not valid, got "${host}"`)

  const port = env.PORT ?? "8081"
  if (!isValidPort(port)) {
    problems.push(`PORT must be an integer from 1 to 65535, got "${port}"`)
  }

  const serviceName = env.SERVICE_NAME ?? "fastify-poc"
  if (isEmptyString(serviceName))
    problems.push("SERVICE_NAME must not be empty")

  // No default: there is no sensible database to fall back on
  const mongoUrl = env.MONGO_URL
  if (mongoUrl === undefined) {
    problems.push("MONGO_URL is required")
  } else if (!isValidMongoUrl(mongoUrl)) {
    // The value is not echoed: a URL usually carries a password
    problems.push("MONGO_URL must start with mongodb:// or mongodb+srv://")
  }

  // Report every problem at once
  if (problems.length > 0) {
    const list = listArrayContent(problems)
    throw new Error(`Invalid configuration:\n${list}`)
  }

  return { host, port: +port, serviceName, mongoUrl: mongoUrl as string }
}
