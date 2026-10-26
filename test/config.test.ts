import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "../src/config.ts"

// loadConfig takes the environment as an argument, so each test hands it a
// made-up one and never touches the real process.env.

test("an empty environment gives the defaults", () => {
  assert.deepEqual(loadConfig({}), {
    host: "127.0.0.1",
    port: 8081,
    serviceName: "fastify-poc"
  })
})

test("the values are read, and PORT becomes a number", () => {
  const config = loadConfig({ HOST: "localhost", PORT: "3000", SERVICE_NAME: "unicorn" })

  assert.deepEqual(config, { host: "localhost", port: 3000, serviceName: "unicorn" })
  assert.equal(typeof config.port, "number")
})

for (const port of ["1", "8081", "65535"]) {
  test(`PORT=${JSON.stringify(port)} is accepted`, () => {
    assert.equal(loadConfig({ PORT: port }).port, Number(port))
  })
}

// Plain digits only: a unary plus would let " 80 ", "1e3" and "0x1F90" through.
for (const port of ["abc", "", "0", "65536", "-1", "80.5", " 80 ", "1e3", "0x1F90"]) {
  test(`PORT=${JSON.stringify(port)} is refused, and the message shows what was received`, () => {
    assert.throws(
      () => loadConfig({ PORT: port }),
      error =>
        error instanceof Error &&
        error.message.includes("PORT must be an integer from 1 to 65535") &&
        error.message.includes(`got ${JSON.stringify(port)}`)
    )
  })
}

for (const host of ["localhost", "example.com", "example.com.", "127.0.0.1", "0.0.0.0", "::1", "::"]) {
  test(`HOST=${JSON.stringify(host)} is accepted`, () => {
    assert.equal(loadConfig({ HOST: host }).host, host)
  })
}

// A last label made only of digits is not a name, which rules out an invalid
// IPv4 address such as 256.1.1.1.
for (const host of ["", " 127.0.0.1", "my host", "a_b", "-bad.com", "a..b", "256.1.1.1", "1.2.3"]) {
  test(`HOST=${JSON.stringify(host)} is refused, and the message shows what was received`, () => {
    assert.throws(
      () => loadConfig({ HOST: host }),
      error =>
        error instanceof Error &&
        error.message.includes("HOST is not valid") &&
        error.message.includes(`got ${JSON.stringify(host)}`)
    )
  })
}

test("a blank SERVICE_NAME is refused", () => {
  assert.throws(() => loadConfig({ SERVICE_NAME: "  " }), /SERVICE_NAME must not be empty/)
})

test("every problem is reported at once, not only the first", () => {
  assert.throws(
    () => loadConfig({ HOST: "", PORT: "abc", SERVICE_NAME: " " }),
    error =>
      error instanceof Error &&
      error.message.startsWith("Invalid configuration:") &&
      error.message.includes("HOST is not valid") &&
      error.message.includes("PORT must be an integer") &&
      error.message.includes("SERVICE_NAME must not be empty")
  )
})
