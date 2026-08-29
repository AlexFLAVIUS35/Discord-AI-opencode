import { Message, MessageFlags, TextBasedChannel } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';
import * as sessionManager from '../services/sessionManager.js';
import { isAuthorized } from '../services/configStore.js';
import { transcribe, isVoiceEnabled } from '../services/voiceService.js';
import * as activation from '../services/activationService.js';
import { buildDiscordContext } from '../services/discordContextService.js';
import { isExcessiveEnumerationRequest, EXCESSIVE_ENUMERATION_MESSAGE, applyAIEnumerationClassification, getEnumerationMaxRequested } from '../utils/requestGuard.js';
import { classifyEnumerationRequest } from '../utils/aiEnumerationGuard.js';

const ACTIVE_LISTEN_DELAY_MS = 3000;

type PendingActiveMessage = {
  message: Message;
  prompt: string;
  userId: string;
  parentChannelId: string;
};

type PendingActiveTurn = {
  channel: TextBasedChannel;
  messages: PendingActiveMessage[];
  timer: NodeJS.Timeout;
};

// Debounce active-mode messages so Leeha listens for a short burst of conversation
// before deciding to respond. A new message resets the three-second window.
const pendingActiveTurns = new Map<string, PendingActiveTurn>();

async function flushActiveTurn(conversationId: string): Promise<void> {
  const pending = pendingActiveTurns.get(conversationId);
  if (!pending) return;
  pendingActiveTurns.delete(conversationId);

  const messages = pending.messages;
  if (!messages.length) return;

  const latest = messages[messages.length - 1];
  try {
    const discordContext = await buildDiscordContext(latest.message);
    const burst = messages.length > 1
      ? `\n\n[Messages received during the 3-second listening window]\n${messages.map(item => `[${item.message.id}] ${item.message.member?.displayName ?? item.message.author.globalName ?? item.message.author.username} (${item.userId}): ${item.prompt}`).join('\n')}`
      : '';
    const contextualPrompt = discordContext
      ? `${discordContext}${burst}\n\n[Current user: ${latest.message.member?.displayName ?? latest.message.author.globalName ?? latest.message.author.username} (${latest.userId})]\n[Current user message]\n${latest.prompt}`
      : `${burst}\n\n[Current user: ${latest.message.member?.displayName ?? latest.message.author.globalName ?? latest.message.author.username} (${latest.userId})]\n[Current user message]\n${latest.prompt}`;

    if (isBusy(conversationId) || sessionManager.isExecutionActive(conversationId)) {
      dataStore.addToQueue(conversationId, { prompt: contextualPrompt, userId: latest.userId, timestamp: Date.now() });
      return;
    }

    await runPrompt(pending.channel, conversationId, contextualPrompt, latest.parentChannelId, latest.userId);
  } catch (error) {
    console.error('[Active Mode] Failed to flush listening window:', error instanceof Error ? error.message : error);
  }
}

function scheduleActiveMessage(message: Message, prompt: string, parentChannelId: string): void {
  const conversationId = message.channel.id;
  const existing = pendingActiveTurns.get(conversationId);
  if (existing) {
    existing.messages.push({ message, prompt, userId: message.author.id, parentChannelId });
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => { void flushActiveTurn(conversationId); }, ACTIVE_LISTEN_DELAY_MS);
    return;
  }

  const timer = setTimeout(() => { void flushActiveTurn(conversationId); }, ACTIVE_LISTEN_DELAY_MS);
  pendingActiveTurns.set(conversationId, {
    channel: message.channel,
    messages: [{ message, prompt, userId: message.author.id, parentChannelId }],
    timer,
  });
}

