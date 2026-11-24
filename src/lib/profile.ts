import { randomBytes } from "node:crypto"
import { db } from "./db.ts"
import { hashPassword, verifyPassword } from "./password.ts"
import { tell, type RpcService } from "./rpc.ts"
import { botCall, telegramBot } from "./telegram-login.ts"
import { checkPassword, cleanDisplayName, cleanEmail, emailKey } from "./validate.ts"
import { proves, settings } from "./verification.ts"

/**
 * The account's own settings on the account page: its name, email, password and picture, and deleting it.
 *
 * Changing the email or password, and deleting, need proof that it is the owner: the password (when the account has
 * one) and, with two-step verification on, a code. Changing the email or password signs every other device out.
 */

export type Refusal = { error: string }
const refuse = (error: string): Refusal => ({ error })

const BASE = () => process.env.SERVICE_URL ?? "https://account.noctorium.xyz"

/** Whatever proves the owner is here: the password when the account has one, and a code when two-step is on. */
export async function proofProblem(userId: number, password: unknown, code: unknown): Promise<string | null> {
  const [user] = (await db()`SELECT password_hash FROM users WHERE id = ${userId}`) as { password_hash: string | null }[]
  if (!user) return "This account is gone."
  if (user.password_hash && !(typeof password === "string" && (await verifyPassword(password, user.password_hash)))) {
    return "That password is not right."
  }
  const twoStep = await settings(userId)
  if ((twoStep.totp || twoStep.telegram) && !(await proves(userId, code))) return "That code is not right."
  return null
}

/** Signs every device out but the one about to get a new token. */
async function signOthersOut(userId: number): Promise<void> {
  await db()`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ${userId}`
}

export async function rename(userId: number, name: unknown): Promise<Refusal | { name: string }> {
  const clean = cleanDisplayName(name, "")
  if (!clean) return refuse("Enter a name.")
  await db()`UPDATE users SET display_name = ${clean} WHERE id = ${userId}`
  return { name: clean }
}

export async function changeEmail(userId: number, email: unknown, password: unknown, code: unknown): Promise<Refusal | { email: string }> {
  const clean = cleanEmail(email)
  if (!clean) return refuse("Enter a valid email address.")
  const problem = await proofProblem(userId, password, code)
  if (problem) return refuse(problem)
  const taken = (await db()`SELECT 1 FROM users WHERE email_key = ${emailKey(clean)} AND id <> ${userId}`) as unknown[]
  if (taken.length) return refuse("Another account already uses that email address.")
  await db()`UPDATE users SET email = ${clean}, email_key = ${emailKey(clean)} WHERE id = ${userId}`
  await signOthersOut(userId)
  return { email: clean }
}

export async function changePassword(userId: number, current: unknown, next: unknown, code: unknown): Promise<Refusal | { ok: true }> {
  const [user] = (await db()`SELECT password_hash FROM users WHERE id = ${userId}`) as { password_hash: string | null }[]
  if (!user?.password_hash) return refuse("This account has no password yet: add one with an email first.")
  const checked = checkPassword(next)
  if ("error" in checked) return refuse(checked.error)
  const problem = await proofProblem(userId, current, code)
  if (problem) return refuse(problem)
  await db()`UPDATE users SET password_hash = ${await hashPassword(checked.password)} WHERE id = ${userId}`
  await signOthersOut(userId)
  return { ok: true }
}

export const DELETE_PHRASE = "delete my account"

/** Deletes the account and everything that hangs off it (every table cascades from users). */
export async function deleteAccount(userId: number, typed: unknown, password: unknown, code: unknown): Promise<Refusal | { ok: true }> {
  if (typeof typed !== "string" || typed.trim().toLowerCase() !== DELETE_PHRASE) return refuse(`Type "${DELETE_PHRASE}" to confirm.`)
  const problem = await proofProblem(userId, password, code)
  if (problem) return refuse(problem)
  // The status servers put the Telegram bio back and end the Discord status while the links still exist.
  const [linked] = (await db()`
    SELECT EXISTS (SELECT 1 FROM discord_links WHERE user_id = ${userId}) AS discord,
           EXISTS (SELECT 1 FROM telegram_links WHERE user_id = ${userId}) AS telegram
  `) as { discord: boolean; telegram: boolean }[]
  const services = (["discord", "telegram"] as RpcService[]).filter((s) => linked?.[s])
  await Promise.all(services.map((s) => tell(s, userId, null)))
  await db()`DELETE FROM users WHERE id = ${userId}`
  return { ok: true }
}

