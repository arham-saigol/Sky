import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { VoiceName } from "./constants.js";
import {
  type CharacterRow,
  type CurationJobRow,
  SkyDatabase
} from "./db.js";
import { SkyError } from "./errors.js";
import { atomicWriteText } from "./util/atomic-file.js";
import { KeyedMutex } from "./util/mutex.js";

export interface CharacterDefinition {
  name: string;
  identity: string;
  personality: string;
  appearance: string;
  settingAndBoundaries: string;
  memorySeed?: string;
  voice: VoiceName;
}

interface CurationJournal {
  version: 2;
  jobId: string;
  characterId: string;
  baseSoulSha256: string;
  baseMemorySha256: string;
  soul: string;
  memory: string;
}

export const MAX_CHARACTER_FILE_BYTES = 8 * 1024;
export const FICTIONAL_ADULT_INVARIANT =
  "This character and every roleplay participant are consenting fictional adults.";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function unlinkIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function rmdirIfPresent(directory: string): Promise<void> {
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || `character-${randomUUID().slice(0, 8)}`;
}

function soulTemplate(definition: CharacterDefinition): string {
  return `# ${definition.name}

## Identity

${definition.identity.trim()}

${FICTIONAL_ADULT_INVARIANT}

## Personality

${definition.personality.trim()}

## Appearance

${definition.appearance.trim()}

## Setting and boundaries

${definition.settingAndBoundaries.trim()}
`;
}

function memoryTemplate(seed?: string): string {
  const content = seed?.trim() || "No persistent memories yet.";
  return `# Persistent memory

${content}
`;
}

function firstHeading(markdown: string): string | undefined {
  return markdown
    .split(/\r?\n/)
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim();
}

export class CharacterFiles {
  private readonly mutex = new KeyedMutex();

  public constructor(
    private readonly db: SkyDatabase,
    private readonly charactersDir: string
  ) {}

  public async initialize(): Promise<void> {
    await mkdir(this.charactersDir, { recursive: true });
    await this.recoverJournals();
    for (const character of this.db.listCharacters()) {
      await this.reconcile(character);
    }
  }

