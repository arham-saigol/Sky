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
import { afterEach, describe, expect, it } from "vitest";
import { CharacterFiles } from "../src/characters.js";
import { SkyDatabase } from "../src/db.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sky-char-"));
  roots.push(root);
  const db = new SkyDatabase(path.join(root, "sky.sqlite"));
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
