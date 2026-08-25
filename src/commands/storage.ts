import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { Command } from './index.js';
import * as storage from '../services/storageService.js';
import * as sessionManager from '../services/sessionManager.js';

export const storageCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('storage')
    .setDescription('Control OpenCode storage access for this thread')
    .addSubcommand(subcommand =>
      subcommand.setName('activate').setDescription('Allow OpenCode to access the configured workspace'))
    .addSubcommand(subcommand =>
      subcommand.setName('deactivate').setDescription('Disable OpenCode file access'))
    .addSubcommand(subcommand =>
      subcommand.setName('status').setDescription('Show current storage access status')) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const threadId = interaction.channelId;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'activate') {
      try {
        const path = storage.activate(threadId);
        sessionManager.clearSessionForThread(threadId);
        await interaction.reply({
          content: `🔓 **Storage access enabled.**\nOpenCode workspace: \`${path}\`\n\nThe current AI session was reset so the new permission mode takes effect.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : 'Failed to enable storage.'}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (subcommand === 'deactivate') {
      storage.deactivate(threadId);
      sessionManager.clearSessionForThread(threadId);
      await interaction.reply({
        content: '🔒 **Storage access disabled.**\nThe AI can no longer use file tools in this thread. The current session was reset.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = storage.getStatus(threadId);
    if (status.enabled) {
      await interaction.reply({
        content: `🔓 **Storage: ENABLED**\nWorkspace: \`${status.path}\``,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: '🔒 **Storage: DISABLED**\nOpenCode is running in chat-only mode and file tools are blocked.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
