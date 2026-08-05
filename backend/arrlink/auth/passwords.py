"""UI-password hashing (M10: dual password + OIDC login)."""
from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerifyMismatchError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    """Hash a password for storage (self-describing $argon2id$... string)."""
    return _hasher.hash(password)


def verify_password(password: str, stored: str) -> bool:
    """Check a candidate password against a stored Argon2 hash.
    Fails closed (False) for anything else, including empty/malformed input."""
    if not stored:
        return False
    try:
        return _hasher.verify(stored, password)
    except (VerifyMismatchError, InvalidHash):
        return False
