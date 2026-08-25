import { Collection, SlashCommandBuilder, AutocompleteInteraction, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import { opencode } from './opencode.js';
import { model } from './model.js';
import { allow } from './allow.js';
import { voice } from './voice.js';
import { session } from './session.js';
import { storageCommand } from './storage.js';
import { activation, deactivate } from './activation.js';
import { personality } from './personality.js';
import { interrupt } from './interrupt.js';
import { reset } from './reset.js';

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: any) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export const commands = new Collection<string, Command>();

// Commands available to both guild-installed and user-installed apps.
const userAppContexts = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
] as const;
const bothInstallations = [
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
] as const;

opencode.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
model.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
allow.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
voice.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
session.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
storageCommand.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
personality.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
interrupt.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);
reset.data.setContexts(...userAppContexts).setIntegrationTypes(...bothInstallations);

// Activation controls are available in guild installs and User Install DMs.
// User Install guild use is ignored by the interaction handler.
activation.data.setContexts(
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
).setIntegrationTypes(
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
);
deactivate.data.setContexts(
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
).setIntegrationTypes(
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
);

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
commands.set(reset.data.name, reset);
