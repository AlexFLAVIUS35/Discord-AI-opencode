import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './index.js';
import * as dataStore from '../services/dataStore.js';

const MAX_PERSONALITY_LENGTH = 2000;

export const personality: Command = {
  data: new SlashCommandBuilder()
    .setName('personality')
    .setDescription('Set your permanent AI personality')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set or replace your permanent personality')
      .addStringOption(option => option
        .setName('personality')
        .setDescription('How you want the AI to behave with you')
        .setRequired(true)
        .setMaxLength(MAX_PERSONALITY_LENGTH)))
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View your current personality'))
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Remove your saved personality')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const userId = interaction.user.id;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set') {
      const value = interaction.options.getString('personality', true).trim();
      dataStore.setUserPersonality(userId, value);
      await interaction.reply({
        content: '🧠 **Personality saved permanently.** It will be used automatically in your future chats.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'view') {
      const value = dataStore.getUserPersonality(userId);
      await interaction.reply({
        content: value ? `🧠 **Your personality:**\n${value}` : '🧠 You have no custom personality saved.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const removed = dataStore.removeUserPersonality(userId);
    await interaction.reply({
      content: removed ? '🧠 **Your saved personality was reset.**' : '🧠 You did not have a saved personality.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
