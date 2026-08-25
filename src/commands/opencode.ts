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

    // Discord identifies USER_INSTALL as integration type "1". In a server,
    // authorizingIntegrationOwners can contain both "0" and "1" when the user
    // has the app installed both to their account and to that guild. In that
    // case, the reliable distinction is whether this bot is actually installed
    // in the guild: external/user-installed apps are not guild members.
    const owners = interaction.authorizingIntegrationOwners;
    const hasUserInstallation = Boolean(owners?.['1']);
    const botIsInstalledInGuild = Boolean(
      interaction.guildId && interaction.client.guilds.cache.has(interaction.guildId),
    );
    const isUserInstallOnly = hasUserInstallation && !botIsInstalledInGuild;

    if (isUserInstallOnly) {
      const channel = interaction.channel;
      if (!channel) {
        await interaction.reply({ content: '❌ Cannot access the current conversation.', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply();
      await interaction.deleteReply().catch(() => {});
      await runPrompt(channel as any, interaction.channelId, prompt, interaction.channelId, interaction.user.id);
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
