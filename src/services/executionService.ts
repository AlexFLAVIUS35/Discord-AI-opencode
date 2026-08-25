import { TextBasedChannel, EmbedBuilder, Message } from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import * as storage from './storageService.js';
import { SSEClient } from './sseClient.js';
import { formatOutputForMobile } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';

async function reactToLatestUserMessage(channel: TextBasedChannel, emoji: string): Promise<void> {
  try {
    if (!('messages' in channel)) return;
    const messages = await (channel as any).messages.fetch({ limit: 20 });
    const target = messages.find((message: Message) => !message.author.bot && !message.system);
    if (target) await target.react(emoji);
  } catch (error) {
    console.error(`Failed to add AI reaction ${emoji}:`, error instanceof Error ? error.message : error);
  }
}

async function processAiReactions(channel: TextBasedChannel, text: string): Promise<string> {
  // [react:🥹✌️] means two reactions: 🥹 and ✌️. Intl.Segmenter keeps
  // multi-codepoint emojis such as ❤️ and 👍🏽 intact while splitting adjacent emojis.
  const reactions: string[] = [];
  const cleaned = text.replace(/\[react:([^\]\r\n]{1,64})\]/gu, (_match, emojiText: string) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const part of segmenter.segment(emojiText.trim())) {
      const emoji = part.segment.trim();
      if (emoji) reactions.push(emoji);
    }
    return '';
  });
  for (const emoji of reactions) {
    await reactToLatestUserMessage(channel, emoji);
  }
  return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export async function runPrompt(channel: TextBasedChannel, threadId: string, prompt: string, parentChannelId: string, userId?: string): Promise<void> {
  const storageEnabled = storage.isEnabled(threadId);
  const projectPath = storage.getWorkspace(threadId);
  const configuredProjectPath = dataStore.getChannelProjectPath(parentChannelId);
  let worktreeMapping = storageEnabled ? dataStore.getWorktreeMapping(threadId) : undefined;

  if (storageEnabled && storage.isEnabled(threadId) && !configuredProjectPath) {
    // /storage activate is the new simple mode; the configured storage path is enough.
  }

  if (storageEnabled && !worktreeMapping) {
    const projectAlias = dataStore.getChannelBinding(parentChannelId);
    if (projectAlias && dataStore.getProjectAutoWorktree(projectAlias) && configuredProjectPath) {
      try {
        const branchName = worktreeManager.sanitizeBranchName(`auto/${threadId.slice(0, 8)}-${Date.now()}`);
        const worktreePath = await worktreeManager.createWorktree(configuredProjectPath, branchName);
        const newMapping = { threadId, branchName, worktreePath, projectPath: configuredProjectPath, description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''), createdAt: Date.now() };
        dataStore.setWorktreeMapping(newMapping);
        worktreeMapping = newMapping;
        const embed = new EmbedBuilder().setTitle(`🌳 Auto-Worktree: ${branchName}`).setDescription('Automatically created for this session').addFields({ name: 'Branch', value: branchName, inline: true }, { name: 'Path', value: worktreePath, inline: true }).setColor(0x2ecc71);
        await (channel as any).send({ embeds: [embed] });
      } catch (error) { console.error('Auto-worktree creation failed:', error); }
    }
  }

  const effectivePath = storageEnabled ? (worktreeMapping?.worktreePath ?? projectPath) : projectPath;
  const preferredModel = dataStore.getChannelModel(parentChannelId);

  try { await (channel as any).sendTyping(); } catch { }

  let port: number; let sessionId: string; let accumulatedText = ''; let promptSent = false; let hasSessionError = false; let responseHandled = false;
  const safeSend = async (content: string): Promise<boolean> => { try { await (channel as any).send({ content }); return true; } catch (error) { console.error('Failed to send message:', error instanceof Error ? error.message : error); return false; } };
  const continueQueue = async () => {
    try { await processNextInQueue(channel, threadId, parentChannelId); }
    catch (error) { console.error('Failed to continue queue:', error); }
  };

  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel, storageEnabled);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel, storageEnabled);
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.freshContext) sessionManager.clearSessionForThread(threadId);
    sessionId = await sessionManager.ensureSessionForThread(threadId, effectivePath, port);
    const sseClient = new SSEClient(); sseClient.connect(`http://127.0.0.1:${port}`); sessionManager.setSseClient(threadId, sseClient);
    sseClient.onPartUpdated((part) => { if (part.sessionID === sessionId) accumulatedText = part.text; });
    sseClient.onSessionIdle((idleSessionId) => {
      if (idleSessionId !== sessionId || !promptSent || responseHandled) return;
      responseHandled = true;
      (async () => {
        try {
          if (hasSessionError) { sseClient.disconnect(); sessionManager.clearSseClient(threadId); return; }
          if (!accumulatedText.trim()) { await safeSend('⚠️ No output received — the model may have encountered an issue.'); }
          else {
            const reactedText = await processAiReactions(channel, accumulatedText);
            if (reactedText) {
              const result = formatOutputForMobile(reactedText);
              for (const chunk of result.chunks) await safeSend(chunk);
            }
          }
          sseClient.disconnect(); sessionManager.clearSseClient(threadId); await continueQueue();
        } catch (error) { console.error('Error in onSessionIdle:', error); }
      })();
    });
    sseClient.onSessionError((errorSessionId, errorInfo) => {
      if (errorSessionId !== sessionId || !promptSent || responseHandled) return; hasSessionError = true; responseHandled = true;
      console.error('OpenCode session error:', errorInfo);
      (async () => { sseClient.disconnect(); sessionManager.clearSseClient(threadId); await continueQueue(); })().catch((error) => console.error('Error continuing after session error:', error));
    });
    sseClient.onError((error) => {
      if (responseHandled) return;
      responseHandled = true;
      console.error('OpenCode SSE connection error:', error);
      (async () => { sseClient.disconnect(); sessionManager.clearSseClient(threadId); await continueQueue(); })().catch((queueError) => console.error('Error continuing after SSE error:', queueError));
    });

    const personality = userId ? dataStore.getUserPersonality(userId) : undefined;
    const reactionInstructions = `\n\nDiscord reaction capability: You may react to the user's latest message when you genuinely feel like it. To do so, include [react:EMOJI] in your response, for example [react:😭] or [react:💀]. You can also include normal text in the same response, and you can request multiple reactions in one marker, such as [react:🥹✌️]. Each adjacent emoji is treated as a separate reaction. The marker will be hidden from the user. Do not use reactions constantly; they should be occasional and spontaneous. If you want only a reaction and no text, output only the marker. Never explain the marker.`;
    const effectivePrompt = personality
      ? `[Permanent personality instructions for this Discord user]\n${personality}\n\n[User message]\n${prompt}${reactionInstructions}`
      : `${prompt}${reactionInstructions}`;
    await sessionManager.sendPrompt(port, sessionId, effectivePrompt, preferredModel);
    promptSent = true;
  } catch (error) {
    console.error('OpenCode execution failed:', error);
    const client = sessionManager.getSseClient(threadId); if (client) { client.disconnect(); sessionManager.clearSseClient(threadId); }
    await continueQueue();
  }
}
