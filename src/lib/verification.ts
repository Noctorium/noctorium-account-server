import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { db } from "./db.ts"
import { seal, unseal } from "./seal.ts"
import { botCall, telegramBot } from "./telegram-login.ts"

/**
 * Two-step verification for the Noctorium account.
 *
 * Two ways, each on or off: an authenticator app (TOTP, RFC 6238), and a code the login bot sends on Telegram. With one
 * on, every sign-in -- password, Discord or Telegram -- asks for it; with both, the listener picks either one each time,
 * or, in strict mode, must give both. A backup code stands in for either way, once. A sign-in waiting for its codes is a
 * challenge: a random ticket, of which only the hash is kept, lasting ten minutes, with a few attempts.
 */

export type Method = "totp" | "telegram"
export type Settings = { totp: boolean; telegram: boolean; strict: boolean }

const PURPOSE = "noctorium-two-factor"
const STEP_SECONDS = 30
const CHALLENGE_SECONDS = 10 * 60
const TELEGRAM_CODE_SECONDS = 10 * 60
const MAX_ATTEMPTS = 8
const BACKUP_CODES = 10

/** What an app from before 0.39 shows, in the `error` field it already shows: it has no step to enter a code in. */
export const OLD_APP_MESSAGE =
  "This account uses two-step verification. Update Noctorium to enter your code here, or use Sign in with Discord or Telegram."

const hash = (text: string) => createHash("sha256").update(text).digest("base64url")
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const digits = (code: unknown) => (typeof code === "string" ? code.replace(/\s/g, "") : "")

