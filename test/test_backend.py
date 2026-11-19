"""Tests for app/backend/routes.py. Run with Kiro Crew's bundled Python (its aiohttp and kiro_crew):

  & "$env:LOCALAPPDATA\\Programs\\KiroCrew\\resources\\backend-dist\\kirocrew-backend\\python.exe" test\\test_backend.py
"""

import asyncio
import importlib.util
import json
import sys
import warnings
from pathlib import Path
from types import SimpleNamespace

# No __pycache__ inside app/: the app directory is copied as-is on install.
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("crew_lobby_routes", ROOT / "app" / "backend" / "routes.py")
routes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(routes)

SAME = lambda text: text  # noqa: E731 - identity redactor for shape tests
NO_NOTICE = lambda role, meta: False  # noqa: E731


def slot(rows, memory_mode="", ephemeral=False):
    return SimpleNamespace(messages=rows, memory_mode=memory_mode, _ephemeral=ephemeral, window_pending=False)


ROWS = [
    {"role": "user", "content": "oi", "ts": "t1"},
    {"role": "assistant", "content": "antiga", "ts": "t2"},
    {"role": "tool_result", "content": "saida", "ts": "t3"},
    {"role": "assistant", "content": [{"type": "text", "text": "nova"}, {"type": "text", "text": "linha 2"}], "ts": "t4"},
]


def test_latest_assistant_text():
    out = routes.read_last_message(slot(ROWS), redact=SAME, notice=NO_NOTICE)
    assert out["available"] and out["text"] == "nova\nlinha 2" and out["ts"] == "t4", out


def test_notice_rows_are_skipped():
    rows = ROWS + [{"role": "assistant", "content": "aviso", "meta": {"notice": True}}]
    out = routes.read_last_message(slot(rows), redact=SAME, notice=lambda role, meta: meta.get("notice") is True)
    assert out["text"] == "nova\nlinha 2", out


def test_private_sessions_are_refused():
    for private in (slot(ROWS, memory_mode="incognito"), slot(ROWS, ephemeral=True)):
        out = routes.read_last_message(private, redact=SAME, notice=NO_NOTICE)
        assert out == {"available": False, "reason": "private session"}, out


def test_real_redactor_masks_credentials():
    token = "ghp_" + "Ab3dE6gH" * 4 + "Ij9k"  # built at runtime: no literal token in this file
    out = routes.read_last_message(slot([{"role": "assistant", "content": f"use {token} agora"}]))
    assert out["available"], out
    assert token not in out["text"], out["text"]


def test_long_text_is_capped():
    big = slot([{"role": "assistant", "content": "x" * (routes.MAX_CHARS + 50)}])
    out = routes.read_last_message(big, redact=SAME, notice=NO_NOTICE)
    assert out["truncated"] and out["text"].endswith("…") and len(out["text"]) <= routes.MAX_CHARS + 1, out


def test_no_reply_and_failed_redaction():
    out = routes.read_last_message(slot([{"role": "user", "content": "oi"}]), redact=SAME, notice=NO_NOTICE)
    assert out == {"available": False, "reason": "no reply yet"}, out

    def boom(text):
        raise RuntimeError("redactor down")

    out = routes.read_last_message(slot(ROWS), redact=boom, notice=NO_NOTICE)
    assert out == {"available": False, "reason": "redaction failed"}, out


async def _call(query, slots, user=True):
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request

    app = web.Application()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        app["state"] = SimpleNamespace(_slots=slots, _slots_under_construction=set())
    request = make_mocked_request("GET", f"/api/apps/crew-lobby/last-message{query}", app=app)
    if user:
        request["user"] = "owner"
    response = await routes.handle_last_message(request, None)
    return response.status, json.loads(response.text)


def test_handler():
    slots = {"chat-1": slot(ROWS)}
    assert asyncio.run(_call("?session=chat-1", slots, user=False))[0] == 401
    assert asyncio.run(_call("?session=a/b", slots))[0] == 400
    assert asyncio.run(_call("", slots))[0] == 400
    status, body = asyncio.run(_call("?session=nope", slots))
    assert status == 200 and body["available"] is False, body
    status, body = asyncio.run(_call("?session=chat-1", slots))
    assert status == 200 and body["available"] and "nova" in body["text"], body


def test_register_routes():
    [route] = routes.register_routes(None)
    assert (route.method, route.path) == ("GET", "/last-message"), route


if __name__ == "__main__":
    tests = [fn for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok  ", fn.__name__)
        except Exception as exc:  # noqa: BLE001 - report every failure
            failed += 1
            print("FAIL", fn.__name__, repr(exc)[:300])
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
