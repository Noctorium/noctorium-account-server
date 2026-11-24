import { bucket, tooManyAttempts } from "@/lib/rate-limit"
import { consume } from "@/lib/rate-limit-store"
import { changeEmail, changePassword, deleteAccount, removeAvatar, rename, useDiscordAvatar, useTelegramAvatar } from "@/lib/profile"
import { currentSession, issueToken } from "@/lib/session"
import { clearedCookie, cookieFor } from "@/lib/signed-in"
import { jsonError, readJson } from "@/lib/validate"

export const runtime = "nodejs"

const LIMIT = { limit: 20, windowSeconds: 15 * 60 }

/**
 * The account page's Profile section, one action at a time: `{"action", ...}`. A change of email or password signs
 * every other device out and gives this browser a fresh session; deleting clears it.
 */
export async function POST(request: Request) {
  const session = await currentSession(request)
  if (!session) return jsonError("Not signed in.", 401)
  const tries = await consume(bucket("profile", String(session.userId)), LIMIT)
  if (!tries.allowed) return tooManyAttempts(tries.retryAfterSeconds)
  const body = await readJson(request)
  if (!body) return jsonError("Send a JSON body.", 400)
  const id = session.userId

  /** The reply; with [freshEmail], this browser also gets a new session, since the others were just signed out. */
  const answer = async (result: object, freshEmail?: string) => {
    if ("error" in result) return jsonError(String(result.error), 400)
    if (freshEmail === undefined) return Response.json(result)
    const token = await issueToken({ userId: id, email: freshEmail })
    return Response.json(result, { headers: { "Set-Cookie": cookieFor(token) } })
  }

  switch (body.action) {
    case "name":
      return answer(await rename(id, body.name))
    case "email": {
      const result = await changeEmail(id, body.email, body.password, body.code)
      return answer(result, "email" in result ? result.email : undefined)
    }
    case "password": {
      const result = await changePassword(id, body.current, body.password, body.code)
      return answer(result, "ok" in result ? session.email : undefined)
    }
    case "delete": {
      const result = await deleteAccount(id, body.confirm, body.password, body.code)
      if ("error" in result) return jsonError(result.error, 400)
      return Response.json(result, { headers: { "Set-Cookie": clearedCookie() } })
    }
    case "avatar-discord":
      return answer(await useDiscordAvatar(id))
    case "avatar-telegram":
      return answer(await useTelegramAvatar(id))
    case "avatar-remove":
      await removeAvatar(id)
      return Response.json({ avatarUrl: null })
    default:
      return jsonError("Unknown action.", 400)
  }
}
