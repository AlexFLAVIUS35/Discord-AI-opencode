# Discord AI / Orange mode

This fork keeps the Discord + OpenCode + voice architecture of remote-opencode, but makes the default experience chat-first.

## Storage safety

Storage is **disabled by default**.

When disabled, the bot starts OpenCode with runtime permissions that deny all tools. In particular, file reading, file editing, file search, shell, web, subagents, skills, and MCP tools are blocked.

Use:

```text
/storage status
/storage activate
/storage deactivate
```

`/storage activate` uses the directory in `OPENCODE_STORAGE_PATH` as the OpenCode workspace. The session is reset whenever storage is activated or deactivated so the new permission mode is applied to a fresh OpenCode server/session.

Example on Linux/NixOS:

```bash
export OPENCODE_STORAGE_PATH="$HOME/AI/workspace"
```

Then restart the Discord bot.

## Chat behavior

In a server, the bot responds to mentions by default. Set:

```bash
export DISCORD_MENTION_ONLY=false
```

to make it respond to normal messages too (for authorized users).

DMs always work.

## Voice

The existing remote-opencode voice-message transcription path is preserved. Voice messages are converted to text and sent through the same chat/session pipeline.

## Commands exposed by this fork

- `/opencode <prompt>` — explicit prompt
- `/model ...` — model selection
- `/voice ...` — voice transcription status/settings
- `/storage activate|deactivate|status` — storage permission switch
- `/session ...` — session management
- `/allow ...` — access control

The old project/worktree/queue/diff command surface is no longer registered as Discord slash commands.
