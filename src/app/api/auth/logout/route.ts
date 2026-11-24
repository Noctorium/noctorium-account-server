import { clearedCookie } from "@/lib/signed-in"

export const runtime = "nodejs"

/** Clears the browser's cookie. A player's bearer token is discarded on its own side. */
export async function POST() {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedCookie() } })
}
