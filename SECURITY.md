# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately, via GitHub's
[private vulnerability reporting](https://github.com/aussierk/arrlink/security/advisories/new)
for this repository, rather than opening a public issue.

Include what you found, how to reproduce it, and its impact if you can.
We'll acknowledge reports as quickly as we can and follow up once a fix is
available.

## Scope

ArrLink is a self-hosted, single-admin homelab tool -- its threat model
assumes a trusted operator and, by default, a LAN-only deployment. See the
README's Security section for deployment guidance (reverse proxy + TLS for
anything internet-reachable, `TRUSTED_HOSTS`/`FORWARDED_ALLOW_IPS`).

In scope: authentication/session handling, path traversal or arbitrary file
access in the hardlink engine, SQL injection, SSRF, and anything that lets
one authenticated session act outside its intended bounds.

Generally out of scope: issues that require an attacker to already have
write access to the container's filesystem or the config database directly
(at that point they already have full control), and denial-of-service
against a single self-hosted instance.

## Supported versions

Only the latest released version is supported with security fixes.
