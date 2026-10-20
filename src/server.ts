import fastify from "fastify"
import app from "./app.ts"

const server = fastify({ logger: true })

await server.register(app, { serviceName: "minilem" })

await server.listen({ port: 8081, host: "127.0.0.1" })
