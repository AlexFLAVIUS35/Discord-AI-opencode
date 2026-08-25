import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, ThreadChannel } from 'discord.js';
import type { Command } from './index.js';
import * as storage from '../services/storageService.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';
import * as dataStore from '../services/dataStore.js';

function parentId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  return channel?.isThread() ? ((channel as ThreadChannel).parentId ?? interaction.channelId) : interaction.channelId;
}

export const storageCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('storage')
    .setDescription('Control OpenCode storage access for this conversation')
    .addSubcommand(subcommand => subcommand.setName('activate').setDescription('Allow OpenCode to access the configured workspace'))
    .addSubcommand(subcommand => subcommand.setName('deactivate').setDescription('Disable OpenCode file access'))
    .addSubcommand(subcommand => subcommand.setName('status').setDescription('Show current storage access status')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const conversationId = interaction.channelId;
    const model = dataStore.getChannelModel(parentId(interaction));
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'activate') {
      try {
        serveManager.stopServe(storage.getChatWorkspace(conversationId), model, false);
        const path = storage.activate(conversationId);
        sessionManager.clearSessionForThread(conversationId);
        await interaction.reply({
          content: `🔓 **Storage access enabled.**\nOpenCode workspace: \`${path}\`\n\nThe previous chat session was stopped and a fresh storage-enabled session will be used.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        await interaction.reply({ content: `❌ ${error instanceof Error ? error.message : 'Failed to enable storage.'}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (subcommand === 'deactivate') {
      const currentPath = storage.getPath(conversationId);
      if (currentPath) serveManager.stopServe(currentPath, model, true);
      storage.deactivate(conversationId);
      sessionManager.clearSessionForThread(conversationId);
      await interaction.reply({
        content: '🔒 **Storage access disabled.**\nThe storage-enabled OpenCode process was stopped and the conversation was reset to chat-only mode.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = storage.getStatus(conversationId);
    if (status.enabled) {
      await interaction.reply({ content: `🔓 **Storage: ENABLED**\nWorkspace: \`${status.path}\``, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: '🔒 **Storage: DISABLED**\nOpenCode is running in chat-only mode and file/tools access is blocked.', flags: MessageFlags.Ephemeral });
    }
  },
};
