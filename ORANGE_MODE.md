# Discord AI / Orange mode

This fork keeps the Discord + OpenCode + voice architecture of remote-opencode, but makes the default experience chat-first.

## Multiple Discord bots

The bot process can run as many Discord bot accounts as you put in the environment. Add tokens using the numbered `BOT_<number>TOKEN` pattern:

```bash
BOT_1TOKEN=token_for_first_bot
BOT_2TOKEN=token_for_second_bot
BOT_3TOKEN=token_for_third_bot
# ...any number of BOT_<number>TOKEN variables
```

The numbers do not need to be consecutive. For example, `BOT_1TOKEN`, `BOT_7TOKEN`, and `BOT_42TOKEN` all work.

Each configured token starts its own discord.js `Client`, receives the same handlers/commands, and gets the global slash commands deployed to its own Discord application. discord.js supports logging a client in with an explicit token, and each client represents its own logged-in bot account. citeturn1search1

`DISCORD_TOKEN` is still accepted as a backwards-compatible single-bot fallback if no `BOT_<number>TOKEN` variables are present.

Keep bot tokens private and store them in Railway/environment variables rather than committing them to Git.

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
