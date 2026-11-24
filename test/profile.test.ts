import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { SignJWT } from "jose"

process.env.NOCTORIUM_LOCAL_DB = mkdtempSync(join(tmpdir(), "noctorium-profile-"))
process.env.AUTH_SECRET = "test-secret-that-is-long-enough-for-hs256"

const p = await import("../src/lib/profile.ts")
const { issueToken, readToken } = await import("../src/lib/session.ts")
const { hashPassword } = await import("../src/lib/password.ts")
const { db } = await import("../src/lib/db.ts")

async function newUser(name: string, password: string | null = "old-password-123"): Promise<number> {
  const hash = password ? await hashPassword(password) : null
  const [user] = (await db()`
    INSERT INTO users (email, email_key, display_name, password_hash)
    VALUES (${`${name}@example.com`}, ${`${name}@example.com`}, ${name}, ${hash}) RETURNING id
  `) as { id: number }[]
  return Number(user.id)
}

test("a password change signs other devices out, and tokens from before epochs still count", async () => {
  const id = await newUser("epoch")
  const before = await issueToken({ userId: id, email: "epoch@example.com" })
  const legacy = await new SignJWT({ email: "epoch@example.com" }).setProtectedHeader({ alg: "HS256" }).setSubject(String(id))
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(process.env.AUTH_SECRET))
  assert.ok(await readToken(before))
  assert.ok(await readToken(legacy), "a token without ver was signed out by the update itself")

  assert.deepEqual(await p.changePassword(id, "wrong-password-1", "new-password-456", null), { error: "That password is not right." })
  assert.ok(await readToken(before), "a refused change signed people out")
  assert.deepEqual(await p.changePassword(id, "old-password-123", "new-password-456", null), { ok: true })
  assert.equal(await readToken(before), null, "the old token still works")
  assert.equal(await readToken(legacy), null)
  assert.ok(await readToken(await issueToken({ userId: id, email: "epoch@example.com" })), "a fresh token does not work")
})

test("names and emails are checked, and another account's email is refused", async () => {
  const id = await newUser("namer")
  await newUser("other")
  assert.deepEqual(await p.rename(id, "  New   Name "), { name: "New Name" })
  assert.ok("error" in (await p.rename(id, "   ")))
  assert.ok("error" in (await p.changeEmail(id, "not-an-email", "old-password-123", null)))
  assert.deepEqual(await p.changeEmail(id, "OTHER@example.com", "old-password-123", null), { error: "Another account already uses that email address." })
  assert.deepEqual(await p.changeEmail(id, "fresh@example.com", "nope-nope-nope", null), { error: "That password is not right." })
  assert.deepEqual(await p.changeEmail(id, "fresh@example.com", "old-password-123", null), { email: "fresh@example.com" })
})

test("two-step verification is asked for before a sensitive change", async () => {
  const id = await newUser("twostep")
  await db()`INSERT INTO two_factor (user_id, telegram) VALUES (${id}, true)`
  assert.deepEqual(await p.changePassword(id, "old-password-123", "new-password-456", "000000"), { error: "That code is not right." })
  assert.deepEqual(await p.deleteAccount(id, "delete my account", "old-password-123", null), { error: "That code is not right." })
})

test("deleting needs the phrase and the password, and takes the account with it", async () => {
  const id = await newUser("leaver")
  const token = await issueToken({ userId: id, email: "leaver@example.com" })
  await db()`INSERT INTO plays (user_id, client_id, provider, track_id, title, artist, ms_played, played_at) VALUES (${id}, 'c1', 'youtube', 't', 'T', 'A', 1000, now())`
  assert.ok("error" in (await p.deleteAccount(id, "delete it", "old-password-123", null)))
  assert.ok("error" in (await p.deleteAccount(id, "delete my account", "wrong-password-1", null)))
  assert.deepEqual(await p.deleteAccount(id, "Delete my account", "old-password-123", null), { ok: true })
  assert.equal(((await db()`SELECT 1 FROM users WHERE id = ${id}`) as unknown[]).length, 0)
  assert.equal(((await db()`SELECT 1 FROM plays WHERE user_id = ${id}`) as unknown[]).length, 0)
  assert.equal(await readToken(token), null, "a deleted account's token still works")
})

test("pictures: only JPEG or PNG under the limit, served by a key that changes", async () => {
  const id = await newUser("pictured")
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  assert.equal(p.imageType(png), "image/png")
  assert.equal(p.imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg")
  assert.equal(p.imageType(new TextEncoder().encode("<svg onload=alert(1)>")), null)
  assert.equal(p.imageType(new Uint8Array(p.MAX_AVATAR_BYTES + 1).fill(0xff)), null)

  const first = await p.setAvatar(id, png)
  assert.ok("avatarUrl" in first)
  const key = first.avatarUrl.split("/").pop()!
  assert.equal((await p.avatarByKey(key))?.type, "image/png")
  const second = await p.setAvatar(id, png)
  assert.ok("avatarUrl" in second && second.avatarUrl !== first.avatarUrl, "a new picture kept the old address")
  assert.equal(await p.avatarByKey(key), null, "the old address still serves")
  await p.removeAvatar(id)
  assert.equal(await p.avatarByKey(second.avatarUrl.split("/").pop()!), null)
  assert.ok("error" in (await p.useDiscordAvatar(id)), "Discord picture without Discord linked")
})
