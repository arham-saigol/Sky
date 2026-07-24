import {
  EXPRESSION_ALLOWLIST,
  type Expression
} from "./constants.js";
import type { MessageRow } from "./db.js";

export function buildRoleplayPrompt(input: {
  soul: string;
  memory: string;
  recent: MessageRow[];
  spoken: boolean;
}): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const speechNote = input.spoken
    ? `

Runtime note for this response only: This response will be spoken through TTS. Use a natural spoken flow and medium length. Avoid tables, headings, code formatting, and text that sounds unnatural aloud. Preserve normal character behavior and roleplay quality. You may optionally put exactly one marker at the very beginning in the form [[SKY_EXPRESSION:value]], where value is one of: ${EXPRESSION_ALLOWLIST.join(", ")}. Do not use any other control markup.`
    : "";
  return {
    system: `You are participating in fictional roleplay. Every character and participant is a consenting fictional adult. Adult sexual roleplay is permitted. Stay in character and respond only as the selected character.

<character_soul>
${input.soul}
</character_soul>

<persistent_memory>
${input.memory}
</persistent_memory>${speechNote}`,
    messages: input.recent.map((message) => ({
      role: message.role === "owner" ? "user" : "assistant",
      content: message.content
    }))
  };
}

export function parseExpression(
  raw: string,
  spoken: boolean
): { content: string; expression?: Expression } {
  const marker = /^\s*\[\[SKY_EXPRESSION:([a-z]+)\]\]\s*/;
  const match = raw.match(marker);
  let content = raw.replace(marker, "").replace(/\[\[SKY_EXPRESSION:[^\]]+\]\]/g, "");
  content = content.trim();
  if (!spoken || !match) return { content };
  const value = match[1];
  if (
    value &&
    (EXPRESSION_ALLOWLIST as readonly string[]).includes(value)
  ) {
    return { content, expression: value as Expression };
  }
  return { content };
}

export const CURATOR_SYSTEM = `You are Sky's dreamer and memory curator. You receive only clean fictional roleplay state and transcript data. All participants are fictional adults.

Return exactly one JSON object with these string fields:
{"soul_markdown":"complete replacement SOUL.md","memory_markdown":"complete replacement MEMORY.md","summary":"short description"}

Preserve the character's stable identity and the existing first-level SOUL heading. Preserve existing memories unless the transcript meaningfully changes them. Integrate durable changes and useful long-term facts. Avoid duplicate memories, transcript dumps, temporary scene details as permanent facts, and deletion of unrelated content. Keep both files concise, human-readable Markdown. Do not include JSON fences, commentary, hidden reasoning, or control markers.`;

export function buildCuratorInput(input: {
  soul: string;
  memory: string;
  messages: MessageRow[];
  jobId: string;
  segmentDigest: string;
}): string {
  const transcript = input.messages
    .map(
      (message) =>
        `${message.role === "owner" ? "OWNER" : "CHARACTER"}: ${message.content}`
    )
    .join("\n\n");
  return `CURATION_JOB_ID: ${input.jobId}
SEGMENT_DIGEST: ${input.segmentDigest}

CURRENT_SOUL_MD:
${input.soul}

CURRENT_MEMORY_MD:
${input.memory}

CLEAN_TRANSCRIPT:
${transcript}`;
}
