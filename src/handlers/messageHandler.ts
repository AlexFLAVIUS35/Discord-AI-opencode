import { Message, MessageFlags } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';
import { isAuthorized } from '../services/configStore.js';
import { transcribe, isVoiceEnabled } from '../services/voiceService.js';
import * as activation from '../services/activationService.js';
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
    // Snapshot before the deterministic guard. If it changes, the regex parser
    // already understood this request and the AI must not count it twice.
    const maxBeforeGuard = getEnumerationMaxRequested(enumerationScope);
    if (isExcessiveEnumerationRequest(prompt, enumerationScope)) {
      await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {});
      return;
    }
    const maxAfterGuard = getEnumerationMaxRequested(enumerationScope);
    const deterministicRecognized = maxAfterGuard !== maxBeforeGuard;

    // AI fallback catches natural-language variants the parser cannot safely
    // recognize. It is only called for likely repetitive/counting prompts or
    // while an enumeration is already active.
    const looksPotentiallyEnumerative = maxAfterGuard > 0 ||
      /\b(?:count|counting|enumerat|list|number|numbers|items?|add|another|more|continue|keep going|print|output|generate)\b/i.test(prompt);

    if (!deterministicRecognized && looksPotentiallyEnumerative) {
      const classification = await classifyEnumerationRequest(prompt, maxAfterGuard);
      if (classification?.isEnumeration && classification.confidence >= 0.75 && classification.requestedCount !== null) {
        if (applyAIEnumerationClassification(enumerationScope, classification.requestedCount, classification.isContinuation)) {
          await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {});
          return;
        }
      }
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
  await runPrompt(message.channel, conversationId, prompt, parentChannelId, message.author.id);
}
