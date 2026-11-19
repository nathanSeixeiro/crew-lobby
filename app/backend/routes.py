"""Crew Lobby backend: the full last message of one session, for the Peek panel.

Registered through ``backend.hooks.routes`` in app.json. Paths are relative to
``/api/apps/crew-lobby`` and every handler takes ``(request, ctx)``.

GET /last-message?session=<slot key>
    The latest agent reply of that live session, redacted with the dashboard's
    own display redactor and capped. GET /api/chat/slots ships only an
    80-character preview, so Peek reads the rest here.

Read-only and in-memory: no transcript file is opened. Refusals answer HTTP 200
with ``{"available": false, "reason": ...}`` (the Crew Manager peek convention):
a private (incognito/temporary) session is never read, and nothing is returned
when the redactor cannot be loaded.
"""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import web

logger = logging.getLogger(__name__)

#: Cap after redaction: a full reply fits, one giant tool dump does not.
MAX_CHARS = 6000
#: Raw text handed to the redactor is cut here first (at a line break), so the
#: work done on the gateway's event loop stays bounded.
MAX_RAW_CHARS = 20000
#: Slot keys are short identifiers; anything longer or path-bearing is refused.
MAX_KEY_CHARS = 300


def unavailable(reason: str) -> dict:
    """The one refusal shape. Never carries session content."""
    return {"available": False, "reason": reason}


def text_of(content: object) -> str:
    """A row's text, whether stored as a string or a list of typed blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        text = content.get("text")
        return text if isinstance(text, str) else ""
    if isinstance(content, list):
        return "\n".join(part for part in (text_of(block) for block in content) if part)
    return ""


def is_private(slot: Any) -> bool:
    """Whether *slot* is incognito or temporary. Fails CLOSED: unknown means private."""
    if getattr(slot, "_ephemeral", False) is True:
        return True
    try:
        from kiro_crew.history import is_incognito_transcript

        return bool(is_incognito_transcript(getattr(slot, "memory_mode", "")))
    except Exception:  # noqa: BLE001 - a missing classifier must not widen the read
        logger.debug("crew-lobby: cannot classify a session", exc_info=True)
        return True


def rows_of(slot: Any) -> list:
    """The rows the slot list itself summarises (live window or restored tail)."""
    try:
        from kiro_crew.dashboard.slot_projection import summary_rows

        rows = summary_rows(slot)
    except Exception:  # noqa: BLE001 - older gateway: read the live window
        rows = getattr(slot, "messages", None)
    return list(rows) if isinstance(rows, (list, tuple)) else []


def _notice_check() -> Any:
    """The dashboard's system-notice predicate, or a role-only fallback."""
    try:
        from kiro_crew.dashboard.system_notices import is_system_notice

        return is_system_notice
    except Exception:  # noqa: BLE001
        return lambda role, meta: False


def _load_redactor() -> Any:
    """The dashboard's display redactor, or None (then nothing is returned)."""
    try:
        from kiro_crew.dashboard.chat_utils_display import _redact_for_display

        return _redact_for_display
    except Exception:  # noqa: BLE001
        logger.debug("crew-lobby: display redactor unavailable", exc_info=True)
        return None


def bounded(raw: str) -> str:
    """*raw* cut to MAX_RAW_CHARS, at the last line break when there is one."""
    if len(raw) <= MAX_RAW_CHARS:
        return raw
    head = raw[:MAX_RAW_CHARS]
    cut = head.rfind("\n")
    return head[:cut] if cut > MAX_RAW_CHARS // 2 else head


def read_last_message(slot: Any, redact: Any = None, notice: Any = None) -> dict:
    """The newest assistant row of *slot*, redacted and capped, or a refusal.

    Runs on the event loop: it walks rows already in memory and redacts at most
    MAX_RAW_CHARS of text.
    """
    if is_private(slot):
        return unavailable("private session")
    redact = redact if redact is not None else _load_redactor()
    if redact is None:
        return unavailable("redaction unavailable")
    notice = notice if notice is not None else _notice_check()
    for row in reversed(rows_of(slot)):
        if not isinstance(row, dict) or row.get("role") != "assistant":
            continue
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        try:
            if notice("assistant", meta):
                continue
        except Exception:  # noqa: BLE001 - an unreadable notice flag is not a reply
            continue
        raw = text_of(row.get("content")).strip()
        if not raw:
            continue
        try:
            text = redact(bounded(raw))
        except Exception:  # noqa: BLE001 - never fall back to unredacted text
            return unavailable("redaction failed")
        text = text if isinstance(text, str) else ""
        cut = len(raw) > MAX_RAW_CHARS or len(text) > MAX_CHARS
        return {
            "available": True,
            "text": text[:MAX_CHARS].rstrip() + ("…" if cut else ""),
            "truncated": cut,
            "chars": len(text),
            "ts": str(row.get("ts") or ""),
        }
    return unavailable("no reply yet")


def _bad_key(key: object) -> bool:
    return (
        not isinstance(key, str)
        or not key
        or len(key) > MAX_KEY_CHARS
        or any(ch in key for ch in "/\\\x00")
    )


async def handle_last_message(request: web.Request, ctx: Any) -> web.Response:
    """GET /last-message?session=<slot key> -- the full latest reply of one session."""
    if request.get("user") is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    key = request.query.get("session", "")
    if _bad_key(key):
        return web.json_response({"error": "invalid session"}, status=400)
    state = request.app.get("state")
    slots = getattr(state, "_slots", None)
    building = getattr(state, "_slots_under_construction", None) or ()
    slot = slots.get(key) if hasattr(slots, "get") and key not in building else None
    if slot is None:
        return web.json_response(unavailable("no session by that key"))
    try:
        payload = read_last_message(slot)
    except Exception:  # noqa: BLE001 - enrichment only: degrade, never 500
        logger.debug("crew-lobby: last-message read failed", exc_info=True)
        payload = unavailable("read failed")
    return web.json_response(payload)


def register_routes(ctx: Any) -> list:
    """Declare Crew Lobby's backend routes (relative to /api/apps/crew-lobby)."""
    from kiro_crew.apps.route_registry import AppRoute

    return [AppRoute(method="GET", path="/last-message", handler=handle_last_message)]
