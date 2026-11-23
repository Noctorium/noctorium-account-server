import { db } from "@/lib/db"
import { issueToken } from "@/lib/session"
import { challengeCookie, challengeFrom, cookieFor } from "@/lib/signed-in"
import { verify } from "@/lib/verification"
import { jsonError, readJson } from "@/lib/validate"

export const runtime = "nodejs"

/**
 * The codes for a sign-in waiting for them: `{"challenge"?, "totp"?, "telegram"?, "backup"?}`. Once enough is proved,
 * the account's token and user -- exactly what a sign-in without verification answers -- and this browser's session.
 */
export async function POST(request: Request) {
  const body = await readJson(request)
  if (!body) return jsonError("Send a JSON body.", 400)
  const ticket = typeof body.challenge === "string" ? body.challenge : challengeFrom(request)
  const result = ticket ? await verify(ticket, { totp: body.totp, telegram: body.telegram, backup: body.backup }) : { state: "gone" as const }

  if (result.state === "gone") {
    return Response.json(
      { error: "This sign-in has expired or had too many tries. Sign in again." },
      { status: 410, headers: { "Set-Cookie": challengeCookie("") } },
    )
  }
  if (result.state === "more") {
    return Response.json({ error: result.error, challenge: ticket, methods: result.methods, strict: result.strict, done: result.done }, { status: 401 })
  }

  const [user] = (await db()`SELECT id, email, display_name FROM users WHERE id = ${result.userId}`) as {
    id: number
    email: string | null
    display_name: string
  }[]
  if (!user) return jsonError("This account no longer exists.", 410)
  const email = user.email ?? ""
  const token = await issueToken({ userId: Number(user.id), email })
  const headers = new Headers()
  headers.append("Set-Cookie", cookieFor(token))
  headers.append("Set-Cookie", challengeCookie(""))
  return Response.json({ token, user: { id: Number(user.id), email, displayName: user.display_name }, next: result.next }, { headers })
}
