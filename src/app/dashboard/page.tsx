import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { SESSION_COOKIE, readToken } from "@/lib/session"
import SignOut from "./sign-out"
import { readyProviders, startUrl } from "../providers"
import { PROVIDER_NAMES, waysIn } from "@/lib/identity"
import { SITE_NAMES, SITES, linked as scrobblersOf } from "@/lib/scrobblers"
import Brand from "../brand"
import Security from "./security"
import { settings as securityOf } from "@/lib/verification"

export const dynamic = "force-dynamic"

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const said = await searchParams
  const jar = await cookies()
  const session = await readToken(jar.get(SESSION_COOKIE)?.value)
  if (!session) redirect("/login")

  const sql = db()
  const [profile] = (await sql`SELECT display_name FROM users WHERE id = ${session.userId} LIMIT 1`) as {
    display_name: string
  }[]
  if (!profile) redirect("/login")

  const [linkRow] = (await sql`
    SELECT (SELECT discord_name FROM discord_links WHERE user_id = ${session.userId}) AS discord,
           (SELECT telegram_name FROM telegram_links WHERE user_id = ${session.userId}) AS telegram
  `) as { discord: string | null; telegram: string | null }[]
  const links = { discord: linkRow?.discord ?? null, telegram: linkRow?.telegram ?? null }

  const ways = await waysIn(session.userId)
  const scrobblers = await scrobblersOf(session.userId)
  const security = await securityOf(session.userId)
  const available = readyProviders()
  const notice =
    said.linked ? `${PROVIDER_NAMES[said.linked as keyof typeof PROVIDER_NAMES] ?? said.linked} is linked: you can sign in with it now.`
      : said.taken ? `That ${PROVIDER_NAMES[said.taken as keyof typeof PROVIDER_NAMES] ?? said.taken} account already signs in to a different Noctorium account.`
        : said.unlinked ? `${PROVIDER_NAMES[said.unlinked as keyof typeof PROVIDER_NAMES] ?? said.unlinked} is unlinked.`
          : said.last ? "That is your only way to sign in, so it stays. Link another, or set a password, first."
            : said.password === "set" ? "Your password is set: you can sign in with your email too."
              : said.password ? said.password
                : said.discord === "connected" ? "Discord is connected: your status shows what you play."
                  : said.discord === "invalid_scope" ? "Discord did not allow showing your status from Noctorium yet."
                    : said.scrobbler === "linked" ? "Linked: every Noctorium you sign in to scrobbles there now."
                      : said.scrobbler === "unlinked" ? "Unlinked. Apps that already connected keep their own connection until you disconnect them there."
                        : said.scrobbler === "refused" ? "That did not link. Check the token, or try connecting again."
                          : null

  return (
    <main className="wrap">
      <div className="row">
        <Brand />
        <SignOut />
      </div>

      <h1>{profile.display_name}</h1>
      {notice && <div className="notice">{notice}</div>}
      <p className="lede">
        Your Noctorium account: how you sign in, how it is kept safe, and what it is linked to. Your listening figures are
        on <a href="https://stats.noctorium.xyz/dashboard">stats.noctorium.xyz</a>.
      </p>

      <h2>Ways to sign in</h2>
      <table className="ways">
        <tbody>
          <tr>
            <td>Email and password</td>
            <td className="muted">{ways.password ? ways.email : "Not set"}</td>
            <td className="num">{ways.password ? "" : "Set one below"}</td>
          </tr>
          {available.map((provider) => (
            <tr key={provider}>
              <td>{PROVIDER_NAMES[provider]}</td>
              <td className="muted">{ways.linked[provider] ?? "Not linked"}</td>
              <td className="num">
                {ways.linked[provider] ? (
                  <form method="post" action="/api/auth/unlink">
                    <input type="hidden" name="provider" value={provider} />
                    <button className="link" type="submit">Unlink</button>
                  </form>
                ) : (
                  <a href={startUrl(provider, "link", "/dashboard")}>Link</a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!ways.password && (
        <form className="card" method="post" action="/api/auth/password" style={{ marginTop: 14 }}>
          <p className="muted">Add a password, to sign in with your email as well.</p>
          {!ways.email && (
            <>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </>
          )}
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          <button type="submit">Set password</button>
        </form>
      )}

      <h2>Security</h2>
      <p className="muted">
        Two-step verification: after your password, Discord or Telegram, every sign-in also asks for a code from an
        authenticator app, or one the Noctorium bot sends you on Telegram. With both on, you pick either one each time, or
        turn on strict mode to need both.
      </p>
      <Security settings={security} telegramLinked={Boolean(ways.linked.telegram)} />

      <h2>Show what you play</h2>
      <p className="muted">
        Your Discord status and your Telegram bio show the song you are playing in Noctorium — from your phone or any
        device signed in to this account, with no computer needed.
      </p>
      <table>
        <tbody>
          {(["discord", "telegram"] as const).map((service) => {
            const linked = links[service]
            return (
              <tr key={service}>
                <td>{service === "discord" ? "Discord status" : "Telegram bio"}</td>
                <td className="muted">{linked ? `Connected as ${linked}` : "Not connected"}</td>
                <td className="num">
                  <a href={`/api/rpc/connect?service=${service}&action=${linked ? "disconnect" : "connect"}`}>
                    {linked ? "Disconnect" : "Connect"}
                  </a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <h2>Scrobbling</h2>
      <p className="muted">
        Link Last.fm and ListenBrainz once, and every Noctorium you sign in to scrobbles there: the desktop, phone, TV,
        terminal and Noctorium Rust connect by themselves, and for Noctorium Lite, the iPhone and the web player this
        service scrobbles for you.
      </p>
      <table className="ways">
        <tbody>
          {SITES.map((site) => {
            const link = scrobblers.find((s) => s.site === site)
            return (
              <tr key={site}>
                <td>{SITE_NAMES[site]}</td>
                <td className="muted">{link ? `Linked as ${link.username}` : "Not linked"}</td>
                <td className="num">
                  {link ? (
                    <form method="post" action={`/api/scrobblers/${site}`}>
                      <input type="hidden" name="unlink" value="1" />
                      <button className="link" type="submit">Unlink</button>
                    </form>
                  ) : site === "lastfm" ? (
                    <a href="/api/scrobblers/lastfm/start">Connect</a>
                  ) : (
                    "Paste your token below"
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!scrobblers.some((s) => s.site === "listenbrainz") && (
        <form className="card" method="post" action="/api/scrobblers/listenbrainz" style={{ marginTop: 14 }}>
          <label htmlFor="lb-token">ListenBrainz user token</label>
          <input id="lb-token" name="token" autoComplete="off" required />
          <p className="muted">
            From <a href="https://listenbrainz.org/settings/">listenbrainz.org/settings</a>. It is kept sealed, and sent only to
            ListenBrainz and to your own signed-in Noctorium apps.
          </p>
          <button type="submit">Link ListenBrainz</button>
        </form>
      )}
    </main>
  )
}
