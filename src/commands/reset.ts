import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import * as sessionManager from '../services/sessionManager.js';
import * as memory from '../services/memoryService.js';
import { getAuthHeaders, assertNotAuthError } from '../services/serverAuth.js';
import type { Command } from './index.js';

export const reset: Command = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Forget all AI conversation history for you') as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const conversationId = interaction.channelId;
    const userId = interaction.user.id;
    const currentSession = sessionManager.getSessionForThread(conversationId);

    if (currentSession) {
      const sseClient = sessionManager.getSseClient(conversationId);
      if (sseClient) {
        sseClient.disconnect();
        sessionManager.clearSseClient(conversationId);
      }

      // Abort the active generation first, then permanently delete the OpenCode
      // session so its old messages cannot be loaded or reused later.
      await sessionManager.abortSession(currentSession.port, currentSession.sessionId).catch(() => false);

      let response: Response | null = null;
      try {
        response = await fetch(
          `http://127.0.0.1:${currentSession.port}/session/${encodeURIComponent(currentSession.sessionId)}`,
          { method: 'DELETE', headers: getAuthHeaders() },
        );
        if (!response.ok) assertNotAuthError(response.status, 'Failed to delete session');
      } catch (error) {
        if (error instanceof Error && (error.message.includes('credentials') || error.message.includes('requires authentication'))) {
          await interaction.editReply(`❌ ${error.message}`);
          return;
        }
        response = null;
      }

      if (!response?.ok) {
        await interaction.editReply('❌ Could not delete the old AI conversation. Your memory was not reset.');
        return;
      }
    }

    // Reset means a complete user-level memory wipe, not merely clearing the
    // current Discord thread. This removes persisted memories from every
    // conversation/thread belonging to this Discord user.
    sessionManager.clearSessionForThread(conversationId);
    memory.clearUserMemory(userId);
    dataStore.clearQueue(conversationId);
    dataStore.updateQueueSettings(conversationId, { freshContext: false });

    await interaction.editReply('✅ memory reset — all of your saved conversation history was forgotten.');
  },
};
