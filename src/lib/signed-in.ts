import { link, signInWith, type ProviderProfile } from "./identity"
import { safeNext, type Intent } from "./oauth"
import { currentSession, issueToken, sessionCookie } from "./session"
import { startChallenge } from "./verification.ts"

/** A redirect that also sets (or keeps) the session cookie. */
function redirect(to: string, request: Request, cookie?: string): Response {
  const headers = new Headers({ location: new URL(to, request.url).toString() })
  if (cookie) headers.append("set-cookie", cookie)
  return new Response(null, { status: 303, headers })
}

/** The session cookie as a Set-Cookie header: for this site and, in production, every noctorium.xyz site. */
export function cookieFor(token: string): string {
  const c = sessionCookie(token)
  return [`${c.name}=${c.value}`, `Path=${c.path}`, `Max-Age=${c.maxAge}`, "HttpOnly", "SameSite=Lax", ...(c.secure ? ["Secure"] : []), ...(c.domain ? [`Domain=${c.domain}`] : [])].join("; ")
}

/** A sign-in waiting for its codes, held by this browser alone for the ten minutes it lasts. */
export const CHALLENGE_COOKIE = "noctorium_challenge"

export function challengeCookie(ticket: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${CHALLENGE_COOKIE}=${ticket}; Path=/; Max-Age=${ticket ? 600 : 0}; HttpOnly; SameSite=Lax${secure}`
}

export const challengeFrom = (request: Request) =>
  request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CHALLENGE_COOKIE}=`))
    ?.slice(CHALLENGE_COOKIE.length + 1) || null

/**
 * What happens once Discord or Telegram has said who somebody is: signing them in (to the account it is
 * linked to, or a new one) and going on to `next`; or, when they were linking it from the dashboard, adding it to the
 * account they are signed in to.
 */
export async function finish(request: Request, profile: ProviderProfile, intent: Intent, next: string): Promise<Response> {
  if (intent === "link") {
    const session = await currentSession(request)
    if (!session) return redirect("/login", request)
    const result = await link(session.userId, profile)
    return redirect(`/dashboard?${result === "taken" ? "taken" : "linked"}=${profile.provider}`, request)
  }
  const user = await signInWith(profile)
  // Two-step verification on: the codes first, on /verify, and only then the session.
  const challenge = await startChallenge(user.id, safeNext(next))
  if (challenge) return redirect("/verify", request, challengeCookie(challenge.ticket))
  const token = await issueToken({ userId: user.id, email: user.email })
  return redirect(safeNext(next), request, cookieFor(token))
}

export { redirect }
