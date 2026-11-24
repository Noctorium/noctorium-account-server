"use client"

import { useRouter } from "next/navigation"
import { useRef, useState } from "react"

type Props = {
  name: string
  email: string | null
  avatarUrl: string | null
  hasPassword: boolean
  /** Two-step verification is on: sensitive changes also need a code. */
  twoStep: boolean
  /** Telegram codes are one of the ways, so a code can be sent there. */
  telegramCodes: boolean
  discordLinked: boolean
  telegramLinked: boolean
}

type Editing = "none" | "name" | "email" | "password" | "delete"

async function act(body: object): Promise<{ ok: boolean; said: Record<string, unknown> }> {
  const reply = await fetch("/api/account/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { ok: reply.ok, said: await reply.json().catch(() => ({})) }
}

/** The picture, cropped to the middle square and shrunk to 256 px, as a JPEG: small enough to keep in the database. */
async function squareJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 256
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error("no image"))), "image/jpeg", 0.88))
}

export function Avatar({ url, name, size }: { url: string | null; name: string; size: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="avatar" src={url} width={size} height={size} alt="" />
  ) : (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden>
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  )
}

/**
 * The account's own settings: picture, name, email, password, and deleting it. The email, password and deleting need
 * the password (when there is one) and, with two-step verification on, a code.
 */
export default function Profile(p: Props) {
  const router = useRouter()
  const file = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<Editing>("none")
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const field = (key: string) => ({ value: fields[key] ?? "", onChange: (e: { target: { value: string } }) => setFields({ ...fields, [key]: e.target.value }) })
  const open = (what: Editing) => {
    setEditing(what)
    setFields(what === "name" ? { name: p.name } : {})
    setError(null)
  }

  async function run(body: object, then?: () => void) {
    setBusy(true)
    setError(null)
    const { ok, said } = await act(body)
    setBusy(false)
    if (!ok) return setError(String(said.error ?? "That did not work."))
    setEditing("none")
    if (then) then()
    else router.refresh()
  }

  async function upload(chosen: File | undefined) {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      const reply = await fetch("/api/account/avatar", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: await squareJpeg(chosen) })
      if (!reply.ok) setError(String((await reply.json().catch(() => ({}))).error ?? "That picture did not upload."))
      else router.refresh()
    } catch {
      setError("That file is not a picture this browser can open.")
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ""
    }
  }

  const proof = (
    <>
      {p.hasPassword && (
        <>
          <label htmlFor="profile-password">Your password</label>
          <input id="profile-password" type="password" autoComplete="current-password" required {...field("password")} />
        </>
      )}
      {p.twoStep && (
        <>
          <label htmlFor="profile-code">A code from your authenticator app, a backup code{p.telegramCodes ? ", or one sent to Telegram" : ""}</label>
          <input id="profile-code" autoComplete="one-time-code" required {...field("code")} />
          {p.telegramCodes && (
            <button
              className="link"
              type="button"
              onClick={async () => {
                const reply = await fetch("/api/account/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "telegram-send" }) })
                setError(reply.ok ? "Sent. Check Telegram." : "The bot could not send it. Open @NoctoriumLoginBot and press Start.")
              }}
            >
              Send me a code on Telegram
            </button>
          )}
        </>
      )}
    </>
  )
  const buttons = (label: string, danger = false) => (
    <>
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy} className={danger ? "danger" : undefined}>{label}</button>
      <button type="button" className="ghost" style={{ marginTop: 8, width: "100%" }} onClick={() => open("none")}>Cancel</button>
    </>
  )
  const submit = (body: () => object, then?: () => void) => (e: { preventDefault(): void }) => {
    e.preventDefault()
    run(body(), then)
  }

  return (
    <>
      <div className="profile">
        <Avatar url={p.avatarUrl} name={p.name} size={72} />
        <div className="profile-actions">
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <button className="link" type="button" disabled={busy} onClick={() => file.current?.click()}>Upload a picture</button>
          {p.discordLinked && <button className="link" type="button" disabled={busy} onClick={() => run({ action: "avatar-discord" })}>Use my Discord picture</button>}
          {p.telegramLinked && <button className="link" type="button" disabled={busy} onClick={() => run({ action: "avatar-telegram" })}>Use my Telegram picture</button>}
          {p.avatarUrl && <button className="link" type="button" disabled={busy} onClick={() => run({ action: "avatar-remove" })}>Remove</button>}
        </div>
      </div>
      {editing === "none" && error && <div className="error">{error}</div>}

      <table className="ways">
        <tbody>
          <tr>
            <td>Name</td>
            <td className="muted">{p.name}</td>
            <td className="num"><button className="link" type="button" onClick={() => open("name")}>Change</button></td>
          </tr>
          <tr>
            <td>Email</td>
            <td className="muted">{p.email || "None"}</td>
            <td className="num">{p.email || p.hasPassword ? <button className="link" type="button" onClick={() => open("email")}>Change</button> : "Add one with a password below"}</td>
          </tr>
          {p.hasPassword && (
            <tr>
              <td>Password</td>
              <td className="muted">Set</td>
              <td className="num"><button className="link" type="button" onClick={() => open("password")}>Change</button></td>
            </tr>
          )}
        </tbody>
      </table>

      {editing === "name" && (
        <form className="card" style={{ marginTop: 14 }} onSubmit={submit(() => ({ action: "name", name: fields.name }))}>
          <label htmlFor="profile-name">Name</label>
          <input id="profile-name" maxLength={40} required autoFocus {...field("name")} />
          {buttons("Save")}
        </form>
      )}
      {editing === "email" && (
        <form className="card" style={{ marginTop: 14 }} onSubmit={submit(() => ({ action: "email", email: fields.email, password: fields.password, code: fields.code }))}>
          <p className="muted">Every other device signed in to this account is signed out.</p>
          <label htmlFor="profile-email">New email</label>
          <input id="profile-email" type="email" autoComplete="email" required autoFocus {...field("email")} />
          {proof}
          {buttons("Change email")}
        </form>
      )}
      {editing === "password" && (
        <form className="card" style={{ marginTop: 14 }} onSubmit={submit(() => ({ action: "password", current: fields.password, password: fields.next, code: fields.code }))}>
          <p className="muted">Every other device signed in to this account is signed out.</p>
          {proof}
          <label htmlFor="profile-new-password">New password</label>
          <input id="profile-new-password" type="password" autoComplete="new-password" minLength={10} required {...field("next")} />
          {buttons("Change password")}
        </form>
      )}

      <p style={{ marginTop: 18 }}>
        {editing !== "delete" && <button className="link danger-link" type="button" onClick={() => open("delete")}>Delete my account</button>}
      </p>
      {editing === "delete" && (
        <form
          className="card"
          onSubmit={submit(() => ({ action: "delete", confirm: fields.confirm, password: fields.password, code: fields.code }), () => {
            window.location.href = "/login"
          })}
        >
          <p>
            This deletes your account and everything in it for good: your listening history and statistics, the ways you sign in,
            Last.fm and ListenBrainz links, and your picture. It cannot be undone.
          </p>
          <label htmlFor="profile-confirm">Type <b>delete my account</b></label>
          <input id="profile-confirm" autoComplete="off" required {...field("confirm")} />
          {proof}
          {buttons("Delete my account for good", true)}
        </form>
      )}
    </>
  )
}
