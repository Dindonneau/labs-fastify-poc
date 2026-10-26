import { isIP } from "node:net"

// Digits only: a unary plus would also accept " 80 ", "1e3" and "0x1F90".
export const isValidPort = (value: string | number) => {
  const text = String(value)
  if (!/^\d+$/.test(text)) return false

  const port = Number(text)
  return port >= 1 && port <= 65535
}

export const isValidHost = (value: string) => {
  if (!value || value.trim() !== value) return false

  return !!isIP(value) || isValidHostname(value)
}

export const isValidHostname = (value: string) => {
  if (!value || value.trim() !== value) return false
  if (value.length > 253) return false

  const hostname = value.endsWith(".") ? value.slice(0, -1) : value

  if (!hostname) return false

  const labels = hostname.split(".")

  // A top-level label cannot be all digits (RFC 3696 §2): "1.2.3" or "256.1.1.1"
  // would otherwise pass as names.
  if (/^\d+$/.test(labels.at(-1) ?? "")) return false

  return labels.every(
    label =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  )
}

export function isValidMongoUrl(value: string): boolean {
  return /^mongodb(\+srv)?:\/\/\S+$/.test(value)
}
