/**
 * Encrypted on-disk persistence for Forgejo OAuth2 tokens, used by the
 * bundled forgejo-mcp server (via the bridge script) to act on behalf of
 * the authenticated user.
 *
 * Threat model: anyone with read access to the token directory can decrypt
 * tokens IF they also have the encryption key. We derive the key from
 * JWT_SECRET (HKDF-like via SHA-256) so a single secret rotation invalidates
 * both sessions and stored tokens. Files are written 0600.
 */
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export interface StoredToken {
  username: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  updatedAt: number
}

interface OnDiskRecord {
  v: 1
  username: string
  iv: string
  ciphertext: string
  updatedAt: number
}

interface Plaintext {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
}

/**
 * Derive a 32-byte AES-256-GCM key from a passphrase via SHA-256. We use a
 * fixed application label as a domain separator so the same JWT_SECRET
 * produces a different key here than in JWT signing.
 */
async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const material = enc.encode(`forgejo-opencode/token-store/v1\n${passphrase}`)
  const digest = await crypto.subtle.digest("SHA-256", material)
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Buffer.from(u8).toString("base64")
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(s, "base64")
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength))
  out.set(buf)
  return out
}

function safeUsername(username: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) {
    throw new Error(`Refusing to use unsafe username for filename: ${username}`)
  }
  return username
}

export class TokenStore {
  constructor(
    private readonly dir: string,
    private readonly passphrase: string,
  ) {}

  async save(token: StoredToken): Promise<void> {
    const username = safeUsername(token.username)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700).catch(() => undefined)

    const key = await deriveKey(this.passphrase)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext: Plaintext = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
    }
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(plaintext)),
    )

    const record: OnDiskRecord = {
      v: 1,
      username,
      iv: b64(iv),
      ciphertext: b64(ct),
      updatedAt: token.updatedAt,
    }

    const path = join(this.dir, `${username}.json`)
    await writeFile(path, JSON.stringify(record), { mode: 0o600 })
    await chmod(path, 0o600).catch(() => undefined)

    // "Latest" pointer for the single-user MCP bridge: the most recently
    // authenticated user wins. Writing a tiny file (not a symlink) keeps
    // this portable across volume drivers that disallow symlinks.
    const pointerPath = join(this.dir, "latest.txt")
    await writeFile(pointerPath, username, { mode: 0o600 })
    await chmod(pointerPath, 0o600).catch(() => undefined)
  }

  async load(username: string): Promise<StoredToken | null> {
    const safe = safeUsername(username)
    const path = join(this.dir, `${safe}.json`)
    if (!existsSync(path)) return null

    const raw = await readFile(path, "utf8")
    const record = JSON.parse(raw) as OnDiskRecord
    if (record.v !== 1) {
      throw new Error(`Unsupported token store version: ${record.v}`)
    }

    const key = await deriveKey(this.passphrase)
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(record.iv) },
      key,
      unb64(record.ciphertext),
    )
    const plain = JSON.parse(new TextDecoder().decode(pt)) as Plaintext

    return {
      username: record.username,
      accessToken: plain.accessToken,
      refreshToken: plain.refreshToken,
      expiresAt: plain.expiresAt,
      scope: plain.scope,
      updatedAt: record.updatedAt,
    }
  }

  async loadLatest(): Promise<StoredToken | null> {
    const pointerPath = join(this.dir, "latest.txt")
    if (!existsSync(pointerPath)) return null
    const username = (await readFile(pointerPath, "utf8")).trim()
    if (!username) return null
    return this.load(username)
  }
}
