const DISCOVERY_TTL_S = 3600
const HTTP_TIMEOUT_MS = 15_000

/** Raised for provider/transport failures; carries a user-facing detail. */
export class OidcError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail)
  }
}

export function b64UrlEncode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url')
}

export function b64UrlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

interface JwtPayload {
  nonce?: string
  exp?: number
  [key: string]: unknown
}

/** Decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length < 2) throw new OidcError(502, 'malformed id_token')
  try {
    return JSON.parse(b64UrlDecode(parts[1]).toString('utf-8')) as JwtPayload
  } catch {
    throw new OidcError(502, 'undecodable id_token')
  }
}

interface DiscoveryDocument {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  [key: string]: unknown
}

const discoveryCache = new Map<string, { at: number; doc: DiscoveryDocument }>()

/** Test helper. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear()
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, HTTP_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export class OidcClient {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string

  constructor(issuer: string, clientId: string, clientSecret: string) {
    this.issuer = issuer.replace(/\/+$/, '')
    this.clientId = clientId
    this.clientSecret = clientSecret
  }

  async discovery(): Promise<DiscoveryDocument> {
    const now = Date.now() / 1000
    const hit = discoveryCache.get(this.issuer)
    if (hit && now - hit.at < DISCOVERY_TTL_S) return hit.doc

    const url = `${this.issuer}/.well-known/openid-configuration`
    let data: DiscoveryDocument
    try {
      const r = await fetchWithTimeout(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      data = (await r.json()) as DiscoveryDocument
    } catch (e) {
      throw new OidcError(502, `OIDC discovery failed: ${String(e)}`)
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
      if (!(key in data)) throw new OidcError(502, `discovery document missing ${key}`)
    }
    discoveryCache.set(this.issuer, { at: now, doc: data })
    return data
  }

  async tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
    const d = await this.discovery()
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      'base64',
    )
    let r: Response
    try {
      r = await fetchWithTimeout(d.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams(form),
      })
    } catch (e) {
      throw new OidcError(502, `token endpoint unreachable: ${String(e)}`)
    }
    if (r.status !== 200) {
      throw new OidcError(r.status, (await r.text()).slice(0, 300))
    }
    try {
      return (await r.json()) as Record<string, unknown>
    } catch {
      throw new OidcError(502, 'token endpoint returned non-JSON')
    }
  }

  exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<Record<string, unknown>> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      code_verifier: codeVerifier,
    })
  }

  refreshTokens(refreshToken: string): Promise<Record<string, unknown>> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    })
  }

  async userinfo(accessToken: string): Promise<Record<string, unknown>> {
    const d = await this.discovery()
    let r: Response
    try {
      r = await fetchWithTimeout(d.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    } catch (e) {
      throw new OidcError(502, `userinfo endpoint unreachable: ${String(e)}`)
    }
    if (r.status !== 200) {
      throw new OidcError(r.status, (await r.text()).slice(0, 300))
    }
    try {
      return (await r.json()) as Record<string, unknown>
    } catch {
      throw new OidcError(502, 'userinfo returned non-JSON')
    }
  }
}
