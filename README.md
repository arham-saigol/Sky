# Sky

Sky is a self-hosted, single-owner Discord roleplay AI for Windows. It runs as a Windows service, receives events over the Discord Gateway (no public web server), stores operational state in SQLite, and keeps each character in ordinary editable `SOUL.md` and `MEMORY.md` files.

Sky is restricted to a private server containing the owner and bot. Setup requires explicit consent to adult fictional roleplay. Every character and participant must be a consenting fictional adult.

## Requirements

- 64-bit Windows 10 or Windows 11
- Node.js 22 or newer
- A private Discord guild with a text or forum lobby
- Discord **Message Content Intent** enabled
- Bot permissions: View Channels, Send Messages, Send Messages in Threads, Create Private Threads (for text lobbies), Manage Threads, Read Message History, Attach Files, and Use Application Commands
- OpenCode Go, Groq, and Cartesia API keys
- FFmpeg with `libopus` (setup can install the Gyan.FFmpeg winget package)
- An Administrator PowerShell for Windows service registration

Mark the lobby age-restricted in Discord before adult roleplay. Invite only the configured owner and the bot.

## Install and start

Open PowerShell as Administrator in this repository:

```powershell
npm ci
npm run verify
npm run build
npm link
sky setup
sky doctor
sky start
sky status
```

`sky setup` is interactive and safe to rerun. It validates all three OpenCode model IDs, Groq’s `whisper-large-v3-turbo`, Cartesia keys, the Discord guild/owner/lobby, Gateway login, and command registration. Secrets are encrypted with Windows DPAPI (LocalMachine scope) and the encrypted file ACL is restricted to the configuring user, SYSTEM, and Administrators. They are never put in JSON, SQLite, logs, fixtures, or command output.

Setup downloads the latest official x64 WinSW service wrapper and verifies its SHA-256 digest. The service runs under Windows’ service manager and can start automatically or manually.

## Discord operation

In the configured lobby:

- `/character create name:` opens the full character-definition modal.
- `/character list`
- `/character delete name:` requires a separate destructive confirmation and refuses deletion while the character has an active session.
- `/start character:` creates and permanently binds a thread. Sky chooses the thread name.
- `/restart` reconnects only the Discord Gateway.

Inside a Sky thread:

- Talk normally without mentioning the bot.
- `/end` immediately closes roleplay input, queues all remaining curation, and archives/locks the thread only after curation succeeds.
- `/model` selects exactly DeepSeek V4 Pro, MiniMax M3, or Hy3.
- `/reasoning` shows or selects only modes advertised by current OpenCode model metadata. If none are advertised, only `default` is exposed.
- `/speak mode:` accepts exactly `off`, `on`, or `mirror`.
- `/voice voice:` accepts exactly `Katie`, `Skylar`, or `Gemma`; character voice changes affect all active threads immediately.

`off` sends text. `on` sends native Discord voice messages. `mirror` speaks only in response to an owner voice message. If TTS or FFmpeg fails, Sky preserves the generated response and sends a marked text fallback.

## CLI

```text
sky setup                 configure or reconfigure and refresh guild commands
sky start                 start the service and wait for Gateway readiness
sky stop                  gracefully drain and stop the service
sky restart               gracefully restart the complete Windows service
sky status                service, Gateway, SQLite, curation, provider and FFmpeg state
sky logs                  show the latest 100 redacted log lines
sky logs --follow         follow redacted logs
sky logs --lines 250      choose the initial line count
sky doctor                run local, Discord, provider, model, audio and service checks
sky doctor --offline      run checks that require no provider credentials or network
```

## Data and recovery

The default home is `%ProgramData%\Sky`; `SKY_HOME` overrides it for testing or a deliberate alternate install. The configured data directory contains:

```text
sky.sqlite
sky.sqlite-wal
characters\<slug>\SOUL.md
characters\<slug>\MEMORY.md
voice\incoming\
logs\sky.log
```

SQLite uses WAL, full synchronization, foreign keys, migrations, and transactional idempotency records. Inbound Discord IDs, outbound nonces, bindings, settings, deadlines, watermarks, revisions, and jobs survive reconnects and restarts. Character updates use a per-character lock, an on-disk recovery journal, atomic file replacement, and SQLite revision history.

Inactivity curation is based on a persisted deadline 30 minutes after the most recent owner or assistant roleplay message. The deadline is recovered after a computer restart. Each uncurated segment is queued once. Failed curation remains queued with bounded exponential backoff and always retries MiniMax M3—never Hy3.

### Backup

For the simplest consistent backup:

```powershell
sky stop
Copy-Item -Recurse -LiteralPath "$env:ProgramData\Sky" -Destination "E:\Backups\Sky"
sky start
```

The DPAPI secret file can be restored on the same Windows machine. On a different machine, restore the data and character files, then rerun `sky setup` to protect fresh credentials with that machine’s DPAPI.

### Update

```powershell
sky stop
git pull --ff-only
npm ci
npm run verify
npm run build
npm link
sky setup
sky start
sky doctor
```

Rerunning setup refreshes the WinSW definition and Discord guild commands while preserving data.

## Troubleshooting

- **Gateway does not connect:** enable Message Content Intent, verify the bot token, and run `sky doctor`.
- **Commands are missing:** rerun `sky setup`; guild commands update immediately.
- **Voice input fails:** Discord must deliver one voice-message audio attachment; check Groq readiness and the stored attachment status with logs.
- **Voice output falls back to text:** install FFmpeg with `winget install --id Gyan.FFmpeg --exact`, open a new terminal, and run `sky doctor`.
- **Service command says access denied:** use an Administrator PowerShell.
- **Curation remains pending:** this is intentional after provider or validation failures. `sky status` reports the count and `sky logs` reports the safe error; the service retries automatically.
- **Externally edited files:** valid edits are detected and revisioned before the next prompt or curation. Missing files are restored from the latest SQLite revision.
- **Deleted Discord thread:** state and character files remain intact; the archive retry reports the deleted thread without corrupting curation.

## Provider and Discord contracts

Sky uses focused HTTPS adapters rather than the OpenCode agent/runtime. DeepSeek V4 Pro and Hy3 use OpenCode’s OpenAI-compatible endpoint; MiniMax M3 uses its Anthropic Messages endpoint. DeepSeek retriable failures may fall back to Hy3 for roleplay only. Groq receives only verified-owner voice audio and returns a transcript. Cartesia Sonic 3.5 uses API version `2026-03-01`, current `generation_config.emotion`, raw 48 kHz PCM, and primary/backup key policy.

The Vercel Chat SDK Discord adapter was evaluated, but its official slash-command/modal path uses inbound HTTP interactions and its abstraction does not expose native Discord voice-message metadata. Sky therefore uses Discord Gateway and REST directly, with those details isolated in `src/discord`.

Official references:

- [OpenCode Go](https://opencode.ai/docs/go/)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Discord voice messages](https://docs.discord.com/developers/resources/message#voice-messages)
- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- [Cartesia TTS bytes](https://docs.cartesia.ai/api-reference/tts/bytes)
- [Cartesia emotion controls](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion)
- [WinSW](https://github.com/winsw/winsw)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component and recovery boundaries.
