import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"

/**
 * AES-256-GCM under a key derived from AUTH_SECRET and a [purpose], so a secret sealed for one purpose cannot be
 * opened as another. What is kept in the database is unreadable without AUTH_SECRET.
 */
const keyFor = (purpose: string) => createHmac("sha256", process.env.AUTH_SECRET ?? "").update(purpose).digest()

export function seal(plain: string, purpose: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), iv)
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

/** The sealed text, or null when it was tampered with or sealed under another key or purpose. */
export function unseal(sealed: string, purpose: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url")
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}
