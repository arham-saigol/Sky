export const APP_NAME = "Sky";
export const CONFIG_VERSION = 1;
export const INACTIVITY_MS = 30 * 60 * 1000;
export const MAX_RECENT_MESSAGES = 60;
export const DISCORD_API_VERSION = "10";
export const DISCORD_API = `https://discord.com/api/v${DISCORD_API_VERSION}`;
export const OPENCODE_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_OPENAI_URL =
  "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_ANTHROPIC_URL =
  "https://opencode.ai/zen/go/v1/messages";
export const GROQ_TRANSCRIPTION_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
export const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes";
export const CARTESIA_API_VERSION = "2026-03-01";

export const MODEL_NAMES = {
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "minimax-m3": "MiniMax M3",
  hy3: "Hy3"
} as const;

export type ModelId = keyof typeof MODEL_NAMES;
export const MODEL_IDS = Object.keys(MODEL_NAMES) as ModelId[];

export const VOICES = {
  Katie: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
  Skylar: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
  Gemma: "62ae83ad-4f6a-430b-af41-a9bede9286ca"
} as const;

export type VoiceName = keyof typeof VOICES;
export const VOICE_NAMES = Object.keys(VOICES) as VoiceName[];
export const SPEAK_MODES = ["off", "on", "mirror"] as const;
export type SpeakMode = (typeof SPEAK_MODES)[number];

export const EXPRESSION_ALLOWLIST = [
  "neutral",
  "happy",
  "excited",
  "enthusiastic",
  "elated",
  "euphoric",
  "triumphant",
  "amazed",
  "surprised",
  "flirtatious",
  "curious",
  "content",
  "peaceful",
  "serene",
  "calm",
  "grateful",
  "affectionate",
  "trust",
  "sympathetic",
  "anticipation",
  "mysterious",
  "angry",
  "mad",
  "outraged",
  "frustrated",
  "agitated",
  "threatened",
  "disgusted",
  "contempt",
  "envious",
  "sarcastic",
  "ironic",
  "sad",
  "dejected",
  "melancholic",
  "disappointed",
  "hurt",
  "guilty",
  "bored",
  "tired",
  "rejected",
  "nostalgic",
  "wistful",
  "apologetic",
  "hesitant",
  "insecure",
  "confused",
  "resigned",
  "anxious",
  "panicked",
  "alarmed",
  "scared",
  "proud",
  "confident",
  "distant",
  "skeptical",
  "contemplative",
  "determined"
] as const;

export type Expression = (typeof EXPRESSION_ALLOWLIST)[number];
