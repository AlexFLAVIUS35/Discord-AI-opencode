import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import * as sessionManager from '../services/sessionManager.js';
import * as memory from '../services/memoryService.js';
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
      await sessionManager.abortSession(currentSession.port, currentSession.sessionId).catch(() => false);
    }

    // A reset must not leave any OpenCode session capable of supplying the
    // pre-reset conversation. Delete every session on the OpenCode server,
    // not only the session currently mapped to this Discord channel.
    const ports = new Set<number>();
    if (currentSession) ports.add(currentSession.port);
    for (const session of dataStore.getAllThreadSessions()) ports.add(session.port);

    try {
      for (const port of ports) {
        const sessions = await sessionManager.listSessions(port);
        for (const session of sessions) {
          await sessionManager.abortSession(port, session.id).catch(() => false);
          const deleted = await sessionManager.deleteSession(port, session.id);
          if (!deleted) {
            await interaction.editReply('❌ Could not delete the old AI conversation. Your memory was not reset.');
            return;
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes('credentials') || error.message.includes('requires authentication'))) {
        await interaction.editReply(`❌ ${error.message}`);
        return;
      }
      await interaction.editReply('❌ Could not delete the old AI conversation. Your memory was not reset.');
      return;
    }

    // Clear all persisted memory for this Discord user and remove every
    // Discord-thread session mapping so the next message starts from zero.
    for (const session of dataStore.getAllThreadSessions()) {
      sessionManager.clearSessionForThread(session.threadId);
    }
    memory.clearUserMemory(userId);
    dataStore.clearQueue(conversationId);
    dataStore.updateQueueSettings(conversationId, { freshContext: false });

    await interaction.editReply('✅ memory reset — all of your saved conversation history was forgotten.');
  },
};
