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

    const channelId = interaction.channelId;
    const botId = interaction.client.user?.id ?? 'unknown-bot';
    const conversationId = `${botId}:${channelId}`;
    const userId = interaction.user.id;

    // Delete every tracked OpenCode session belonging to this bot. Sessions
    // are keyed as botId:channelId, so another Discord bot's conversations
    // are never touched by this reset.
    const trackedSessions = dataStore.getAllThreadSessions().filter(session =>
      session.threadId === conversationId || session.threadId.startsWith(`${botId}:`),
    );

    // Also check the old channel-only key once for sessions created before
    // bot-scoped session IDs were introduced.
    const legacySession = sessionManager.getSessionForThread(channelId);
    const sessionsToDelete = new Map<string, { threadId: string; sessionId: string; projectPath: string; port: number }>();
    for (const session of trackedSessions) {
      sessionsToDelete.set(`${session.port}:${session.sessionId}`, session);
    }
    if (legacySession) {
      sessionsToDelete.set(`${legacySession.port}:${legacySession.sessionId}`, {
        threadId: channelId,
        ...legacySession,
      });
    }

    for (const session of sessionsToDelete.values()) {
      const sseClient = sessionManager.getSseClient(session.threadId);
      if (sseClient) {
        sseClient.disconnect();
        sessionManager.clearSseClient(session.threadId);
      }
      await sessionManager.abortSession(session.port, session.sessionId).catch(() => false);
    }

    try {
      for (const session of sessionsToDelete.values()) {
        const deleted = await sessionManager.deleteSession(session.port, session.sessionId);
        if (!deleted) {
          await interaction.editReply('❌ Could not delete the old AI conversation. Your memory was not reset.');
          return;
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

    // Remove all tracked session mappings for this bot, plus the legacy key.
    for (const session of trackedSessions) sessionManager.clearSessionForThread(session.threadId);
    sessionManager.clearSessionForThread(channelId);

    // Remove persisted memory for the user. Memory retrieval itself is
    // conversation-scoped, so this cannot cause another bot to inherit it.
    memory.clearUserMemory(userId);
    dataStore.clearQueue(conversationId);
    dataStore.updateQueueSettings(conversationId, { freshContext: false });

    await interaction.editReply('✅ memory reset — all of your saved conversation history was forgotten.');
  },
};
