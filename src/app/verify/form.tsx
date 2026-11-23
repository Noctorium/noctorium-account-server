"use client"

import Link from "next/link"
import { useState } from "react"

type Method = "totp" | "telegram"
const NAMES: Record<Method, string> = { totp: "Authenticator app", telegram: "Telegram" }

/**
 * One code, or in strict mode both. With both ways on and strict off, the listener picks which to use this time. A
 * backup code stands in for a way they cannot use.
 */
export default function VerifyForm({ methods, strict, done: alreadyDone }: { methods: Method[]; strict: boolean; done: string[] }) {
  const [chosen, setChosen] = useState<Method>(methods[0])
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [useBackup, setUseBackup] = useState(false)
  const [done, setDone] = useState<string[]>(alreadyDone)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)

  const asked: Method[] = strict ? methods.filter((m) => !done.includes(m)) : [chosen]

  async function sendTelegram() {
    setError(null)
    const reply = await fetch("/api/auth/challenge/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    if (reply.ok) setSent(true)
    else setError((await reply.json().catch(() => ({}))).error ?? "The code could not be sent.")
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const body = useBackup ? { backup: codes.backup } : Object.fromEntries(asked.map((m) => [m, codes[m]]))
    const reply = await fetch("/api/auth/challenge/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const said = await reply.json().catch(() => ({}))
    setBusy(false)
    if (reply.ok) return window.location.assign(said.next ?? "/dashboard")
    if (reply.status === 410) setGone(true)
    if (Array.isArray(said.done)) setDone(said.done)
    setCodes({})
    setError(said.error ?? "That did not work.")
  }

  if (gone) {
    return (
      <div className="card">
        <div className="error">{error}</div>
        <Link href="/login">Sign in again</Link>
      </div>
    )
  }

  return (
    <form className="card" onSubmit={submit}>
      {strict ? (
        <p className="muted">
          Strict mode is on: this sign-in needs both codes.
          {done.length > 0 && ` ${done.map((d) => NAMES[d as Method]).join(" and ")}: done.`}
        </p>
      ) : methods.length > 1 && !useBackup ? (
        <div className="choice" role="radiogroup" aria-label="Verify with">
          {methods.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={chosen === m} className={chosen === m ? "on" : ""} onClick={() => setChosen(m)}>
              {NAMES[m]}
            </button>
          ))}
        </div>
      ) : null}

      {useBackup ? (
        <>
          <label htmlFor="backup">Backup code</label>
          <input id="backup" autoComplete="off" placeholder="abcd-efgh" value={codes.backup ?? ""} onChange={(e) => setCodes({ backup: e.target.value })} required />
        </>
      ) : (
        asked.map((m) => (
          <div key={m}>
            <label htmlFor={m}>{m === "totp" ? "The code your authenticator app shows" : "The code Telegram sent you"}</label>
            <input
              id={m}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={codes[m] ?? ""}
              onChange={(e) => setCodes({ ...codes, [m]: e.target.value })}
              required
            />
            {m === "telegram" && (
              <button type="button" className="ghost" style={{ marginTop: 8 }} onClick={sendTelegram}>
                {sent ? "Send it again" : "Send me a code on Telegram"}
              </button>
            )}
          </div>
        ))
      )}

      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy}>
        {busy ? "Checking…" : "Continue"}
      </button>
      <p className="muted" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="linkish"
          onClick={() => {
            setUseBackup(!useBackup)
            setCodes({})
            setError(null)
          }}
        >
          {useBackup ? "Use my app or Telegram instead" : "Use a backup code"}
        </button>
      </p>
    </form>
  )
}
