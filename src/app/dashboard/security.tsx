"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

type Settings = { totp: boolean; telegram: boolean; strict: boolean; backupCodesLeft: number }

/** What is being done right now: nothing, or one step that needs a code, a QR code, or new backup codes to show. */
type Step =
  | { kind: "idle" }
  | { kind: "totp-setup"; qr: string; secret: string }
  | { kind: "code"; action: string; label: string; telegramCode: boolean; on?: boolean }
  | { kind: "backup"; codes: string[] }

async function act(body: object): Promise<{ ok: boolean; said: Record<string, unknown> }> {
  const reply = await fetch("/api/account/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { ok: reply.ok, said: await reply.json().catch(() => ({})) }
}

/**
 * Two-step verification on the account page: the authenticator app, Telegram codes, and strict mode, which asks for both
 * at every sign-in. Turning a way on proves it works; turning anything off needs a code the listener has now.
 */
export default function Security({ settings, telegramLinked }: { settings: Settings; telegramLinked: boolean }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>({ kind: "idle" })
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setStep({ kind: "idle" })
    setCode("")
    setError(null)
  }
  const done = () => {
    reset()
    router.refresh()
  }

  async function run(body: object, then: (said: Record<string, unknown>) => void) {
    setBusy(true)
    setError(null)
    const { ok, said } = await act(body)
    setBusy(false)
    if (ok) then(said)
    else setError(String(said.error ?? "That did not work."))
  }

  const askFor = (action: string, label: string, telegramCode: boolean, on?: boolean) => {
    reset()
    setStep({ kind: "code", action, label, telegramCode, on })
  }

  const sendTelegram = () => run({ action: "telegram-send" }, () => setError("Sent. Check Telegram."))

  return (
    <>
      <table className="ways security">
        <tbody>
          <tr>
            <td>Authenticator app</td>
            <td className="muted">{settings.totp ? `On · ${settings.backupCodesLeft} backup codes left` : "Off"}</td>
            <td className="num">
              {settings.totp ? (
                <>
                  <button className="link" type="button" onClick={() => askFor("backup-new", "A code from your app, to make new backup codes", true)}>New backup codes</button>
                  {" · "}
                  <button className="link" type="button" onClick={() => askFor("totp-off", "A code from your app or a backup code, to turn it off", true)}>Turn off</button>
                </>
              ) : (
                <button className="link" type="button" onClick={() => run({ action: "totp-start" }, (s) => setStep({ kind: "totp-setup", qr: String(s.qr), secret: String(s.secret) }))}>
                  Turn on
                </button>
              )}
            </td>
          </tr>
          <tr>
            <td>Telegram codes</td>
            <td className="muted">{settings.telegram ? "On: @NoctoriumLoginBot sends a code" : telegramLinked ? "Off" : "Link Telegram above first"}</td>
            <td className="num">
              {settings.telegram ? (
                <button className="link" type="button" onClick={() => askFor("telegram-off", "A code from your app, a backup code, or one sent to Telegram", true)}>Turn off</button>
              ) : telegramLinked ? (
                <button className="link" type="button" onClick={() => run({ action: "telegram-send" }, () => setStep({ kind: "code", action: "telegram-on", label: "The code Telegram just sent you", telegramCode: true }))}>
                  Turn on
                </button>
              ) : null}
            </td>
          </tr>
          {settings.totp && settings.telegram && (
            <tr>
              <td>Strict mode</td>
              <td className="muted">{settings.strict ? "On: every sign-in needs both codes" : "Off: either code is enough"}</td>
              <td className="num">
                {settings.strict ? (
                  <button className="link" type="button" onClick={() => askFor("strict", "A code, to turn strict mode off", true, false)}>Turn off</button>
                ) : (
                  <button className="link" type="button" onClick={() => run({ action: "strict", on: true }, done)}>Turn on</button>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {step.kind === "totp-setup" && (
        <form
          className="card"
          style={{ marginTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault()
            run({ action: "totp-confirm", code }, (s) => setStep({ kind: "backup", codes: s.backupCodes as string[] }))
          }}
        >
          <p className="muted">Scan this with your authenticator app (Google Authenticator, Aegis, 2FAS, 1Password…), then type the code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr" src={step.qr} width={220} height={220} alt="QR code for your authenticator app" />
          <p className="muted" style={{ textAlign: "center", wordBreak: "break-all" }}>Or enter this key: <code>{step.secret}</code></p>
          <label htmlFor="totp-code">The code your app shows</label>
          <input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={busy}>Turn on</button>
          <button type="button" className="ghost" style={{ marginTop: 8, width: "100%" }} onClick={reset}>Cancel</button>
        </form>
      )}

      {step.kind === "code" && (
        <form
          className="card"
          style={{ marginTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault()
            run(step.on === undefined ? { action: step.action, code } : { action: step.action, code, on: step.on }, (s) =>
              Array.isArray(s.backupCodes) ? setStep({ kind: "backup", codes: s.backupCodes as string[] }) : done(),
            )
          }}
        >
          <label htmlFor="security-code">{step.label}</label>
          <input id="security-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          {step.telegramCode && telegramLinked && step.action !== "telegram-on" && (
            <button type="button" className="ghost" style={{ marginTop: 8 }} onClick={sendTelegram}>Send me a code on Telegram</button>
          )}
          {error && <div className={error.startsWith("Sent") ? "muted" : "error"}>{error}</div>}
          <button type="submit" disabled={busy}>Continue</button>
          <button type="button" className="ghost" style={{ marginTop: 8, width: "100%" }} onClick={reset}>Cancel</button>
        </form>
      )}

      {step.kind === "backup" && (
        <div className="card" style={{ marginTop: 14 }}>
          <p>Your backup codes. Each works once, in place of a code from your app or Telegram. Keep them somewhere safe: they are not shown again.</p>
          <div className="codes">{step.codes.map((c) => <span key={c}>{c}</span>)}</div>
          <button type="button" onClick={done}>I have saved them</button>
        </div>
      )}

      {step.kind === "idle" && error && <div className="error">{error}</div>}
    </>
  )
}
