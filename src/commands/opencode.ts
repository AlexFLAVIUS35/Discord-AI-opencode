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

    // Discord identifies USER_INSTALL as integration type "1". User-installed
    // apps can be invoked in a server without being installed in that server.
    const owners = interaction.authorizingIntegrationOwners;
    const hasUserInstallation = Boolean(owners?.['1']);
    const botIsInstalledInGuild = Boolean(
      interaction.guildId && interaction.client.guilds.cache.has(interaction.guildId),
    );
    const isUserInstallOnly = hasUserInstallation && !botIsInstalledInGuild;

    if (isUserInstallOnly) {
      // For a User App, Discord's interaction channel may be unavailable to the
      // bot because the app is not installed in the guild. In that case the
      // interaction itself is the only server-visible response mechanism.
      // Do NOT try to fetch/read the server channel or create a thread.
      await interaction.reply({ content: '⏳', flags: MessageFlags.Ephemeral }).catch(() => {});
      await interaction.deleteReply().catch(() => {});

      const channel = interaction.channel;
      if (channel) {
        const conversationId = interaction.channelId;
        await runPrompt(channel as any, conversationId, prompt, conversationId, interaction.user.id);
        return;
      }

      // Discord may intentionally omit channel access for external/user apps.
      // Keep the command functional rather than attempting a forbidden guild API
      // lookup. runPrompt needs a channel to post follow-up messages, so surface
      // this as an ephemeral interaction response.
      await interaction.followUp({
        content: '❌ Discord did not provide this User App with access to the server channel.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
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
