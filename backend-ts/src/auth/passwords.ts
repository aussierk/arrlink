import * as argon2 from 'argon2'

// Matches argon2-cffi's PasswordHasher() defaults (Argon2id, 64 MiB memory,
// 3 iterations, 4 lanes) -- node-argon2 defaults to argon2i, so `type` must
// be set explicitly or password hashes silently use a weaker/different
// variant than the Python backend did.
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

/** Hash a password for storage (self-describing $argon2id$... string). */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS)
}

/**
 * Check a candidate password against a stored Argon2 hash. Fails closed
 * (false) for anything else, including empty/malformed input.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false
  try {
    return await argon2.verify(stored, password)
  } catch {
    return false
  }
}
