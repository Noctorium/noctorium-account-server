import { challengeFrom } from "@/lib/signed-in"
import { sendChallengeCode } from "@/lib/verification"
import { jsonError, readJson } from "@/lib/validate"

export const runtime = "nodejs"

/** Sends the Telegram code for a sign-in waiting for its codes: `{"challenge"}` from an app, or this browser's cookie. */
export async function POST(request: Request) {
  const body = await readJson(request)
  const ticket = typeof body?.challenge === "string" ? body.challenge : challengeFrom(request)
  if (!ticket) return jsonError("No sign-in is waiting for a code. Sign in again.", 410)
  if (!(await sendChallengeCode(ticket))) {
    return jsonError("The Telegram code could not be sent. Use another way, or sign in again.", 400)
  }
  return new Response(null, { status: 204 })
}
