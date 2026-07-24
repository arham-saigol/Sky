# Architecture and invariants

Sky is a single Windows process with explicit internal boundaries:

- `discord/`: Gateway events, commands, components, modals, threads, REST rate limits, and native voice uploads.
- `providers/`: isolated OpenCode Go, Groq, and Cartesia request/response translation.
- `roleplay.ts`: owner authorization, per-thread serialization, clean prompt construction, model fallback, and response recovery.
- `curation.ts`: durable scheduling, strict MiniMax response validation, watermarks, retry backoff, and post-success archiving.
- `characters.ts`: human-editable files, external-edit reconciliation, revision history, per-character locking, recovery journals, and atomic replacement.
- `db.ts` and `migrations/`: operational persistence and idempotency.
- `secrets.ts`: DPAPI protection and restricted Windows ACLs.
- `windows/`: WinSW service installation and lifecycle.
- `cli.ts`, `setup.ts`, and `doctor.ts`: owner-facing operation and diagnostics.

## Trust boundaries

Discord users are rejected by user ID and guild ID before an event is persisted, an attachment is inspected/downloaded, or a paid provider can be called. Roleplay and curator models receive no tools. Provider adapters parse only visible text blocks and discard unknown reasoning/thinking fields.

The roleplay prompt contains only the fictional-adult invariant, the selected character’s current files, clean owner/assistant messages, and an optional current-response TTS note. Raw Discord events, IDs, provider payloads, database values, logs, system prompts from prior operations, and hidden reasoning never enter it.

The curator receives only current `SOUL.md`, current `MEMORY.md`, the clean uncurated owner/assistant segment, a job ID, and a segment digest. Its full-file JSON result is strictly parsed, size-bounded, checked for control data, required to preserve the stable identity heading and fictional-adult invariant, then journaled and atomically applied.

## Crash recovery

Discord event IDs and outbound response state make replay safe. Discord `nonce` plus `enforce_nonce` makes a retry after an uncertain REST result safe. Incomplete generated responses remain in SQLite and are delivered without another model call after restart.

Session activity timestamps and curation deadlines live in SQLite rather than timers alone. At startup, interrupted event and curation leases become retryable. A successful curation advances the watermark transactionally; identical content cannot create another segment job.

Character curation creates a recovery journal containing both complete next files before replacing either file. Startup finishes a valid journal idempotently and records any missing revisions. This prevents a process or computer crash from leaving an unrecoverable half-update.
