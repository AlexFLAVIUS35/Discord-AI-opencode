import { SlashCommandBuilder } from 'discord.js';
import * as sessionManager from '../services/sessionManager.js';
import { isAuthorized } from '../services/configStore.js';

export const interrupt = {
  data: new SlashCommandBuilder()
    .setName('interrupt')
    .setDescription('Interrupt your active AI response in this conversation.'),

  async execute(interaction: any): Promise<void> {
    if (!isAuthorized(interaction.user.id)) {
      await interaction.reply({ content: '🚫 You are not authorized to use this bot.', ephemeral: true });
      return;
    }

    const conversationId = interaction.channelId as string;
    const active = sessionManager.getSessionForThread(conversationId);
    const sseClient = sessionManager.getSseClient(conversationId);

    if (!active || !sseClient || !sseClient.isConnected()) {
      await interaction.reply({ content: 'ℹ️ There is no active AI response in this conversation.', ephemeral: true });
      return;
    }

    const stopped = await sessionManager.abortSession(active.port, active.sessionId);
    if (stopped) {
      sseClient.disconnect();
      sessionManager.clearSseClient(conversationId);
      await interaction.reply({ content: '⏹️ Interrupted.', ephemeral: true });
    } else {
      await interaction.reply({ content: '❌ I could not interrupt the active response.', ephemeral: true });
    }
  }
};
