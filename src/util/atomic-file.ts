import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteText(
  target: string,
  content: string
): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`
  );
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  const dir = await open(path.dirname(target), "r").catch(() => undefined);
  if (dir) {
    await dir.sync().catch(() => undefined);
    await dir.close();
  }
}
