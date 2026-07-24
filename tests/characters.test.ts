import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterFiles } from "../src/characters.js";
import { SkyDatabase } from "../src/db.js";

const roots: string[] = [];
const dbs: SkyDatabase[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sky-char-"));
  roots.push(root);
  const db = new SkyDatabase(path.join(root, "sky.sqlite"));
  dbs.push(db);
  const files = new CharacterFiles(db, path.join(root, "characters"));
  await files.initialize();
  const character = await files.create({
    name: "Mara",
    identity: "Mara is a 29-year-old fictional archivist.",
    personality: "Thoughtful, witty, and direct.",
    appearance: "An adult woman with dark curls and green eyes.",
    settingAndBoundaries: "A fictional modern city; all participants consent.",
    memorySeed: "Mara values honest conversation.",
    voice: "Katie"
  });
  return { root, db, files, character };
}

describe("character Markdown durability", () => {
  it("records externally edited files as revisions", async () => {
    const { db, files, character } = await fixture();
    const edited = `${await readFile(character.memory_path, "utf8")}\n- The owner likes rain.\n`;
    await writeFile(character.memory_path, edited);
    await files.reconcile(character);
    expect(db.latestRevision(character.id, "MEMORY")).toMatchObject({
      revision: 2,
      source: "external",
      content: edited
    });
    db.close();
  });

  it("rolls back character creation when an initial revision fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sky-char-"));
    roots.push(root);
    const db = new SkyDatabase(path.join(root, "sky.sqlite"));
    dbs.push(db);
    const files = new CharacterFiles(db, path.join(root, "characters"));
    await files.initialize();
    const original = db.recordRevision.bind(db);
    vi.spyOn(db, "recordRevision")
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => {
        throw new Error("revision write failed");
      });
    await expect(
      files.create({
        name: "Rollback",
        identity: "A 30-year-old fictional adult.",
        personality: "Careful.",
        appearance: "An adult.",
        settingAndBoundaries: "Fictional and consensual.",
        voice: "Katie"
      })
    ).rejects.toThrow("revision write failed");
    expect(db.listCharacters()).toEqual([]);
    expect(
      (
        db.raw.prepare("SELECT COUNT(*) AS count FROM file_revisions").get() as {
          count: number;
        }
      ).count
    ).toBe(0);
    db.close();
  });

  it("serializes concurrent curator writes for one character", async () => {
    const { db, files, character } = await fixture();
    const makeJob = (suffix: string) => {
      const session = db.createSession({
        characterId: character.id,
        threadId: `thread-${suffix}`,
        guildId: "guild",
        lobbyChannelId: "lobby"
      });
      db.appendMessage({
        sessionId: session.id,
        discordMessageId: `message-${suffix}`,
        role: "owner",
        content: suffix,
        source: "text"
      });
      return db.createCurationJob(session.id, "inactivity")!;
    };
    const first = makeJob("a");
    const second = makeJob("b");
    const baseSoul = (await files.read(character)).soul;
    await Promise.all([
      files.applyCuration(character, first, {
        soul: `${baseSoul}\n## Durable change\n\nFirst.\n`,
        memory: "# Persistent memory\n\nFirst durable memory.\n"
      }),
      files.applyCuration(character, second, {
        soul: `${baseSoul}\n## Durable change\n\nSecond.\n`,
        memory: "# Persistent memory\n\nSecond durable memory.\n"
      })
    ]);
    await Promise.all([
      files.finalizeCuration(character, first),
      files.finalizeCuration(character, second)
    ]);
    const final = await files.read(character);
    expect(["First durable memory.", "Second durable memory."]).toContain(
      final.memory.match(/(?:First|Second) durable memory\./)?.[0]
    );
    const count = db.raw
      .prepare(
        "SELECT COUNT(*) AS count FROM file_revisions WHERE character_id = ? AND file_kind = 'MEMORY'"
      )
      .get(character.id) as { count: number };
    expect(count.count).toBe(3);
    expect(
      (await readdir(path.dirname(character.soul_path))).some((name) =>
        name.includes("journal")
      )
    ).toBe(false);
    db.close();
  });

  it("recovers an applied curation journal without invoking the curator again", async () => {
    const { root, db, files, character } = await fixture();
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-recover-curation",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "message-recover-curation",
      role: "owner",
      content: "Remember the lighthouse.",
      source: "text"
    });
    db.beginEndSession(session.id);
    const job = db.createCurationJob(session.id, "end")!;
    const claimed = db.claimDueCurationJob("2030-01-01T00:00:00.000Z")!;
    expect(claimed.id).toBe(job.id);
    const soul = (await files.read(character)).soul;
    await files.applyCuration(character, claimed, {
      soul,
      memory: "# Persistent memory\n\n- The owner remembers the lighthouse.\n"
    });
    const databasePath = db.raw.name;
    db.close();

    const reopened = new SkyDatabase(databasePath);
    dbs.push(reopened);
    const recoveredFiles = new CharacterFiles(
      reopened,
      path.join(root, "characters")
    );
    await recoveredFiles.initialize();
    expect(reopened.getCurationJob(job.id)?.state).toBe("succeeded");
    expect(reopened.getSession(session.id)).toMatchObject({
      state: "ended",
      curation_watermark_id: job.to_message_id
    });
    expect(await readFile(character.memory_path, "utf8")).toContain(
      "lighthouse"
    );
    expect(
      (await readdir(path.dirname(character.soul_path))).some((name) =>
        name.includes("journal")
      )
    ).toBe(false);
    reopened.recoverInterruptedWork();
    expect(reopened.getCurationJob(job.id)?.state).toBe("succeeded");
    reopened.close();
  });

  it("rejects curator attempts to change stable identity", async () => {
    const { db, files, character } = await fixture();
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-x",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.appendMessage({
      sessionId: session.id,
      discordMessageId: "message-x",
      role: "owner",
      content: "x",
      source: "text"
    });
    const job = db.createCurationJob(session.id, "end")!;
    await expect(
      files.applyCuration(character, job, {
        soul:
          "# Someone Else\n\nThis character and all participants are fictional adults.\n",
        memory: "# Persistent memory\n\nNone.\n"
      })
    ).rejects.toThrow(/stable identity/i);
    db.close();
  });

  it("permanently removes ended character state and physical files", async () => {
    const { db, files, character } = await fixture();
    const session = db.createSession({
      characterId: character.id,
      threadId: "thread-delete",
      guildId: "guild",
      lobbyChannelId: "lobby"
    });
    db.markSessionEnded(session.id);
    await files.deleteFiles(character);
    expect(db.getCharacterById(character.id)).toBeUndefined();
    expect(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM file_revisions")
          .get() as { count: number }
      ).count
    ).toBe(0);
    await expect(access(character.soul_path)).rejects.toThrow();
    await expect(access(character.memory_path)).rejects.toThrow();
    db.close();
  });
});
