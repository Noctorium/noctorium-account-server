import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import Brand from "../brand"
import { CHALLENGE_COOKIE } from "@/lib/signed-in"
import { challenge } from "@/lib/verification"
import VerifyForm from "./form"

export const dynamic = "force-dynamic"

/** After the password, Discord or Telegram: the codes the account's two-step verification asks for. */
export default async function Verify() {
  const waiting = await challenge((await cookies()).get(CHALLENGE_COOKIE)?.value)
  if (!waiting) redirect("/login")
  const methods = [...(waiting.settings.totp ? ["totp"] : []), ...(waiting.settings.telegram ? ["telegram"] : [])] as ("totp" | "telegram")[]
  return (
    <main className="wrap narrow">
      <Brand />
      <h1>Two-step verification</h1>
      <VerifyForm methods={methods} strict={waiting.settings.strict} done={waiting.done} />
    </main>
  )
}
