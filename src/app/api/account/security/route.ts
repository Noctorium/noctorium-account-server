import QRCode from "qrcode"
import { db } from "@/lib/db"
import { bucket, tooManyAttempts } from "@/lib/rate-limit"
import { consume } from "@/lib/rate-limit-store"
import { currentSession } from "@/lib/session"
import { jsonError, readJson } from "@/lib/validate"
import {
  beginTotp,
  confirmTotp,
  newBackupCodesFor,
  otpauthUrl,
  proves,
  sendSetupCode,
  setStrict,
  setTelegram,
  settings,
  telegramSetupMatches,
  turnOffTotp,
} from "@/lib/verification"

export const runtime = "nodejs"

const LIMIT = { limit: 20, windowSeconds: 15 * 60 }

/**
 * The account page's Security section, one action at a time: `{"action", "code"?, "on"?}`. Turning a way on proves it
 * works (a code from the new authenticator, or the code Telegram was sent); weakening anything -- turning a way or strict
 * mode off, or new backup codes -- needs a code the listener has now.
 */
export async function POST(request: Request) {
  const session = await currentSession(request)
  if (!session) return jsonError("Not signed in.", 401)
  const tries = await consume(bucket("security", String(session.userId)), LIMIT)
  if (!tries.allowed) return tooManyAttempts(tries.retryAfterSeconds)
  const body = await readJson(request)
  if (!body) return jsonError("Send a JSON body.", 400)
  const id = session.userId
  const now = await settings(id)
  const refused = (message: string) => jsonError(message, 400)

  switch (body.action) {
    case "totp-start": {
      if (now.totp) return refused("The authenticator is on already.")
      const [user] = (await db()`SELECT email, display_name FROM users WHERE id = ${id}`) as { email: string | null; display_name: string }[]
      const secret = await beginTotp(id)
      const url = otpauthUrl(secret, user?.email || user?.display_name || "account")
      return Response.json({ secret, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) })
    }
    case "totp-confirm": {
      const backupCodes = await confirmTotp(id, body.code)
      return backupCodes ? Response.json({ backupCodes }) : refused("That code does not match. Check the app's clock, and try the newest code.")
    }
    case "totp-off":
      if (!(await proves(id, body.code))) return refused("That code is not right.")
      await turnOffTotp(id)
      return Response.json({ ok: true })
    case "backup-new":
      if (!now.totp) return refused("Backup codes come with the authenticator: turn it on first.")
      if (!(await proves(id, body.code))) return refused("That code is not right.")
      return Response.json({ backupCodes: await newBackupCodesFor(id) })
    case "telegram-send": {
      const sent = await sendSetupCode(id)
      if (sent === "no-telegram") return refused("Link Telegram to your account first, under Ways to sign in.")
      if (sent === "failed") return refused("The bot could not send it. Open @NoctoriumLoginBot in Telegram, press Start, and try again.")
      return Response.json({ ok: true })
    }
    case "telegram-on":
      if (!(await telegramSetupMatches(id, body.code))) return refused("That is not the code Telegram sent, or it has expired.")
      await setTelegram(id, true)
      return Response.json({ ok: true })
    case "telegram-off":
      if (!(await proves(id, body.code))) return refused("That code is not right.")
      await setTelegram(id, false)
      return Response.json({ ok: true })
    case "strict":
      if (body.on === true) {
        return (await setStrict(id, true)) ? Response.json({ ok: true }) : refused("Strict mode needs both the authenticator and Telegram on.")
      }
      if (!(await proves(id, body.code))) return refused("That code is not right.")
      await setStrict(id, false)
      return Response.json({ ok: true })
    default:
      return refused("Unknown action.")
  }
}
