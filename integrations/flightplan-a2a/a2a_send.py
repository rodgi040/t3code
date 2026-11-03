#!/usr/bin/python3 -I
"""Flightplan fork: one A2A turn for the T3 "A2A" provider, via the host's existing A2A client.

Reads one JSON object from stdin, writes one JSON object to stdout, never prints tokens.

  in : {"op": "list"}
       {"op": "send", "agent": "flightplan", "message": "...", "context_id": "ctx-...", "task_ref": ""}
  out: {"ok": true, "agents": [...]}                                  (list)
       {"ok": true, "state": "completed", "text": "...", "hint": "", "context_id": "...", "turn": 1}
       {"ok": false, "kind": "auth|rate_limit|brake|...", "error": "short message"}

The client library is the one the `a2a` MCP server uses (a2a_core.py): peers and bearer tokens come
from the 0600 peers file of the chosen identity, local guards (turn limit per context, sends per hour,
brake file) stay active. Environment:

  FP_A2A_CLIENT_LIB  directory with a2a_core.py   (default ~/.local/lib/a2a-client)
  FP_A2A_IDENTITY    peers-<identity>.toml        (default claude-vps)
"""
import json
import os
import sys
from pathlib import Path

LIB = Path(os.environ.get("FP_A2A_CLIENT_LIB") or Path.home() / ".local" / "lib" / "a2a-client")
IDENTITY = os.environ.get("FP_A2A_IDENTITY") or "claude-vps"


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return out({"ok": False, "kind": "bad_input", "error": "stdin is not JSON"})
    sys.path.insert(0, str(LIB))  # python -I drops the script directory and PYTHONPATH
    try:
        import a2a_core as core
    except ImportError:
        return out({"ok": False, "kind": "config", "error": "a2a_core.py not found (FP_A2A_CLIENT_LIB)"})
    try:
        peers, cfg = core.load_peers(identity=IDENTITY)
        if req.get("op") == "list":
            return out({"ok": True, "agents": [{k: a.get(k) for k in ("agent", "name", "ok", "problems")}
                                              for a in core.list_agents(peers)]})
        client = core.Client(peers, cfg, identity=IDENTITY)
        res = client.send(str(req.get("agent") or ""), str(req.get("message") or ""),
                          context_id=str(req.get("context_id") or ""),
                          task_ref=str(req.get("task_ref") or ""), wait=True)
        return out({"ok": True, **{k: res.get(k) for k in ("state", "text", "hint", "context_id", "turn", "truncated")}})
    except core.A2AError as exc:
        return out({"ok": False, "kind": exc.kind, "error": str(exc)[:300]})
    except Exception as exc:  # never leak internals or tokens
        return out({"ok": False, "kind": "internal", "error": type(exc).__name__})


if __name__ == "__main__":
    main()
