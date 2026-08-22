"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import Request

from .state import State


def get_db(request: Request) -> State:
    return request.app.state.db
