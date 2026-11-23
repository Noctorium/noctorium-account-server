import { redirect } from "next/navigation"

/** The account page, which sends anybody not signed in to sign in first. */
export default function Home() {
  redirect("/dashboard")
}
