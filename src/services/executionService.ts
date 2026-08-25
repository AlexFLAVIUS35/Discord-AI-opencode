import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Message, TextBasedChannel, EmbedBuilder } from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import * as storage from './storageService.js';
import { SSEClient } from './sseClient.js';
import { formatOutput, formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';

export async function runPrompt(channel: TextBasedChannel, threadId: string, prompt: string, parentChannelId: string): Promise<void> {
  const storageEnabled = storage.isEnabled(threadId);
  const projectPath = storage.getWorkspace(threadId);
  const configuredProjectPath = dataStore.getChannelProjectPath(parentChannelId);

  // Legacy project/worktree functionality is only used when storage is explicitly enabled.
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
  const preferredModel = storageEnabled ? dataStore.getChannelModel(parentChannelId) : dataStore.getChannelModel(parentChannelId);
  const modelDisplay = preferredModel ? `${preferredModel}` : 'default';
  const branchName = storageEnabled && worktreeMapping?.branchName
    ? worktreeMapping.branchName
    : (storageEnabled && configuredProjectPath ? await worktreeManager.getCurrentBranch(effectivePath) : null) ?? 'chat';
  const contextHeader = storageEnabled ? buildContextHeader(branchName, modelDisplay) : '🤖 **AI Chat**';

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`interrupt_${threadId}`).setLabel('⏸️ Interrupt').setStyle(ButtonStyle.Secondary)
  );

  let streamMessage: Message;
  try {
    streamMessage = await (channel as any).send({ content: `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n🚀 Starting OpenCode...`, components: [buttons] });
  } catch {
    return;
  }

  let port: number;
  let sessionId: string;
  let updateInterval: NodeJS.Timeout | null = null;
  let accumulatedText = '';
  let lastContent = '';
  let tick = 0;
  let promptSent = false;
  let hasSessionError = false;
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  const updateStreamMessage = async (content: string, components: ActionRowBuilder<ButtonBuilder>[]): Promise<boolean> => {
    try { await streamMessage.edit({ content, components }); return true; }
    catch (error) { console.error('Failed to edit stream message:', error instanceof Error ? error.message : error); return false; }
  };
  const safeSend = async (content: string): Promise<boolean> => {
    try { await (channel as any).send({ content }); return true; }
    catch (error) { console.error('Failed to send message:', error instanceof Error ? error.message : error); return false; }
  };

  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel, storageEnabled);
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⏳ Waiting for OpenCode...`, [buttons]);
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
      if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
      (async () => {
        try {
          if (hasSessionError) { sseClient.disconnect(); sessionManager.clearSseClient(threadId); return; }
          const disabledButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`interrupt_${threadId}`).setLabel('⏸️ Interrupt').setStyle(ButtonStyle.Secondary).setDisabled(true)
          );
          if (!accumulatedText.trim()) {
            const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⚠️ No output received — the model may have encountered an issue.`, [disabledButtons]);
            if (!edited) await safeSend('⚠️ No output received — the model may have encountered an issue.');
          } else {
            const result = formatOutputForMobile(accumulatedText);
            const editSuccess = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${result.chunks[0]}`, [disabledButtons]);
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
      if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
      (async () => {
        const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
        const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ **Error**: ${errorMsg}`, []);
        if (!edited) await safeSend(`❌ **Error**: ${errorMsg}`);
        sseClient.disconnect(); sessionManager.clearSseClient(threadId);
        const settings = dataStore.getQueueSettings(threadId);
        if (settings.continueOnFailure) await processNextInQueue(channel, threadId, parentChannelId);
        else { dataStore.clearQueue(threadId); await safeSend('❌ Execution failed. Queue cleared.'); }
      })().catch(console.error);
    });

    sseClient.onError((error) => {
      if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
      (async () => {
        const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ Connection error: ${error.message}`, []);
        if (!edited) await safeSend(`❌ Connection error: ${error.message}`);
        sseClient.disconnect(); sessionManager.clearSseClient(threadId);
        const settings = dataStore.getQueueSettings(threadId);
        if (settings.continueOnFailure) await processNextInQueue(channel, threadId, parentChannelId);
        else { dataStore.clearQueue(threadId); await safeSend('❌ Execution failed. Queue cleared.'); }
      })().catch(console.error);
    });

    updateInterval = setInterval(async () => {
      tick++;
      try {
        const formatted = formatOutput(accumulatedText);
        const spinnerChar = spinner[tick % spinner.length];
        const newContent = formatted || 'Processing...';
        if (newContent !== lastContent || tick % 2 === 0) {
          lastContent = newContent;
          await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${spinnerChar} **Running...**\n${newContent}`, [buttons]);
        }
      } catch (error) { console.error('Error in stream update interval:', error instanceof Error ? error.message : error); }
    }, 1000);

    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n📝 Sending prompt...`, [buttons]);
    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    promptSent = true;
  } catch (error) {
    if (updateInterval) clearInterval(updateInterval);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ OpenCode execution failed: ${errorMessage}`, []);
    if (!edited) await safeSend(`❌ OpenCode execution failed: ${errorMessage}`);
    const client = sessionManager.getSseClient(threadId);
    if (client) { client.disconnect(); sessionManager.clearSseClient(threadId); }
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.continueOnFailure) await processNextInQueue(channel, threadId, parentChannelId);
    else { dataStore.clearQueue(threadId); await safeSend('❌ Execution failed. Queue cleared.'); }
  }
}