// --- Pictures

export const MAX_AVATAR_BYTES = 512 * 1024

/** The image type of [bytes] when it is a JPEG or PNG within the size limit; null otherwise. */
export function imageType(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  return null
}

export const avatarUrlFor = (key: string | null | undefined) => (key ? `${BASE()}/avatar/${key}` : null)

export async function setAvatar(userId: number, bytes: Uint8Array): Promise<Refusal | { avatarUrl: string }> {
  const type = imageType(bytes)
  if (!type) return refuse("Use a JPEG or PNG picture under 512 KB.")
  const key = randomBytes(18).toString("base64url")
  await db()`
    INSERT INTO avatars (user_id, image, content_type) VALUES (${userId}, ${Buffer.from(bytes)}, ${type})
    ON CONFLICT (user_id) DO UPDATE SET image = EXCLUDED.image, content_type = EXCLUDED.content_type, updated_at = now()
  `
  await db()`UPDATE users SET avatar_key = ${key} WHERE id = ${userId}`
  return { avatarUrl: avatarUrlFor(key)! }
}

export async function removeAvatar(userId: number): Promise<void> {
  await db()`DELETE FROM avatars WHERE user_id = ${userId}`
  await db()`UPDATE users SET avatar_key = NULL WHERE id = ${userId}`
}

export async function avatarByKey(key: string): Promise<{ image: Uint8Array; type: string } | null> {
  if (!/^[\w-]{10,64}$/.test(key)) return null
  const [row] = (await db()`
    SELECT a.image, a.content_type FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.avatar_key = ${key}
  `) as { image: Uint8Array; content_type: string }[]
  return row ? { image: row.image, type: row.content_type } : null
}

/** Downloads a picture from Discord's or Telegram's servers, refusing anything too big or not an image. */
async function download(url: string): Promise<Uint8Array | null> {
  const reply = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!reply?.ok) return null
  const bytes = new Uint8Array(await reply.arrayBuffer())
  return imageType(bytes) ? bytes : null
}

export async function useDiscordAvatar(userId: number): Promise<Refusal | { avatarUrl: string }> {
  const [row] = (await db()`SELECT avatar FROM identities WHERE user_id = ${userId} AND provider = 'discord'`) as { avatar: string | null }[]
  if (!row) return refuse("Link Discord first, under Ways to sign in.")
  if (!row.avatar) return refuse("Sign in with Discord once more, so Noctorium sees your Discord picture.")
  const bytes = await download(row.avatar)
  return bytes ? setAvatar(userId, bytes) : refuse("Discord did not give the picture. Try again in a moment.")
}

export async function useTelegramAvatar(userId: number): Promise<Refusal | { avatarUrl: string }> {
  const [row] = (await db()`SELECT provider_user_id FROM identities WHERE user_id = ${userId} AND provider = 'telegram'`) as { provider_user_id: string }[]
  if (!row) return refuse("Link Telegram first, under Ways to sign in.")
  const bot = telegramBot()
  if (!bot) return refuse("Telegram is not set up on this server.")
  const photos = await botCall(bot.token, "getUserProfilePhotos", { user_id: Number(row.provider_user_id), limit: 1 })
  const sizes = (photos.result as { photos?: { file_id: string; width: number }[][] } | undefined)?.photos?.[0]
  if (!sizes?.length) return refuse("Telegram shows no picture: you may have none, or your privacy settings hide it from bots.")
  // The smallest size at least 256 px wide, or the largest there is.
  const pick = [...sizes].sort((a, b) => a.width - b.width).find((s) => s.width >= 256) ?? sizes[sizes.length - 1]
  const file = await botCall(bot.token, "getFile", { file_id: pick.file_id })
  const path = (file.result as { file_path?: string } | undefined)?.file_path
  const bytes = path ? await download(`https://api.telegram.org/file/bot${bot.token}/${path}`) : null
  return bytes ? setAvatar(userId, bytes) : refuse("Telegram did not give the picture. Try again in a moment.")
}
