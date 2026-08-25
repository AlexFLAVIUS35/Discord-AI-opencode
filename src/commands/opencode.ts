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

    // Discord exposes authorizingIntegrationOwners as a map keyed by installation
    // type, not userId/guildId properties. A user-install interaction has a user
    // installation owner and no guild installation owner.
    const owners = interaction.authorizingIntegrationOwners;
    const ownerKeys = Object.keys(owners ?? {});
    const isUserInstallOnly = ownerKeys.includes('1') && !ownerKeys.includes('0');

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
