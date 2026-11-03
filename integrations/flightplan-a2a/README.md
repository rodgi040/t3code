# Flightplan A2A provider

Lets a T3 thread talk to an ADA agent (default: `flightplan`, shown as "Gandalf") over A2A.

```
T3 (acpRegistry, source=local) --ACP v1, stdio--> a2a-acp-agent.mjs --> a2a_send.py --A2A--> peer
```

- `a2a-acp-agent.mjs`: ACP agent. One process per T3 thread. Each model entry is one A2A peer.
  The transport is a seam: `python` (default) or `fake` (`FP_A2A_TRANSPORT=fake`, answers locally).
- `a2a_send.py`: one A2A turn through the host's A2A client library (`~/.local/lib/a2a-client/a2a_core.py`).
  Peers, bearer token and local guards (turns per context, sends per hour, brake file) come from the
  0600 file `~/.config/a2a-client/peers-<identity>.toml`. Tokens never reach argv, logs or output.
- Registration: set `T3CODE_FP_A2A_AGENT=<path to a2a-acp-agent.mjs>` for the T3 server. On start it
  upserts the provider instance `flightplanA2a` ("Gandalf (A2A)", driver `acpRegistry`, local command).
  User edits (name, enabled) survive restarts.

| Variable              | Default                    | Meaning                                       |
| --------------------- | -------------------------- | --------------------------------------------- |
| `T3CODE_FP_A2A_AGENT` | unset (feature off)        | path to `a2a-acp-agent.mjs`                   |
| `FP_A2A_IDENTITY`     | `claude-vps`               | peers file identity (`peers-<identity>.toml`) |
| `FP_A2A_CLIENT_LIB`   | `~/.local/lib/a2a-client`  | directory with `a2a_core.py`                  |
| `FP_A2A_AGENTS`       | `flightplan`               | comma list of peers offered as models         |
| `FP_A2A_LABELS`       | `{"flightplan":"Gandalf"}` | JSON, peer to display name                    |
| `FP_A2A_TRANSPORT`    | `python`                   | `fake` for tests                              |

Limits: replies arrive as one message (no streaming), up to about 5 minutes per turn, the A2A client
stops a context after 5 turns, and Hermes agents answer short questions only. Tests:
`node --test integrations/flightplan-a2a/`.

`prefix-proxy.mjs` is a test helper that mimics a reverse proxy under `/chat`.
