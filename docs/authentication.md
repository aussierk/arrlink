# Authentication

Password and OIDC login are independent -- enable either or both, via `.env`
(seed defaults) and/or Settings → Authentication (runtime overrides, which
take effect immediately, no restart).

## Password login

Set `AUTH_PASSWORD_ENABLED=true` and `UI_PASSWORD=...` (or toggle it on and
set a password in Settings → Authentication). `UI_USERNAME` defaults to
`admin` if left unset. The password is hashed at rest (Argon2id); the
session cookie holds an opaque token, not the password itself.

### Lockout

5 failed attempts within 15 minutes locks the account for 15 minutes
(persisted -- survives a restart). If you're locked out and still have a
valid OIDC session, `POST /api/auth/password/unlock` clears it immediately.
With password-only auth and no other session, either wait it out or run:

```sh
sqlite3 /config/arrlink.db "DELETE FROM login_attempts;"
```

## OIDC login

1. In your provider (e.g. authentik) create an **application** +
   **provider** (OpenID Connect). Use the **client** tab to get the
   **client id** and **client secret** (confidential client).
2. Redirect URI: `http(s)://<host>:8270/auth/oidc/callback`. The
   host/port/scheme come from `APP_URL` if set, else `TRUSTED_HOSTS`, else
   the request.
3. Set `AUTH_OIDC_ENABLED=true`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET` in the compose file.
4. (Optional) restrict access: Settings → Authentication → allowed groups
   and/or emails, in the OIDC section (empty = any authenticated user).
5. `OIDC_AUTO_LOGIN` (default `true`): `/login` redirects straight to the
   provider when OIDC is enabled. Visit `/login?form=true` to bypass that
   and reach the manual chooser (SSO button and/or the password form) --
   this isn't linked anywhere in the UI; it's a URL you navigate to
   directly when you want to skip auto-login for one visit.

> The **id_token is decoded but not signature-verified** -- claims are read
> from the userinfo endpoint over TLS; the id_token is used for `nonce`/`exp`
> only. This keeps the client dependency-free and works with any standard
> provider.

## Sessions

Local sessions last `SESSION_TTL_H` hours (default 12). A background sweeper
silently refreshes OIDC sessions nearing expiry via the stored provider
refresh token (provider token rotation supported); a rejected refresh drops
the session, and the SPA re-triggers the instant provider round-trip.