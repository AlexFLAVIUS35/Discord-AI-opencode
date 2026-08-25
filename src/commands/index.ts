import { Collection, SlashCommandBuilder, AutocompleteInteraction } from 'discord.js';
import { opencode } from './opencode.js';
import { model } from './model.js';
import { allow } from './allow.js';
import { voice } from './voice.js';
import { session } from './session.js';
import { storageCommand } from './storage.js';

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: any) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export const commands = new Collection<string, Command>();

// Orange-style interface: keep only the useful chat controls.
commands.set(opencode.data.name, opencode);
commands.set(model.data.name, model);
commands.set(allow.data.name, allow);
commands.set(voice.data.name, voice);
commands.set(session.data.name, session);
commands.set(storageCommand.data.name, storageCommand);
