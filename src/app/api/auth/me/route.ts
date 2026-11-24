import { db } from "@/lib/db"
import { waysIn } from "@/lib/identity"
import { avatarUrlFor } from "@/lib/profile"
import { settings } from "@/lib/verification"
import { currentSession } from "@/lib/session"
import { jsonError } from "@/lib/validate"

export const runtime = "nodejs"

/** Who the caller is. The player uses this to tell a still-good saved token from a stale one. */
export async function GET(request: Request) {
  const session = await currentSession(request)
  if (!session) return jsonError("Not signed in.", 401)

  const found = await db()`SELECT id, email, display_name, created_at, avatar_key FROM users WHERE id = ${session.userId} LIMIT 1`
  if (found.length === 0) return jsonError("Not signed in.", 401)

  const user = found[0] as { id: number; email: string; display_name: string; created_at: string; avatar_key: string | null }
  // What an app's own account screen needs: which proofs a change asks for, and which pictures it can offer.
  const [ways, twoStep] = await Promise.all([waysIn(session.userId), settings(session.userId)])
  return Response.json({
    user: {
      id: Number(user.id),
      email: user.email ?? "",
      displayName: user.display_name,
      createdAt: user.created_at,
      avatarUrl: avatarUrlFor(user.avatar_key),
      hasPassword: ways.password,
      twoStep: { totp: twoStep.totp, telegram: twoStep.telegram },
      linked: { discord: Boolean(ways.linked.discord), telegram: Boolean(ways.linked.telegram) },
    },
  })
}
