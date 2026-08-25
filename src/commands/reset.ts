import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import * as sessionManager from '../services/sessionManager.js';
import type { Command } from './index.js';

export const reset: Command = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset the AI memory for this channel or thread') as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    // Acknowledge immediately so the interaction cannot expire while cleanup runs.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const conversationId = interaction.channelId;
    const currentSession = sessionManager.getSessionForThread(conversationId);

    // Stop the current OpenCode session cleanly before removing its persisted mapping.
    if (currentSession) {
      const sseClient = sessionManager.getSseClient(conversationId);
      if (sseClient) {
        sseClient.disconnect();
        sessionManager.clearSseClient(conversationId);
      }
      await sessionManager.abortSession(currentSession.port, currentSession.sessionId).catch(() => false);
    }

    sessionManager.clearSessionForThread(conversationId);
    dataStore.clearQueue(conversationId);
    dataStore.updateQueueSettings(conversationId, { freshContext: true });

    await interaction.editReply('✅ memory reset');
  },
};