async function safeReact(message: Message, emoji: string): Promise<void> {
  try { await message.react(emoji); }
  catch (error) { console.error(`[Voice STT] Failed to react with ${emoji}:`, error instanceof Error ? error.message : error); }
}
async function safeRemoveReaction(message: Message, emoji: string): Promise<void> {
  try { await message.reactions.cache.get(emoji)?.users.remove(message.client.user!.id); }
  catch (error) { console.error(`[Voice STT] Failed to remove reaction ${emoji}:`, error instanceof Error ? error.message : error); }
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot || message.system) return;
  if (!isAuthorized(message.author.id)) return;
  const conversationId = message.channel.id;
  const enumerationScope = `${message.author.id}:${conversationId}`;

  const defaultActive = !message.guildId;
  if (!activation.isActive(conversationId, defaultActive)) return;

  let prompt = message.content.trim();
  const isVoiceMessage = !prompt && isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage);
  const voiceAttachment = isVoiceMessage ? message.attachments.first() : undefined;
  if (!prompt && !voiceAttachment) return;

  if (message.client.user) prompt = prompt.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();

  if (prompt) {
    const previousMaxRequested = getEnumerationMaxRequested(enumerationScope);
    const looksPotentiallyEnumerative = previousMaxRequested > 0 || /\b(?:count|counting|enumerat|list|number|numbers|items?|add|another|more|continue|keep going|print|output|generate)\b/i.test(prompt);
    let aiRecognized = false;
    if (looksPotentiallyEnumerative) {
      const classification = await classifyEnumerationRequest(prompt, previousMaxRequested);
      if (classification?.isEnumeration && classification.confidence >= 0.75 && classification.requestedCount !== null) {
        aiRecognized = true;
        if (applyAIEnumerationClassification(enumerationScope, classification.requestedCount, classification.isContinuation)) {
          await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {}); return;
        }
      } else if (classification && !classification.isEnumeration && classification.confidence >= 0.75) aiRecognized = true;
    }
    if (!aiRecognized && isExcessiveEnumerationRequest(prompt, enumerationScope)) {
      await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {}); return;
    }
  }

  // Treat the whole active channel as one conversation. A processing lock closes
  // the tiny race between a response finishing and its coalesced follow-up turn
  // starting, which previously created multiple permanent running indicators.
  if (isBusy(conversationId) || sessionManager.isExecutionActive(conversationId)) {
    if (voiceAttachment) dataStore.addToQueue(conversationId, { prompt: '', userId: message.author.id, timestamp: Date.now(), voiceAttachmentUrl: voiceAttachment.url, voiceAttachmentSize: voiceAttachment.size });
    else dataStore.addToQueue(conversationId, { prompt, userId: message.author.id, timestamp: Date.now() });
    return;
  }

  if (voiceAttachment) {
    await safeReact(message, '🎙️');
    try {
      prompt = await transcribe(voiceAttachment.url, voiceAttachment.size); await safeRemoveReaction(message, '🎙️');
    } catch (error) {
      console.error('[Voice STT] Transcription failed:', error instanceof Error ? error.message : error);
      await safeReact(message, '❌');
      await message.reply({ content: error instanceof Error && error.message === 'AUTH_FAILURE' ? '❌ Transcription failed. Check the voice API key with `/voice status`.' : '❌ Voice transcription failed. Check server logs.' }).catch(() => {}); return;
    }
    if (!prompt.trim()) { await safeReact(message, '❌'); return; }
  }

  const parentChannelId = message.channel.isThread() ? (message.channel.parentId ?? conversationId) : conversationId;

  // In active mode, wait three seconds after the latest message before deciding
  // whether to respond. Messages arriving during that window are included as a
  // single conversational burst instead of triggering separate model runs.
  if (!voiceAttachment) {
    scheduleActiveMessage(message, prompt, parentChannelId);
    return;
  }

  const discordContext = await buildDiscordContext(message);
  const contextualPrompt = discordContext
    ? `${discordContext}\n\n[Current user: ${message.member?.displayName ?? message.author.globalName ?? message.author.username} (${message.author.id})]\n[Current user message]\n${prompt}`
    : `[Current user: ${message.member?.displayName ?? message.author.globalName ?? message.author.username} (${message.author.id})]\n[Current user message]\n${prompt}`;

  await runPrompt(message.channel, conversationId, contextualPrompt, parentChannelId, message.author.id);
}
