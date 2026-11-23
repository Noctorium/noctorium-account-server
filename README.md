# Noctorium Account

The Noctorium account, at **https://account.noctorium.xyz**: signing up and signing in — with an email and password,
Discord or Telegram — the page every Noctorium app opens to sign in with a code, and the account page: ways to sign in,
two-step verification (an authenticator app, Telegram codes, or both), the Discord status and Telegram bio, and Last.fm
and ListenBrainz.

Listening statistics are [Noctorium-Service](https://github.com/Noctorium/Noctorium-Service), at
**https://stats.noctorium.xyz**. Both use the same Neon database and the same `AUTH_SECRET`, so a token from here is
good there, and the session cookie is set for `.noctorium.xyz`, so signing in on one site counts on the other.

Next.js on Vercel, Postgres on Neon.

## Running it

```bash
npm ci
npm test              # against an in-memory Postgres (PGlite)
npm run dev:local     # the site on localhost:3000, against a local database
```

`.env.example` names every variable. The schema in `db/schema.sql` is applied on every build.