  public async create(
    definition: CharacterDefinition
  ): Promise<CharacterRow> {
    const name = definition.name.trim();
    if (name.length < 1 || name.length > 80) {
      throw new SkyError(
        "Character names must be between 1 and 80 characters",
        "INVALID_CHARACTER"
      );
    }
    if (
      !definition.identity.trim() ||
      !definition.personality.trim() ||
      !definition.appearance.trim() ||
      !definition.settingAndBoundaries.trim()
    ) {
      throw new SkyError(
        "The complete character definition is required",
        "INVALID_CHARACTER"
      );
    }
    if (this.db.getCharacterByName(name)) {
      throw new SkyError(
        `A character named ${name} already exists`,
        "CHARACTER_EXISTS"
      );
    }
    let slug = slugify(name);
    const existing = new Set(this.db.listCharacters().map((row) => row.slug));
    if (existing.has(slug)) slug = `${slug}-${randomUUID().slice(0, 6)}`;
    const directory = path.join(this.charactersDir, slug);
    const soul = soulTemplate({ ...definition, name });
    const memory = memoryTemplate(definition.memorySeed);
    this.validateMarkdown("SOUL", soul, name);
    this.validateMarkdown("MEMORY", memory, name);
    const soulPath = path.join(directory, "SOUL.md");
    const memoryPath = path.join(directory, "MEMORY.md");
    let directoryCreated = false;
    try {
      await mkdir(directory, { recursive: false });
      directoryCreated = true;
      await atomicWriteText(soulPath, soul);
      await atomicWriteText(memoryPath, memory);
      const character = this.db.raw.transaction(() => {
        const created = this.db.createCharacter({
          name,
          slug,
          soulPath,
          memoryPath,
          voice: definition.voice
        });
        this.db.recordRevision({
          characterId: created.id,
          kind: "SOUL",
          sha256: sha256(soul),
          content: soul,
          source: "create"
        });
        this.db.recordRevision({
          characterId: created.id,
          kind: "MEMORY",
          sha256: sha256(memory),
          content: memory,
          source: "create"
        });
        return created;
      })();
      return character;
    } catch (error) {
      if (directoryCreated) {
        try {
          await Promise.all([
            unlinkIfPresent(soulPath),
            unlinkIfPresent(memoryPath)
          ]);
          await rmdirIfPresent(directory);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Character creation failed and cleanup was incomplete"
          );
        }
      }
      throw error;
    }
  }

  public async read(
    character: CharacterRow
  ): Promise<{ soul: string; memory: string }> {
    return await this.reconcileSnapshot(character);
  }

  public async reconcile(character: CharacterRow): Promise<void> {
    await this.reconcileSnapshot(character);
  }

  private async reconcileSnapshot(
    character: CharacterRow
  ): Promise<{ soul: string; memory: string }> {
    return await this.mutex.runExclusive(character.id, async () => {
      const directory = path.dirname(character.soul_path);
      await mkdir(directory, { recursive: true });
      const release = await lockfile.lock(directory, {
        realpath: false,
        retries: { retries: 5, minTimeout: 25, maxTimeout: 250 },
        stale: 30_000
      });
      try {
        let soul = "";
        let memory = "";
        const files: Array<{
          kind: "SOUL" | "MEMORY";
          file: string;
          fallback: string;
        }> = [
          {
            kind: "SOUL",
            file: character.soul_path,
            fallback: `# ${character.name}\n\nThis character and every roleplay participant are consenting fictional adults.\n`
          },
          {
            kind: "MEMORY",
            file: character.memory_path,
            fallback: memoryTemplate()
          }
        ];
        for (const item of files) {
          let content: string;
          try {
            content = await readFile(item.file, "utf8");
          } catch {
            const latest = this.db.latestRevision(character.id, item.kind);
            content = latest?.content ?? item.fallback;
            await atomicWriteText(item.file, content);
          }
          const latest = this.db.latestRevision(character.id, item.kind);
          const digest = sha256(content);
          if (!latest || latest.sha256 !== digest) {
            this.validateMarkdown(item.kind, content, character.name);
            this.db.recordRevision({
              characterId: character.id,
              kind: item.kind,
              sha256: digest,
              content,
              source: "external"
            });
          }
          if (item.kind === "SOUL") soul = content;
          else memory = content;
        }
        return { soul, memory };
      } finally {
        await release();
      }
    });
  }

  public async applyCuration(
    character: CharacterRow,
    job: CurationJobRow,
    next: { soul: string; memory: string },
    expected?: { soul: string; memory: string }
  ): Promise<void> {
    this.validateMarkdown("SOUL", next.soul, character.name);
    this.validateMarkdown("MEMORY", next.memory, character.name);
    await this.mutex.runExclusive(character.id, async () => {
      const directory = path.dirname(character.soul_path);
      const release = await lockfile.lock(directory, {
        realpath: false,
        retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
        stale: 60_000
      });
      const journalPath = path.join(directory, `.curation-${job.id}.journal.json`);
      try {
        await this.reconcileWithoutLock(character);
        const [currentSoul, currentMemory] = await Promise.all([
          readFile(character.soul_path, "utf8"),
          readFile(character.memory_path, "utf8")
        ]);
        if (expected) {
          if (
            sha256(currentSoul) !== sha256(expected.soul) ||
            sha256(currentMemory) !== sha256(expected.memory)
          ) {
            throw new SkyError(
              "Character files changed while curation was running; retrying with the latest edits",
              "STALE_CURATION",
              true
            );
          }
        }
        const journal: CurationJournal = {
          version: 2,
          jobId: job.id,
          characterId: character.id,
          baseSoulSha256: sha256(currentSoul),
          baseMemorySha256: sha256(currentMemory),
          soul: next.soul,
          memory: next.memory
        };
        await atomicWriteText(journalPath, JSON.stringify(journal));
        await atomicWriteText(character.soul_path, next.soul);
        await atomicWriteText(character.memory_path, next.memory);
        this.recordCurationRevisions(character, job, next);
      } catch (error) {
        try {
          if (
            await this.replayCurationJournalWithoutLock(
              character,
              job,
              journalPath
            )
          ) {
            return;
          }
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Curation failed and its journal could not be replayed"
          );
        }
        throw error;
      } finally {
        await release();
      }
    });
  }

  public async recoverCuration(
    character: CharacterRow,
    job: CurationJobRow
  ): Promise<boolean> {
    return await this.mutex.runExclusive(character.id, async () => {
      const directory = path.dirname(character.soul_path);
      const release = await lockfile.lock(directory, {
        realpath: false,
        retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
        stale: 60_000
      });
      try {
        return await this.replayCurationJournalWithoutLock(
          character,
          job,
          path.join(directory, `.curation-${job.id}.journal.json`)
        );
      } finally {
        await release();
      }
    });
  }

  public async finalizeCuration(
    character: CharacterRow,
    job: CurationJobRow
  ): Promise<void> {
    const journalPath = path.join(
      path.dirname(character.soul_path),
      `.curation-${job.id}.journal.json`
    );
    await unlink(journalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  public async deleteFiles(character: CharacterRow): Promise<void> {
    await this.mutex.runExclusive(character.id, async () => {
      if (this.db.sessionCountBlockingCharacterDeletion(character.id) > 0) {
        throw new Error(
          "Cannot delete a character until every session is ended and archived"
        );
      }
      const directory = path.dirname(character.soul_path);
      const attachmentPaths = this.db.attachmentPathsForCharacter(character.id);
      const journals = (await readdir(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        }
      ))
        .filter((name) => /^\.curation-.+\.journal\.json$/.test(name))
        .map((name) => path.join(directory, name));
      await Promise.all([
        unlinkIfPresent(character.soul_path),
        unlinkIfPresent(character.memory_path),
        ...attachmentPaths.map((file) => unlinkIfPresent(file)),
        ...journals.map((file) => unlinkIfPresent(file))
      ]);
      await rmdirIfPresent(directory);
      this.db.permanentlyDeleteCharacter(character.id);
    });
  }

  private validateMarkdown(
    kind: "SOUL" | "MEMORY",
    content: string,
    characterName: string
  ): void {
    if (
      !content.trim() ||
      Buffer.byteLength(content, "utf8") > MAX_CHARACTER_FILE_BYTES ||
      content.includes("\0") ||
      /<!--\s*SKY[-_:]/i.test(content)
    ) {
      throw new SkyError(
        `${kind}.md mutation was empty, oversized, or contained unsafe control data`,
        "UNSAFE_CURATION"
      );
    }
    if (kind === "SOUL") {
      if (firstHeading(content) !== characterName) {
        throw new SkyError(
          "The curator attempted to change the character's stable identity heading",
          "UNSAFE_CURATION"
        );
      }
      if (
        !content
          .split(/\r?\n/)
          .some((line) => line.trim() === FICTIONAL_ADULT_INVARIANT)
      ) {
        throw new SkyError(
          "SOUL.md must preserve the canonical fictional-adult invariant",
          "UNSAFE_CURATION"
        );
      }
    } else if (!/^#\s+/m.test(content)) {
      throw new SkyError(
        "MEMORY.md must remain structured Markdown",
        "UNSAFE_CURATION"
      );
    }
  }

  private recordCurationRevisions(
    character: CharacterRow,
    job: CurationJobRow,
    next: { soul: string; memory: string }
  ): void {
    this.db.raw.transaction(() => {
      for (const [kind, content] of [
        ["SOUL", next.soul],
        ["MEMORY", next.memory]
      ] as const) {
        if (
          this.db.latestRevision(character.id, kind)?.sha256 !==
          sha256(content)
        ) {
          this.db.recordRevision({
            characterId: character.id,
            kind,
            sha256: sha256(content),
            content,
            source: "curator",
            curationJobId: job.id
          });
        }
      }
    })();
  }

  private async replayCurationJournalWithoutLock(
    character: CharacterRow,
    job: CurationJobRow,
    journalPath: string
  ): Promise<boolean> {
    let encoded: string;
    try {
      encoded = await readFile(journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const journal = JSON.parse(encoded) as CurationJournal;
    if (
      journal.version !== 2 ||
      journal.jobId !== job.id ||
      journal.characterId !== character.id ||
      job.character_id !== character.id
    ) {
      throw new SkyError(
        "Curation journal does not match its database job",
        "CURATION_JOURNAL_MISMATCH"
      );
    }
    this.validateMarkdown("SOUL", journal.soul, character.name);
    this.validateMarkdown("MEMORY", journal.memory, character.name);
    const [currentSoul, currentMemory] = await Promise.all([
      readFile(character.soul_path, "utf8"),
      readFile(character.memory_path, "utf8")
    ]);
    if (
      ![journal.baseSoulSha256, sha256(journal.soul)].includes(
        sha256(currentSoul)
      ) ||
      ![journal.baseMemorySha256, sha256(journal.memory)].includes(
        sha256(currentMemory)
      )
    ) {
      throw new SkyError(
        "Character files conflict with an incomplete curation journal",
        "STALE_CURATION"
      );
    }
    await atomicWriteText(character.soul_path, journal.soul);
    await atomicWriteText(character.memory_path, journal.memory);
    this.recordCurationRevisions(character, job, {
      soul: journal.soul,
      memory: journal.memory
    });
    return true;
  }

  private async reconcileWithoutLock(character: CharacterRow): Promise<void> {
    for (const [kind, file] of [
      ["SOUL", character.soul_path],
      ["MEMORY", character.memory_path]
    ] as const) {
      const content = await readFile(file, "utf8");
      this.validateMarkdown(kind, content, character.name);
      const latest = this.db.latestRevision(character.id, kind);
      const digest = sha256(content);
      if (latest?.sha256 !== digest) {
        this.db.recordRevision({
          characterId: character.id,
          kind,
          sha256: digest,
          content,
          source: "external"
        });
      }
    }
  }

  private async recoverJournals(): Promise<void> {
    const directories = await readdir(this.charactersDir, {
      withFileTypes: true
    }).catch(() => []);
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const location = path.join(this.charactersDir, directory.name);
      const files = await readdir(location).catch(() => []);
      for (const file of files.filter((name) =>
        /^\.curation-.+\.journal\.json$/.test(name)
      )) {
        const journalPath = path.join(location, file);
        try {
          const journal = JSON.parse(
            await readFile(journalPath, "utf8")
          ) as CurationJournal;
          const character = this.db.getCharacterById(journal.characterId);
          const job = this.db.getCurationJob(journal.jobId);
          if (
            !character ||
            !job ||
            job.character_id !== character.id ||
            journal.version !== 2
          ) {
            continue;
          }
          this.validateMarkdown("SOUL", journal.soul, character.name);
          this.validateMarkdown("MEMORY", journal.memory, character.name);
          const [currentSoul, currentMemory] = await Promise.all([
            readFile(character.soul_path, "utf8"),
            readFile(character.memory_path, "utf8")
          ]);
          const soulDigest = sha256(currentSoul);
          const memoryDigest = sha256(currentMemory);
          if (
            ![journal.baseSoulSha256, sha256(journal.soul)].includes(
              soulDigest
            ) ||
            ![journal.baseMemorySha256, sha256(journal.memory)].includes(
              memoryDigest
            )
          ) {
            await this.reconcileWithoutLock(character);
            continue;
          }
          await atomicWriteText(character.soul_path, journal.soul);
          await atomicWriteText(character.memory_path, journal.memory);
          this.db.raw.transaction(() => {
            for (const [kind, content] of [
              ["SOUL", journal.soul],
              ["MEMORY", journal.memory]
            ] as const) {
              if (
                this.db.latestRevision(character.id, kind)?.sha256 !==
                sha256(content)
              ) {
                this.db.recordRevision({
                  characterId: character.id,
                  kind,
                  sha256: sha256(content),
                  content,
                  source: "curator",
                  curationJobId: journal.jobId
                });
              }
            }
          })();
          this.db.completeCurationJob(job);
          this.db.createCurationJob(job.session_id, job.trigger);
          await unlink(journalPath);
        } catch {
          // Keep malformed journals for doctor/manual recovery.
        }
      }
    }
  }
}
