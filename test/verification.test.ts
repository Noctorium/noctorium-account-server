import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

process.env.NOCTORIUM_LOCAL_DB = mkdtempSync(join(tmpdir(), "noctorium-verification-"))
process.env.AUTH_SECRET = "test-secret-that-is-long-enough-for-hs256"

const v = await import("../src/lib/verification.ts")
const { db } = await import("../src/lib/db.ts")

const codeNow = (secret: string) => v.totpAt(v.fromBase32(secret), Math.floor(Date.now() / 30_000))
const hash = (text: string) => createHash("sha256").update(text).digest("base64url")

async function newUser(name: string): Promise<number> {
  const [user] = (await db()`
    INSERT INTO users (email, email_key, display_name, password_hash) VALUES (${`${name}@example.com`}, ${`${name}@example.com`}, ${name}, 'x') RETURNING id
  `) as { id: number }[]
  return Number(user.id)
}

async function withAuthenticator(userId: number): Promise<{ secret: string; backups: string[] }> {
  const secret = await v.beginTotp(userId)
  assert.equal(await v.confirmTotp(userId, "000000".replace(/0/g, "1")), null, "a wrong code turned the authenticator on")
  const backups = await v.confirmTotp(userId, codeNow(secret))
  assert.ok(backups && backups.length === 10)
  return { secret, backups: backups! }
}

/** A Telegram code as if the bot had sent it: the bot is not reachable from a test. */
async function telegramCodeSent(ticket: string, code: string) {
  await db()`UPDATE sign_in_challenges SET telegram_code = ${hash(code)}, telegram_expires = now() + interval '10 minutes' WHERE id = ${hash(ticket)}`
}

test("the authenticator's codes are RFC 6238's own test vectors", () => {
  const secret = Buffer.from("12345678901234567890")
  const vectors: [number, string][] = [
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ]
  for (const [seconds, code] of vectors) assert.equal(v.totpAt(secret, Math.floor(seconds / 30), 8), code, `at ${seconds}`)
  assert.equal(v.fromBase32(v.base32(secret)).toString(), "12345678901234567890")
})

test("a code from just before or after counts, for a clock a little off, and one further out does not", () => {
  const secret = v.base32(Buffer.from("12345678901234567890"))
  const now = 1_800_000_000_000
  const step = Math.floor(now / 30_000)
  const at = (s: number) => v.totpAt(v.fromBase32(secret), s)
  assert.ok(v.totpMatches(secret, at(step), now))
  assert.ok(v.totpMatches(secret, at(step - 1), now))
  assert.ok(v.totpMatches(secret, ` ${at(step + 1).slice(0, 3)} ${at(step + 1).slice(3)} `, now), "spaces as an app shows them")
  assert.equal(v.totpMatches(secret, at(step + 3), now), false)
  assert.equal(v.totpMatches(secret, "abcdef", now), false)
})

test("an account with nothing on signs in with no challenge", async () => {
  assert.equal(await v.startChallenge(await newUser("plain")), null)
})

test("with the authenticator on, its code finishes the sign-in, once", async () => {
  const id = await newUser("totp")
  const { secret } = await withAuthenticator(id)
  const started = await v.startChallenge(id, "/device?code=ABCD-EFGH")
  assert.deepEqual([started?.methods, started?.strict], [["totp"], false])
  const wrong = await v.verify(started!.ticket, { totp: "123456" === codeNow(secret) ? "654321" : "123456" })
  assert.equal(wrong.state, "more")
  assert.deepEqual(await v.verify(started!.ticket, { totp: codeNow(secret) }), { state: "done", userId: id, next: "/device?code=ABCD-EFGH" })
  assert.deepEqual(await v.verify(started!.ticket, { totp: codeNow(secret) }), { state: "gone" }, "a finished sign-in finished again")
})

test("with both on, either one is enough this time; strict needs both, and they can come one at a time", async () => {
  const id = await newUser("both")
  const { secret } = await withAuthenticator(id)
  await v.setTelegram(id, true)

  const either = await v.startChallenge(id)
  assert.deepEqual(either?.methods, ["totp", "telegram"])
  await telegramCodeSent(either!.ticket, "424242")
  assert.equal((await v.verify(either!.ticket, { telegram: "424242" })).state, "done", "Telegram alone was not enough")

  assert.ok(await v.setStrict(id, true))
  const strict = await v.startChallenge(id)
  assert.equal(strict?.strict, true)
  const half = await v.verify(strict!.ticket, { totp: codeNow(secret) })
  assert.deepEqual(half.state === "more" ? half.done : null, ["totp"])
  await telegramCodeSent(strict!.ticket, "171717")
  assert.equal((await v.verify(strict!.ticket, { telegram: "171717" })).state, "done")
})

test("strict cannot be on with only one way, and turning Telegram off turns strict off", async () => {
  const id = await newUser("strictless")
  await withAuthenticator(id)
  assert.equal(await v.setStrict(id, true), false)
  await v.setTelegram(id, true)
  assert.ok(await v.setStrict(id, true))
  await v.setTelegram(id, false)
  assert.equal((await v.settings(id)).strict, false)
})

test("a backup code stands in for a missing way, and works once", async () => {
  const id = await newUser("backup")
  const { backups } = await withAuthenticator(id)
  const first = await v.startChallenge(id)
  assert.equal((await v.verify(first!.ticket, { backup: backups[0].toUpperCase() })).state, "done")
  const second = await v.startChallenge(id)
  assert.equal((await v.verify(second!.ticket, { backup: backups[0] })).state, "more", "a backup code worked twice")
  assert.equal((await v.settings(id)).backupCodesLeft, 9)
})

test("a Telegram code that has expired does not count", async () => {
  const id = await newUser("expired")
  await v.setTelegram(id, true)
  const started = await v.startChallenge(id)
  await db()`UPDATE sign_in_challenges SET telegram_code = ${hash("111111")}, telegram_expires = now() - interval '1 minute' WHERE id = ${hash(started!.ticket)}`
  assert.equal((await v.verify(started!.ticket, { telegram: "111111" })).state, "more")
})

test("guessing ends the challenge after a few tries", async () => {
  const id = await newUser("guesser")
  await withAuthenticator(id)
  const started = await v.startChallenge(id)
  for (let i = 0; i < 8; i++) await v.verify(started!.ticket, { totp: "000000" })
  assert.deepEqual(await v.verify(started!.ticket, { totp: "000000" }), { state: "gone" })
})

test("a change to security needs proof: a code from the app, a backup code, or one sent to Telegram", async () => {
  const id = await newUser("prover")
  const { secret, backups } = await withAuthenticator(id)
  assert.ok(await v.proves(id, codeNow(secret)))
  assert.ok(await v.proves(id, backups[1]))
  assert.equal(await v.proves(id, "999999"), false)
})

test("an app too old for the code step is told why, in the words it already shows", () => {
  assert.match(v.OLD_APP_MESSAGE, /two-step verification/)
  assert.match(v.OLD_APP_MESSAGE, /Discord or Telegram/)
})
