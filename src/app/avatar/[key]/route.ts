import { avatarByKey } from "@/lib/profile"

export const runtime = "nodejs"

/** A profile picture, public by its random key. A new picture gets a new key, so this never goes stale. */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const found = await avatarByKey((await params).key)
  if (!found) return new Response("No such picture.", { status: 404 })
  return new Response(Buffer.from(found.image), {
    headers: { "content-type": found.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  })
}
