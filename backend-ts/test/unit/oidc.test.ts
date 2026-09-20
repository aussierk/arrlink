import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OidcClient,
  OidcError,
  b64UrlDecode,
  b64UrlEncode,
  clearDiscoveryCache,
  decodeJwtPayload,
} from '../../src/auth/oidc.js'

const DISCOVERY = {
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  clearDiscoveryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('b64UrlEncode / b64UrlDecode', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const decoded = b64UrlDecode(b64UrlEncode(original))
    expect(Uint8Array.from(decoded)).toEqual(original)
  })

  it('never emits padding or unsafe URL characters', () => {
    const encoded = b64UrlEncode(new Uint8Array(40).fill(255))
    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe('decodeJwtPayload', () => {
  it('decodes a well-formed JWT payload without checking the signature', () => {
    const payload = { sub: 'user-1', nonce: 'abc', exp: 9999999999 }
    const header = b64UrlEncode(Buffer.from(JSON.stringify({ alg: 'none' })))
    const body = b64UrlEncode(Buffer.from(JSON.stringify(payload)))
    const jwt = `${header}.${body}.signature-not-checked`
    expect(decodeJwtPayload(jwt)).toEqual(payload)
  })

  it('throws OidcError for a token with fewer than 2 parts', () => {
    expect(() => decodeJwtPayload('onlyonepart')).toThrow(OidcError)
  })

  it('throws OidcError for an undecodable payload segment', () => {
    expect(() => decodeJwtPayload('header.not-valid-json-base64!!!.sig')).toThrow(
      OidcError,
    )
  })
})

describe('OidcClient.discovery', () => {
  it('fetches and caches the discovery document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(DISCOVERY))
    vi.stubGlobal('fetch', fetchMock)

    const client = new OidcClient('https://idp.example.com/', 'client-1', 'secret')
    const first = await client.discovery()
    const second = await client.discovery()

    expect(first).toEqual(DISCOVERY)
    expect(second).toEqual(DISCOVERY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://idp.example.com/.well-known/openid-configuration',
    )
  })

  it('strips a trailing slash from the issuer before building the discovery URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(DISCOVERY))
    vi.stubGlobal('fetch', fetchMock)
    await new OidcClient('https://idp.example.com/', 'c', 's').discovery()
    expect(fetchMock.mock.calls[0][0]).not.toContain('//.well-known')
  })

  it('throws OidcError when the discovery document is missing a required field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ authorization_endpoint: 'x' })),
    )
    await expect(
      new OidcClient('https://idp.example.com', 'c', 's').discovery(),
    ).rejects.toThrow(OidcError)
  })

  it('throws OidcError when the discovery endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(
      new OidcClient('https://idp.example.com', 'c', 's').discovery(),
    ).rejects.toThrow(OidcError)
  })
})

describe('OidcClient.exchangeCode / refreshTokens / userinfo', () => {
  function stubDiscoveryThen(...responses: Response[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY))
    for (const r of responses) fetchMock.mockResolvedValueOnce(r)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('POSTs form-encoded params with HTTP basic auth to the token endpoint', async () => {
    const fetchMock = stubDiscoveryThen(
      jsonResponse({ access_token: 'at', id_token: 'it' }),
    )
    const client = new OidcClient('https://idp.example.com', 'client-1', 'secret-1')

    const tok = await client.exchangeCode('code-1', 'verifier-1', 'https://app/callback')
    expect(tok).toEqual({ access_token: 'at', id_token: 'it' })

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(DISCOVERY.token_endpoint)
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
    )
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-1')
    expect(body.get('code_verifier')).toBe('verifier-1')
  })

  it('throws OidcError with the provider status and truncated body on a non-200 token response', async () => {
    stubDiscoveryThen(new Response('x'.repeat(400), { status: 400 }))
    const client = new OidcClient('https://idp.example.com', 'c', 's')
    const err = await client
      .exchangeCode('c', 'v', 'https://app/cb')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OidcError)
    expect((err as OidcError).status).toBe(400)
    expect((err as OidcError).detail.length).toBe(300)
  })

  it('refreshTokens sends a refresh_token grant', async () => {
    const fetchMock = stubDiscoveryThen(jsonResponse({ access_token: 'at2' }))
    const client = new OidcClient('https://idp.example.com', 'client-1', 's')
    await client.refreshTokens('rt-1')
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt-1')
  })

  it('userinfo sends a bearer token and returns the parsed claims', async () => {
    const fetchMock = stubDiscoveryThen(jsonResponse({ email: 'a@example.com' }))
    const client = new OidcClient('https://idp.example.com', 'c', 's')
    const info = await client.userinfo('at-1')
    expect(info).toEqual({ email: 'a@example.com' })
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(DISCOVERY.userinfo_endpoint)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at-1')
  })
})
