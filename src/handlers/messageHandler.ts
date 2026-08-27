import { Message, MessageFlags } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';
import { isAuthorized } from '../services/configStore.js';
import { transcribe, isVoiceEnabled } from '../services/voiceService.js';
import * as activation from '../services/activationService.js';
import { buildDiscordContext } from '../services/discordContextService.js';
import { isExcessiveEnumerationRequest, EXCESSIVE_ENUMERATION_MESSAGE, applyAIEnumerationClassification, getEnumerationMaxRequested } from '../utils/requestGuard.js';
import { classifyEnumerationRequest } from '../utils/aiEnumerationGuard.js';

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

  if (message.client.user) {
    prompt = prompt.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
  }

  if (prompt) {
    const previousMaxRequested = getEnumerationMaxRequested(enumerationScope);
    const looksPotentiallyEnumerative = previousMaxRequested > 0 ||
      /\b(?:count|counting|enumerat|list|number|numbers|items?|add|another|more|continue|keep going|print|output|generate)\b/i.test(prompt);

    let aiRecognized = false;
    if (looksPotentiallyEnumerative) {
      const classification = await classifyEnumerationRequest(prompt, previousMaxRequested);
      if (classification?.isEnumeration && classification.confidence >= 0.75 && classification.requestedCount !== null) {
        aiRecognized = true;
        if (applyAIEnumerationClassification(enumerationScope, classification.requestedCount, classification.isContinuation)) {
          await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {});
          return;
        }
      } else if (classification && !classification.isEnumeration && classification.confidence >= 0.75) {
        aiRecognized = true;
      }
    }

    if (!aiRecognized && isExcessiveEnumerationRequest(prompt, enumerationScope)) {
      await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {});
      return;
    }
  }

  if (isBusy(conversationId)) {
    if (voiceAttachment) dataStore.addToQueue(conversationId, { prompt: '', userId: message.author.id, timestamp: Date.now(), voiceAttachmentUrl: voiceAttachment.url, voiceAttachmentSize: voiceAttachment.size });
    else dataStore.addToQueue(conversationId, { prompt, userId: message.author.id, timestamp: Date.now() });
    return;
  }

  if (voiceAttachment) {
    await safeReact(message, '🎙️');
    try {
      prompt = await transcribe(voiceAttachment.url, voiceAttachment.size);
      await safeRemoveReaction(message, '🎙️');
    } catch (error) {
      console.error('[Voice STT] Transcription failed:', error instanceof Error ? error.message : error);
      await safeReact(message, '❌');
      await message.reply({ content: error instanceof Error && error.message === 'AUTH_FAILURE' ? '❌ Transcription failed. Check the voice API key with `/voice status`.' : '❌ Voice transcription failed. Check server logs.' }).catch(() => {});
      return;
    }
    if (!prompt.trim()) { await safeReact(message, '❌'); return; }
  }

  const parentChannelId = message.channel.isThread() ? (message.channel.parentId ?? conversationId) : conversationId;

  // Give the single active OpenCode conversation an explicit snapshot of the
  // Discord conversation so different users, replies, and reactions remain
  // distinguishable even though the OpenCode session is shared by the channel.
  const discordContext = await buildDiscordContext(message);
  const contextualPrompt = discordContext
    ? `${discordContext}\n\n[Current user: ${message.member?.displayName ?? message.author.globalName ?? message.author.username} (${message.author.id})]\n[Current user message]\n${prompt}`
    : `[Current user: ${message.member?.displayName ?? message.author.globalName ?? message.author.username} (${message.author.id})]\n[Current user message]\n${prompt}`;

  await runPrompt(message.channel, conversationId, contextualPrompt, parentChannelId, message.author.id);
}
