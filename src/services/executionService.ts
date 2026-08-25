import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Message, TextBasedChannel, EmbedBuilder } from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import * as storage from './storageService.js';
import { SSEClient } from './sseClient.js';
import { formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';

export async function runPrompt(channel: TextBasedChannel, threadId: string, prompt: string, parentChannelId: string): Promise<void> {
  const storageEnabled = storage.isEnabled(threadId);
  const projectPath = storage.getWorkspace(threadId);
  const configuredProjectPath = dataStore.getChannelProjectPath(parentChannelId);
  let worktreeMapping = storageEnabled ? dataStore.getWorktreeMapping(threadId) : undefined;

  if (storageEnabled && !configuredProjectPath) {
    // /storage activate is the new simple mode; the configured storage path is enough.
  }

  if (storageEnabled && !worktreeMapping) {
    const projectAlias = dataStore.getChannelBinding(parentChannelId);
    if (projectAlias && dataStore.getProjectAutoWorktree(projectAlias) && configuredProjectPath) {
      try {
        const branchName = worktreeManager.sanitizeBranchName(`auto/${threadId.slice(0, 8)}-${Date.now()}`);
        const worktreePath = await worktreeManager.createWorktree(configuredProjectPath, branchName);
        const newMapping = {
          threadId, branchName, worktreePath, projectPath: configuredProjectPath,
          description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''), createdAt: Date.now()
        };
        dataStore.setWorktreeMapping(newMapping);
        worktreeMapping = newMapping;
        const embed = new EmbedBuilder()
          .setTitle(`🌳 Auto-Worktree: ${branchName}`)
          .setDescription('Automatically created for this session')
          .addFields({ name: 'Branch', value: branchName, inline: true }, { name: 'Path', value: worktreePath, inline: true })
          .setColor(0x2ecc71);
        const worktreeButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`delete_${threadId}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`pr_${threadId}`).setLabel('Create PR').setStyle(ButtonStyle.Primary)
        );
        await (channel as any).send({ embeds: [embed], components: [worktreeButtons] });
      } catch (error) {
        console.error('Auto-worktree creation failed:', error);
      }
    }
  }

  const effectivePath = storageEnabled ? (worktreeMapping?.worktreePath ?? projectPath) : projectPath;
  const preferredModel = dataStore.getChannelModel(parentChannelId);

  // Orange mode: show only a minimal running message while OpenCode works.
  // The final AI response replaces this message; no AI Chat/prompt echo or live output.
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`interrupt_${threadId}`).setLabel('⏸️ Interrupt').setStyle(ButtonStyle.Secondary)
  );

  let streamMessage: Message;
  try {
    streamMessage = await (channel as any).send({ content: '⠦ **Running...**', components: [buttons] });
  } catch {
    return;
  }

  let port: number;
  let sessionId: string;
  let accumulatedText = '';
  let promptSent = false;
  let hasSessionError = false;

  const updateStreamMessage = async (content: string, components: ActionRowBuilder<ButtonBuilder>[] = []): Promise<boolean> => {
    try { await streamMessage.edit({ content, components }); return true; }
    catch (error) { console.error('Failed to edit stream message:', error instanceof Error ? error.message : error); return false; }
  };
  const safeSend = async (content: string): Promise<boolean> => {
    try { await (channel as any).send({ content }); return true; }
    catch (error) { console.error('Failed to send message:', error instanceof Error ? error.message : error); return false; }
  };

  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel, storageEnabled);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel, storageEnabled);

    const settings = dataStore.getQueueSettings(threadId);
    if (settings.freshContext) sessionManager.clearSessionForThread(threadId);

    sessionId = await sessionManager.ensureSessionForThread(threadId, effectivePath, port);
    const sseClient = new SSEClient();
    sseClient.connect(`http://127.0.0.1:${port}`);
    sessionManager.setSseClient(threadId, sseClient);

    sseClient.onPartUpdated((part) => { if (part.sessionID === sessionId) accumulatedText = part.text; });
    sseClient.onSessionIdle((idleSessionId) => {
      if (idleSessionId !== sessionId || !promptSent) return;
      (async () => {
        try {
          if (hasSessionError) { sseClient.disconnect(); sessionManager.clearSseClient(threadId); return; }
          if (!accumulatedText.trim()) {
            const edited = await updateStreamMessage('⚠️ No output received — the model may have encountered an issue.');
            if (!edited) await safeSend('⚠️ No output received — the model may have encountered an issue.');
          } else {
            const result = formatOutputForMobile(accumulatedText);
            const editSuccess = await updateStreamMessage(result.chunks[0]);
            const startIndex = editSuccess ? 1 : 0;
            for (let i = startIndex; i < result.chunks.length; i++) await safeSend(result.chunks[i]);
          }
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          await processNextInQueue(channel, threadId, parentChannelId);
        } catch (error) {
          console.error('Error in onSessionIdle:', error);
          await safeSend('❌ An unexpected error occurred while processing the response.');
        }
      })();
    });

    sseClient.onSessionError((errorSessionId, errorInfo) => {
      if (errorSessionId !== sessionId || !promptSent) return;
      hasSessionError = true;
      (async () => {
        const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
        const edited = await updateStreamMessage(`❌ **Error**: ${errorMsg}`);
        if (!edited) await safeSend(`❌ **Error**: ${errorMsg}`);
        sseClient.disconnect(); sessionManager.clearSseClient(threadId);
        const settings = dataStore.getQueueSettings(threadId);
        if (settings.continueOnFailure) await processNextInQueue(channel, threadId, parentChannelId);
        else { dataStore.clearQueue(threadId); await safeSend('❌ Execution failed. Queue cleared.'); }
      })().catch(console.error);
    });

    sseClient.onError((error) => {
      (async () => {
        const edited = await updateStreamMessage(`❌ Connection error: ${error.message}`);
        if (!edited) await safeSend(`❌ Connection error: ${error.message}`);
        sseClient.disconnect(); sessionManager.clearSseClient(threadId);
        const settings = dataStore.getQueueSettings(threadId);
        if (settings.continueOnFailure) await processNextInQueue(channel, threadId, parentChannelId);
        else { dataStore.clearQueue(threadId); await safeSend('❌ Execution failed. Queue cleared.'); }
      })().catch(console.error);
    });

    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    promptSent = true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const edited = await updateStreamMessage(`❌ OpenCode execution failed: ${errorMessage}`);
    if (!edited) await safeSend(`❌ OpenCode execution failed: ${errorMessage}`);
    const client = sessionManager.getSseClient(threadId);
    if (client) { client.disconnect(); sessionManager.clearSseClient(threadId); }
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.continueOnFailure) await processNextInQueue(channel, threadId, parentChannelId);
    else { dataStore.clearQueue(threadId); await safeSend('❌ Execution failed. Queue cleared.'); }
  }
}
