import { Collection, SlashCommandBuilder, AutocompleteInteraction, InteractionContextType } from 'discord.js';
import { opencode } from './opencode.js';
import { model } from './model.js';
import { allow } from './allow.js';
import { voice } from './voice.js';
import { session } from './session.js';
import { storageCommand } from './storage.js';
import { activation, deactivate } from './activation.js';
import { personality } from './personality.js';
import { interrupt } from './interrupt.js';

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: any) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export const commands = new Collection<string, Command>();

// Commands available to user-installed applications as well as guild installs.
// activate/deactivate remain guild-only because user-installed apps always behave
// as an active conversation and do not need channel activation state.
const userAppContexts = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
] as const;

opencode.data.setContexts(...userAppContexts);
model.data.setContexts(...userAppContexts);
allow.data.setContexts(...userAppContexts);
voice.data.setContexts(...userAppContexts);
session.data.setContexts(...userAppContexts);
storageCommand.data.setContexts(...userAppContexts);
personality.data.setContexts(...userAppContexts);
interrupt.data.setContexts(...userAppContexts);

// Keep activation controls restricted to guild-installed use.
activation.data.setContexts(InteractionContextType.Guild);
deactivate.data.setContexts(InteractionContextType.Guild);

commands.set(activation.data.name, activation);
commands.set(deactivate.data.name, deactivate);
commands.set(opencode.data.name, opencode);
commands.set(model.data.name, model);
commands.set(allow.data.name, allow);
commands.set(voice.data.name, voice);
commands.set(session.data.name, session);
commands.set(storageCommand.data.name, storageCommand);
commands.set(personality.data.name, personality);
commands.set(interrupt.data.name, interrupt);
