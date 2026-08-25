import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './index.js';
import * as activationService from '../services/activationService.js';
import * as sessionManager from '../services/sessionManager.js';

function id(interaction: ChatInputCommandInteraction): string {
  return interaction.channelId;
}

export const activation: Command = {
  data: new SlashCommandBuilder()
    .setName('activate')
    .setDescription('Activate the AI in this channel or thread') as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const channelId = id(interaction);
    activationService.activate(channelId);
    sessionManager.clearSessionForThread(channelId);

    const location = interaction.channel?.isThread() ? 'this thread' : 'this channel';

    await interaction.reply({
      content: `🟢 **AI activated in ${location}.**\nJust send messages normally — no /prompt command or bot mention required.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const deactivate: Command = {
  data: new SlashCommandBuilder()
    .setName('deactivate')
    .setDescription('Deactivate the AI in this channel or thread') as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const channelId = id(interaction);
    activationService.deactivate(channelId);
    sessionManager.clearSessionForThread(channelId);

    const location = interaction.channel?.isThread() ? 'this thread' : 'this channel';

    await interaction.reply({
      content: `🔴 **AI deactivated in ${location}.**\nThe bot will ignore normal messages here until you run /activate again.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