// --- The authenticator app ---

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function fromBase32(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text.toUpperCase().replace(/[\s=]/g, "")) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error("Not base32")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The code for [secret] at time-step [step] (RFC 4226 over RFC 6238's 30-second steps), [length] digits. */
export function totpAt(secret: Buffer, step: number, length = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac(algorithm, secret).update(counter).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const number = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(number % 10 ** length).padStart(length, "0")
}

/** Whether [code] is the authenticator's for now, or the step either side of it, for a clock a little off. */
export function totpMatches(secretBase32: string, code: unknown, now = Date.now()): boolean {
  const given = digits(code)
  if (!/^\d{6}$/.test(given)) return false
  const secret = fromBase32(secretBase32)
  const step = Math.floor(now / 1000 / STEP_SECONDS)
  // shortcut: a code can be used again within its 90-second window; each challenge is single-use, which bounds it.
  return [-1, 0, 1].some((d) => same(totpAt(secret, step + d), given))
}

export const otpauthUrl = (secretBase32: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`Noctorium:${account}`)}?secret=${secretBase32}&issuer=Noctorium`

// --- Backup codes ---

const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

export function newBackupCodes(): string[] {
  const one = () => Array.from({ length: 8 }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]).join("")
  return Array.from({ length: BACKUP_CODES }, () => {
    const code = one()
    return `${code.slice(0, 4)}-${code.slice(4)}`
  })
}

const backupHash = (code: string) => hash(`backup:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`)

/** Uses up [code] if it is one of [userId]'s backup codes: true once, false after. */
async function useBackupCode(userId: number, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || code.replace(/[^a-z0-9]/gi, "").length !== 8) return false
  const rows = (await db()`
    UPDATE two_factor SET backup_codes = array_remove(backup_codes, ${backupHash(code)}), updated_at = now()
    WHERE user_id = ${userId} AND ${backupHash(code)} = ANY(backup_codes)
    RETURNING user_id
  `) as unknown[]
  return rows.length > 0
}

// --- What an account has on ---

type Row = {
  totp_secret: string | null
  totp_pending: string | null
  telegram: boolean
  strict: boolean
  backup_codes: string[]
  setup_code: string | null
  setup_expires: string | null
}

async function row(userId: number): Promise<Row | null> {
  const [found] = (await db()`SELECT * FROM two_factor WHERE user_id = ${userId}`) as Row[]
  return found ?? null
}

export async function settings(userId: number): Promise<Settings & { backupCodesLeft: number }> {
  const r = await row(userId)
  const totp = Boolean(r?.totp_secret)
  const telegram = Boolean(r?.telegram)
  return { totp, telegram, strict: Boolean(r?.strict) && totp && telegram, backupCodesLeft: r?.backup_codes.length ?? 0 }
}

/** Which ways an account can be verified by, the ones a challenge offers. */
const methodsOf = (s: Settings): Method[] => [...(s.totp ? ["totp" as const] : []), ...(s.telegram ? ["telegram" as const] : [])]

/** Whether what is proved finishes a sign-in: everything in strict mode, any one way otherwise. */
export function enough(s: Settings, done: string[]): boolean {
  const methods = methodsOf(s)
  if (methods.length === 0) return true
  return s.strict ? methods.every((m) => done.includes(m)) : methods.some((m) => done.includes(m))
}

async function totpSecretOf(userId: number): Promise<string | null> {
  const sealed = (await row(userId))?.totp_secret
  return sealed ? unseal(sealed, PURPOSE) : null
}

/** The Telegram account the bot sends codes to: the one linked as a way to sign in. */
export async function telegramIdOf(userId: number): Promise<string | null> {
  const [found] = (await db()`
    SELECT provider_user_id FROM identities WHERE user_id = ${userId} AND provider = 'telegram' LIMIT 1
  `) as { provider_user_id: string }[]
  return found?.provider_user_id ?? null
}

async function sendTelegram(telegramId: string, text: string): Promise<boolean> {
  const bot = telegramBot()
  if (!bot) return false
  return (await botCall(bot.token, "sendMessage", { chat_id: Number(telegramId), text })).ok
}

const newTelegramCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0")

// --- Challenges: a sign-in waiting for its codes ---

export type Challenge = { userId: number; next: string; done: string[]; settings: Settings; attempts: number }

/** A challenge for [userId], or null when the account has no verification on and the sign-in can simply finish. */
export async function startChallenge(userId: number, next = "/dashboard"): Promise<{ ticket: string; methods: Method[]; strict: boolean } | null> {
  const s = await settings(userId)
  const methods = methodsOf(s)
  if (methods.length === 0) return null
  const ticket = randomBytes(32).toString("base64url")
  await db()`
    INSERT INTO sign_in_challenges (id, user_id, next, expires_at)
    VALUES (${hash(ticket)}, ${userId}, ${next}, now() + make_interval(secs => ${CHALLENGE_SECONDS}))
  `
  await db()`DELETE FROM sign_in_challenges WHERE expires_at < now() - interval '1 hour'`
  return { ticket, methods, strict: s.strict }
}

export async function challenge(ticket: string | null | undefined): Promise<Challenge | null> {
  if (!ticket) return null
  const [found] = (await db()`
    SELECT user_id, next, done, attempts FROM sign_in_challenges WHERE id = ${hash(ticket)} AND expires_at > now()
  `) as { user_id: number; next: string; done: string[]; attempts: number }[]
  if (!found || found.attempts >= MAX_ATTEMPTS) return null
  return { userId: Number(found.user_id), next: found.next, done: found.done, settings: await settings(Number(found.user_id)), attempts: found.attempts }
}

/** Sends the Telegram code for [ticket]'s sign-in. False when Telegram verification is off or the bot could not send. */
export async function sendChallengeCode(ticket: string): Promise<boolean> {
  const c = await challenge(ticket)
  const telegramId = c?.settings.telegram ? await telegramIdOf(c.userId) : null
  if (!c || !telegramId) return false
  const code = newTelegramCode()
  await db()`
    UPDATE sign_in_challenges SET telegram_code = ${hash(code)}, telegram_expires = now() + make_interval(secs => ${TELEGRAM_CODE_SECONDS})
    WHERE id = ${hash(ticket)}
  `
  return sendTelegram(telegramId, `Your Noctorium sign-in code is ${code}. It lasts ten minutes. Never share it: Noctorium will never ask you for it.`)
}

export type Codes = { totp?: unknown; telegram?: unknown; backup?: unknown }
export type Verified =
  | { state: "done"; userId: number; next: string }
  | { state: "more"; done: string[]; methods: Method[]; strict: boolean; error: string }
  | { state: "gone" }

/**
 * Checks what was given against [ticket]'s sign-in. Whatever is right counts, and stays counted for the next try, so in
 * strict mode the two codes can come one at a time. Done once enough is proved; then the ticket is used up.
 */
export async function verify(ticket: string, codes: Codes): Promise<Verified> {
  const c = await challenge(ticket)
  if (!c) return { state: "gone" }
  await db()`UPDATE sign_in_challenges SET attempts = attempts + 1 WHERE id = ${hash(ticket)}`
  const done = new Set(c.done)
  let wrong = false

  if (codes.totp != null && digits(codes.totp)) {
    const secret = c.settings.totp ? await totpSecretOf(c.userId) : null
    if (secret && totpMatches(secret, codes.totp)) done.add("totp")
    else wrong = true
  }
  if (codes.telegram != null && digits(codes.telegram)) {
    const [sent] = (await db()`
      SELECT telegram_code FROM sign_in_challenges WHERE id = ${hash(ticket)} AND telegram_expires > now()
    `) as { telegram_code: string | null }[]
    if (c.settings.telegram && sent?.telegram_code && same(sent.telegram_code, hash(digits(codes.telegram)))) done.add("telegram")
    else wrong = true
  }
  if (typeof codes.backup === "string" && codes.backup.trim()) {
    // Stands in for whichever way is still missing: the authenticator first, as the one a lost phone takes with it.
    const missing = methodsOf(c.settings).find((m) => !done.has(m))
    if (missing && (await useBackupCode(c.userId, codes.backup))) done.add(missing)
    else wrong = true
  }

  const proved = [...done]
  if (enough(c.settings, proved)) {
    await db()`DELETE FROM sign_in_challenges WHERE id = ${hash(ticket)}`
    return { state: "done", userId: c.userId, next: c.next }
  }
  await db()`UPDATE sign_in_challenges SET done = ${proved} WHERE id = ${hash(ticket)}`
  const methods = methodsOf(c.settings)
  const error = wrong
    ? "That code is not right, or it has expired."
    : c.settings.strict
      ? "Strict mode is on: both codes are needed."
      : "Enter a code to finish signing in."
  return { state: "more", done: proved, methods, strict: c.settings.strict, error }
}

// --- Changing the settings, from the account page ---

/** Whether [code] is the one [sendSetupCode] sent to Telegram, still fresh; used up when it is. */
export async function telegramSetupMatches(userId: number, code: unknown): Promise<boolean> {
  const r = await row(userId)
  if (!r?.setup_code || !r.setup_expires || new Date(r.setup_expires) <= new Date() || !same(r.setup_code, hash(digits(code)))) return false
  await db()`UPDATE two_factor SET setup_code = NULL, setup_expires = NULL WHERE user_id = ${userId}`
  return true
}

/** Proof that it is the listener changing their security: an authenticator code, a backup code or a sent Telegram code. */
export async function proves(userId: number, code: unknown): Promise<boolean> {
  const r = await row(userId)
  const secret = r?.totp_secret ? unseal(r.totp_secret, PURPOSE) : null
  if (secret && totpMatches(secret, code)) return true
  if (await telegramSetupMatches(userId, code)) return true
  return useBackupCode(userId, code)
}

/** A new authenticator secret, waiting to be confirmed with a code from the app it was scanned into. */
export async function beginTotp(userId: number): Promise<string> {
  const secret = base32(randomBytes(20))
  await db()`
    INSERT INTO two_factor (user_id, totp_pending) VALUES (${userId}, ${seal(secret, PURPOSE)})
    ON CONFLICT (user_id) DO UPDATE SET totp_pending = EXCLUDED.totp_pending, updated_at = now()
  `
  return secret
}

/** Turns the authenticator on once [code] matches the waiting secret; the new backup codes, shown once, or null. */
export async function confirmTotp(userId: number, code: unknown): Promise<string[] | null> {
  const pending = (await row(userId))?.totp_pending
  const secret = pending ? unseal(pending, PURPOSE) : null
  if (!secret || !totpMatches(secret, code)) return null
  const codes = newBackupCodes()
  await db()`
    UPDATE two_factor SET totp_secret = totp_pending, totp_pending = NULL, backup_codes = ${codes.map(backupHash)}, updated_at = now()
    WHERE user_id = ${userId}
  `
  return codes
}

export async function newBackupCodesFor(userId: number): Promise<string[]> {
  const codes = newBackupCodes()
  await db()`UPDATE two_factor SET backup_codes = ${codes.map(backupHash)}, updated_at = now() WHERE user_id = ${userId}`
  return codes
}

/** Sends a code to the linked Telegram, for turning Telegram verification on, or as proof for a change. */
export async function sendSetupCode(userId: number): Promise<"sent" | "no-telegram" | "failed"> {
  const telegramId = await telegramIdOf(userId)
  if (!telegramId) return "no-telegram"
  const code = newTelegramCode()
  await db()`
    INSERT INTO two_factor (user_id, setup_code, setup_expires)
    VALUES (${userId}, ${hash(code)}, now() + make_interval(secs => ${TELEGRAM_CODE_SECONDS}))
    ON CONFLICT (user_id) DO UPDATE SET setup_code = EXCLUDED.setup_code, setup_expires = EXCLUDED.setup_expires
  `
  const ok = await sendTelegram(telegramId, `Your Noctorium code is ${code}, to change your account's security. It lasts ten minutes. If this was not you, ignore it.`)
  return ok ? "sent" : "failed"
}

export async function setTelegram(userId: number, on: boolean): Promise<void> {
  await db()`
    INSERT INTO two_factor (user_id, telegram) VALUES (${userId}, ${on})
    ON CONFLICT (user_id) DO UPDATE SET telegram = EXCLUDED.telegram, strict = two_factor.strict AND EXCLUDED.telegram, updated_at = now()
  `
}

export async function turnOffTotp(userId: number): Promise<void> {
  await db()`
    UPDATE two_factor SET totp_secret = NULL, totp_pending = NULL, backup_codes = '{}', strict = false, updated_at = now()
    WHERE user_id = ${userId}
  `
}

/** Strict: both ways at every sign-in. Only with both on; switching it off is a change that needs proof, like the rest. */
export async function setStrict(userId: number, on: boolean): Promise<boolean> {
  const s = await settings(userId)
  if (on && !(s.totp && s.telegram)) return false
  await db()`UPDATE two_factor SET strict = ${on}, updated_at = now() WHERE user_id = ${userId}`
  return true
}
