# Security

**Don't expose ArrLink directly to the internet.** It has no built-in TLS
termination and is designed to sit on a LAN or behind a reverse proxy — put
one (with TLS) in front of it for anything reachable outside your LAN, the
same as you would for Radarr/Sonarr themselves.

## Reverse-proxy / exposure settings

- **`FORWARDED_ALLOW_IPS`** — uvicorn only honors `X-Forwarded-For` /
  `-Proto` from this IP/CIDR (default: localhost only). Set it to your
  reverse proxy's address so ArrLink isn't trusting forwarded headers from
  arbitrary clients. A containerized proxy is *not* localhost to this
  container — use its Docker-network address.
- **`APP_URL`** — external base URL ArrLink is reached at: scheme + host +
  optional port + optional sub-path (e.g. `https://arrlink.example.com` or
  `https://apps.example.com/arrlink`). The OIDC redirect URI sent to your
  provider is `APP_URL` + `/auth/oidc/callback`. Set it whenever OIDC is
  enabled without a host-checking proxy in front, or when the outside-world
  scheme/port/path differs from what ArrLink sees. A sub-path assumes the
  proxy strips it before ArrLink (there is no internal sub-path routing).
- **`TRUSTED_HOSTS`** — comma-separated `Host`-header allow-list (default:
  unrestricted). Recommended if OIDC is enabled without `APP_URL` set and
  there's no host-checking proxy — otherwise the redirect URI is derived
  from whatever `Host` header the request carries (spoofable; logs a
  warning). The first non-loopback entry is used as the redirect URI host
  (https) when `APP_URL` is unset. `127.0.0.1` / `localhost` stay implicitly
  trusted (the container's own healthcheck needs them).

## Rate limiting

Password login is rate-limited (see [authentication.md](authentication.md)).
Other endpoints are not, matching the LAN-first assumption. If you're
exposing ArrLink beyond your LAN, OIDC is the recommended login method.

## Threat model & reporting

ArrLink assumes a trusted operator and a LAN-only deployment by default.
Found a vulnerability? See [SECURITY.md](../SECURITY.md) — please report it
privately rather than in a public issue.