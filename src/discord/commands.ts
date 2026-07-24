import {
  ApplicationCommandOptionType,
  type RESTPostAPIApplicationCommandsJSONBody
} from "discord-api-types/v10";
import {
  MODEL_NAMES,
  SPEAK_MODES,
  VOICE_NAMES
} from "../constants.js";

export const GUILD_COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  {
    name: "character",
    description: "Manage roleplay characters",
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "create",
        description: "Create a fictional adult character",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "name",
            description: "Character name",
            required: true,
            min_length: 1,
            max_length: 80
          }
        ]
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "list",
        description: "List characters"
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "delete",
        description: "Permanently delete a character after confirmation",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "name",
            description: "Exact character name",
            required: true,
            autocomplete: true
          }
        ]
      }
    ]
  },
  {
    name: "start",
    description: "Start a new character thread",
    nsfw: true,
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "character",
        description: "Character",
        required: true,
        autocomplete: true
      }
    ]
  },
  {
    name: "restart",
    description: "Restart only Sky's Discord Gateway connection"
  },
  {
    name: "end",
    description: "End this session and curate its memories",
    nsfw: true
  },
  {
    name: "reasoning",
    description: "View or change verified reasoning behavior for this thread",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "mode",
        description: "Verified mode; omit to show the current setting",
        autocomplete: true
      }
    ]
  },
  {
    name: "speak",
    description: "Set speech output behavior for this thread",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "mode",
        description: "Speech mode",
        required: true,
        choices: SPEAK_MODES.map((mode) => ({ name: mode, value: mode }))
      }
    ]
  },
  {
    name: "voice",
    description: "Set this character's Cartesia voice",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "voice",
        description: "Voice",
        required: true,
        choices: VOICE_NAMES.map((voice) => ({ name: voice, value: voice }))
      }
    ]
  },
  {
    name: "model",
    description: "Set the roleplay model for this thread",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "model",
        description: "Roleplay model",
        required: true,
        choices: Object.entries(MODEL_NAMES).map(([value, name]) => ({
          name,
          value
        }))
      }
    ]
  }
];
