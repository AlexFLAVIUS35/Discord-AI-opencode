import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getOrCreateThread } from '../utils/threadHelper.js';
import type { Command } from './index.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';

export const opencode: Command = {
  data: new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('Start a new AI conversation in a new thread')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('The first message for the new conversation')
        .setRequired(true)) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const prompt = interaction.options.getString('prompt', true);

    if (interaction.channel?.isThread()) {
      await interaction.reply({
        content: '❌ Use `/prompt` from the parent channel. Normal messages in this thread already continue its conversation.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Discord identifies USER_INSTALL as integration type "1". A user-installed
    // app can be invoked without the bot being installed in the guild, so it
    // must never depend on guild thread creation.
    const owners = interaction.authorizingIntegrationOwners;
    const hasUserInstallation = Boolean(owners?.['1']);
    const botIsInstalledInGuild = Boolean(
      interaction.guildId && interaction.client.guilds.cache.has(interaction.guildId),
    );
    const isUserInstallOnly = hasUserInstallation && !botIsInstalledInGuild;

    if (isUserInstallOnly) {
      // User-app interactions should answer in the exact context where /prompt
      // was invoked. Do not fall back to a DM: user-installed commands used in
      // a server must remain visible in that server channel.
      const channel = interaction.channel
        ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);

      if (!channel) {
        await interaction.reply({
          content: '❌ Cannot access the server channel for this User App command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.deleteReply().catch(() => {});

      const conversationId = interaction.channelId;
      await runPrompt(channel as any, conversationId, prompt, conversationId, interaction.user.id);
      return;
    }

    await interaction.deferReply();

    let thread;
    try {
      thread = await getOrCreateThread(interaction, prompt);
    } catch (error) {
      console.error('Failed to create prompt thread:', error);
      await interaction.editReply('❌ Cannot create the conversation thread.');
      return;
    }

    const threadId = thread.id;

    if (isBusy(threadId)) {
      await interaction.editReply('📥 The new conversation is already busy.');
      return;
    }

    await interaction.editReply(`🧵 **New conversation created:** ${thread}`);
    await runPrompt(thread as any, threadId, prompt, interaction.channelId);
  },
};
