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

    // Sessions are bot-scoped now. Also check the old channel-only key once so
    // a session created by a pre-isolation deployment cannot leak into the new
    // context after a reset.
    const currentSession = sessionManager.getSessionForThread(conversationId);
    const legacySession = sessionManager.getSessionForThread(channelId);
    const sessionsToDelete = new Map<string, { sessionId: string; projectPath: string; port: number }>();
    if (currentSession) sessionsToDelete.set(`${currentSession.port}:${currentSession.sessionId}`, currentSession);
    if (legacySession) sessionsToDelete.set(`${legacySession.port}:${legacySession.sessionId}`, legacySession);

    for (const session of sessionsToDelete.values()) {
      const key = session === currentSession ? conversationId : channelId;
      const sseClient = sessionManager.getSseClient(key);
      if (sseClient) {
        sseClient.disconnect();
        sessionManager.clearSseClient(key);
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

    // Remove the bot-scoped session mappings. Do not delete other bots'
    // sessions: multiple Discord bots may share the same OpenCode server.
    sessionManager.clearSessionForThread(conversationId);
    sessionManager.clearSessionForThread(channelId);

    // /reset is a user-level memory reset, so saved memories from all of this
    // user's conversations are removed rather than only the current channel.
    memory.clearUserMemory(userId);
    dataStore.clearQueue(conversationId);
    dataStore.updateQueueSettings(conversationId, { freshContext: false });

    await interaction.editReply('✅ memory reset — all of your saved conversation history was forgotten.');
  },
};
