import { MAX_AVATAR_BYTES, setAvatar } from "@/lib/profile"
import { currentSession } from "@/lib/session"
import { jsonError } from "@/lib/validate"

export const runtime = "nodejs"

/** A new profile picture: the image itself as the body, already cropped and shrunk by the page. */
export async function POST(request: Request) {
  const session = await currentSession(request)
  if (!session) return jsonError("Not signed in.", 401)
  if (Number(request.headers.get("content-length") ?? 0) > MAX_AVATAR_BYTES) return jsonError("Use a picture under 512 KB.", 413)
  const result = await setAvatar(session.userId, new Uint8Array(await request.arrayBuffer()))
  return "error" in result ? jsonError(result.error, 400) : Response.json(result)
}
