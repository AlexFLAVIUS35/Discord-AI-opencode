import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './index.js';
import * as dataStore from '../services/dataStore.js';
import * as personalitySplit from '../services/personalitySplitStore.js';

const MAX_PERSONALITY_LENGTH = 2000;

export const personality: Command = {
  data: new SlashCommandBuilder()
    .setName('personality')
    .setDescription('Manage your personal AI personality')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set or replace your personal personality')
      .addStringOption(option => option
        .setName('personality')
        .setDescription('How you want the AI to behave with you')
        .setRequired(false)
        .setMaxLength(MAX_PERSONALITY_LENGTH))
      .addBooleanOption(option => option
        .setName('split')
        .setDescription('Enter the personality in multiple parts')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View your current personality'))
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Remove your saved personality')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (subcommand === 'set') {
      const split = interaction.options.getBoolean('split') ?? false;

      if (split) {
        const scopeId = interaction.guildId ?? 'dm';
        personalitySplit.start(scopeId, userId);
        await interaction.reply({
          content: '🧠 **Personal personality setup**\n\nPress **Next Part** to enter a personality part. You can add as many parts as you need. Press **Done** when finished.\n\nParts: **0**',
          flags: MessageFlags.Ephemeral,
          components: [
            {
              type: 1,
              components: [
                { type: 2, custom_id: `personality_split_next:${scopeId}:${userId}`, label: 'Next Part', style: 2 },
                { type: 2, custom_id: `personality_split_done:${scopeId}:${userId}`, label: 'Done', style: 3 },
              ],
            },
          ],
        });
        return;
      }

      const value = interaction.options.getString('personality')?.trim();
      if (!value) {
        await interaction.reply({ content: '❌ Personality text is required unless `split` is enabled.', flags: MessageFlags.Ephemeral });
        return;
      }

      dataStore.setUserPersonality(userId, value);
      await interaction.reply({ content: '🧠 **Your personality was saved permanently.** It will follow your Discord account across your chats.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'view') {
      const value = dataStore.getUserPersonality(userId);
      await interaction.reply({ content: value ? `🧠 **Your personality:**\n${value}` : '🧠 You have no custom personality saved.', flags: MessageFlags.Ephemeral });
      return;
    }

    const removed = dataStore.removeUserPersonality(userId);
    await interaction.reply({ content: removed ? '🧠 **Your saved personality was reset.**' : '🧠 You did not have a saved personality.', flags: MessageFlags.Ephemeral });
  },
};
