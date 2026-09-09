import { Message, MessageFlags, TextBasedChannel } from 'discord.js';
import { runPrompt, type RunPromptMedia } from '../services/executionService.js';
import * as dataStore from '../services/dataStore.js';
import { isBusy } from '../services/queueManager.js';
import * as sessionManager from '../services/sessionManager.js';
import { isAuthorized } from '../services/configStore.js';
import { transcribe, isVoiceEnabled } from '../services/voiceService.js';
import * as activation from '../services/activationService.js';
import { buildDiscordContext } from '../services/discordContextService.js';
import { isExcessiveEnumerationRequest, EXCESSIVE_ENUMERATION_MESSAGE, applyAIEnumerationClassification, getEnumerationMaxRequested } from '../utils/requestGuard.js';
import { classifyEnumerationRequest } from '../utils/aiEnumerationGuard.js';

const DISCORD_TYPING_ACTIVITY_MS = 10_000;
const ACTIVE_SILENCE_DELAY_MS = 3_000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const recentTypingAt = new Map<string, number>();

type PendingActiveMessage = { message: Message; prompt: string; userId: string; parentChannelId: string };
type PendingActiveTurn = { channel: TextBasedChannel; messages: PendingActiveMessage[]; timer: NodeJS.Timeout; lastTypingAt: number };
const pendingActiveTurns = new Map<string, PendingActiveTurn>();

async function downloadDiscordAttachment(attachment: { url: string; name: string; contentType?: string | null }): Promise<RunPromptMedia | null> {
  const declaredMime = attachment.contentType?.split(';')[0]?.toLowerCase();
  if (!declaredMime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(declaredMime)) return null;
  try {
    const response = await fetch(attachment.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Leeha/1.0',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://discord.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[Media] Discord attachment fetch failed: ${attachment.url} (${response.status} ${response.statusText})`);
      return { url: attachment.url, name: attachment.name, mime: declaredMime };
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_MEDIA_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
    const responseMime = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
    const mime = responseMime && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(responseMime) ? responseMime : declaredMime;
    return { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, name: attachment.name, mime };
  } catch (error) {
    console.error(`[Media] Discord attachment download failed: ${attachment.url}`, error instanceof Error ? error.message : error);
    return { url: attachment.url, name: attachment.name, mime: declaredMime };
  }
}

async function getImageAttachments(messages: Message[]): Promise<RunPromptMedia[]> {
  const result: RunPromptMedia[] = [];
  const seen = new Set<string>();
  for (const message of messages) for (const attachment of message.attachments.values()) {
    const mime = attachment.contentType?.split(';')[0]?.toLowerCase();
    if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) || seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    const media = await downloadDiscordAttachment({ url: attachment.url, name: attachment.name, contentType: mime });
    if (media) result.push(media);
    if (result.length >= 10) return result;
  }
  return result;
}

async function getMediaAttachments(messages: Message[]): Promise<RunPromptMedia[]> {
  const result = await getImageAttachments(messages);
  if (result.length >= 10) return result;
  const seen = new Set(result.map(media => media.url));
  for (const message of messages) {
    const linked = await sessionManager.resolveLinkedGifAttachments(message.content);
    for (const media of linked) {
      if (seen.has(media.url) || result.length >= 10) continue;
      seen.add(media.url);
      result.push(media);
    }
    if (result.length >= 10) break;
  }
  return result;
}

async function flushActiveTurn(conversationId: string): Promise<void> {
  const pending = pendingActiveTurns.get(conversationId);
  if (!pending) return;
  pendingActiveTurns.delete(conversationId);
  const messages = pending.messages;
  if (!messages.length) return;
  const latest = messages[messages.length - 1];
  try {
    const discordContext = await buildDiscordContext(latest.message);
    const burst = messages.length > 1 ? `\n\n[Messages received during the listening window]\n${messages.map(item => `[${item.message.id}] ${item.message.member?.displayName ?? item.message.author.globalName ?? item.message.author.username} (${item.userId}): ${item.prompt}`).join('\n')}` : '';
    const media = await getMediaAttachments(messages.map(item => item.message));
    const contextualPrompt = discordContext ? `${discordContext}${burst}\n\n[Current user: ${latest.message.member?.displayName ?? latest.message.author.globalName ?? latest.message.author.username} (${latest.userId})]\n[Current user message]\n${latest.prompt}` : `${burst}\n\n[Current user: ${latest.message.member?.displayName ?? latest.message.author.globalName ?? latest.message.author.username} (${latest.userId})]\n[Current user message]\n${latest.prompt}`;
    if (isBusy(conversationId) || sessionManager.isExecutionActive(conversationId)) {
      dataStore.addToQueue(conversationId, { prompt: contextualPrompt, userId: latest.userId, timestamp: Date.now(), media }); return;
    }
    await runPrompt(pending.channel, conversationId, contextualPrompt, latest.parentChannelId, latest.userId, undefined, media);
  } catch (error) { console.error('[Active Mode] Failed to flush listening window:', error instanceof Error ? error.message : error); }
}

function scheduleAfterTypingSilence(conversationId: string, pending: PendingActiveTurn): void {
  clearTimeout(pending.timer);
  const lastTyping = pending.lastTypingAt;
  const now = Date.now();
  const typingWindowRemaining = lastTyping ? Math.max(0, DISCORD_TYPING_ACTIVITY_MS - (now - lastTyping)) : 0;
  const delay = typingWindowRemaining + ACTIVE_SILENCE_DELAY_MS;
  pending.timer = setTimeout(() => {
    const latestTyping = recentTypingAt.get(conversationId) ?? pending.lastTypingAt;
    if (latestTyping !== lastTyping || Date.now() - latestTyping < DISCORD_TYPING_ACTIVITY_MS) {
      pending.lastTypingAt = latestTyping;
      scheduleAfterTypingSilence(conversationId, pending);
      return;
    }
    void flushActiveTurn(conversationId);
  }, delay);
}

function scheduleActiveMessage(message: Message, prompt: string, parentChannelId: string): void {
  const conversationId = message.channel.id;
  const existing = pendingActiveTurns.get(conversationId);
  if (existing) {
    existing.messages.push({ message, prompt, userId: message.author.id, parentChannelId });
    existing.lastTypingAt = recentTypingAt.get(conversationId) ?? existing.lastTypingAt;
    scheduleAfterTypingSilence(conversationId, existing);
    return;
  }
  const lastTypingAt = recentTypingAt.get(conversationId) ?? 0;
  const pending: PendingActiveTurn = {
    channel: message.channel,
    messages: [{ message, prompt, userId: message.author.id, parentChannelId }],
    timer: undefined as unknown as NodeJS.Timeout,
    lastTypingAt,
  };
  pendingActiveTurns.set(conversationId, pending);
  scheduleAfterTypingSilence(conversationId, pending);
}

export function handleTypingStart(channelId: string, userId: string): void {
  const now = Date.now();
  recentTypingAt.set(channelId, now);
  const pending = pendingActiveTurns.get(channelId);
  if (!pending) {
    console.debug(`[Active Mode] Typing detected from ${userId}; recorded for the next message.`);
    return;
  }
  pending.lastTypingAt = now;
  scheduleAfterTypingSilence(channelId, pending);
  console.debug(`[Active Mode] Typing detected from ${userId}; waiting for typing activity to expire, then 3s silence.`);
}

async function safeReact(message: Message, emoji: string): Promise<void> { try { await message.react(emoji); } catch (error) { console.error(`[Voice STT] Failed to react with ${emoji}:`, error instanceof Error ? error.message : error); } }
async function safeRemoveReaction(message: Message, emoji: string): Promise<void> { try { await message.reactions.cache.get(emoji)?.users.remove(message.client.user!.id); } catch (error) { console.error(`[Voice STT] Failed to remove reaction ${emoji}:`, error instanceof Error ? error.message : error); } }

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot || message.system || !isAuthorized(message.author.id)) return;
  const conversationId = message.channel.id;
  const enumerationScope = `${message.author.id}:${conversationId}`;
  const defaultActive = !message.guildId;
  if (!activation.isActive(conversationId, defaultActive)) return;
  let prompt = message.content.trim();
  const isVoiceMessage = !prompt && isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage);
  const voiceAttachment = isVoiceMessage ? message.attachments.first() : undefined;
  const hasImageAttachment = [...message.attachments.values()].some(a => ['image/png','image/jpeg','image/gif','image/webp'].includes(a.contentType?.split(';')[0]?.toLowerCase() ?? ''));
  const hasGifLink = /https?:\/\/[^\s<>]*(?:tenor\.com|tenor\.co|klipy\.com|klipy\.app)[^\s<>]*/i.test(prompt);
  if (!prompt && !voiceAttachment && !hasImageAttachment && !hasGifLink) return;
  if (message.client.user) prompt = prompt.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
  if (prompt) {
    const previousMaxRequested = getEnumerationMaxRequested(enumerationScope);
    const looksPotentiallyEnumerative = previousMaxRequested > 0 || /\b(?:count|counting|enumerat|list|number|numbers|items?|add|another|more|continue|keep going|print|output|generate)\b/i.test(prompt);
    let aiRecognized = false;
    if (looksPotentiallyEnumerative) {
      const classification = await classifyEnumerationRequest(prompt, previousMaxRequested);
      if (classification?.isEnumeration && classification.confidence >= 0.75 && classification.requestedCount !== null) {
        aiRecognized = true;
        if (applyAIEnumerationClassification(enumerationScope, classification.requestedCount, classification.isContinuation)) { await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {}); return; }
      } else if (classification && !classification.isEnumeration && classification.confidence >= 0.75) aiRecognized = true;
    }
    if (!aiRecognized && isExcessiveEnumerationRequest(prompt, enumerationScope)) { await message.reply({ content: EXCESSIVE_ENUMERATION_MESSAGE }).catch(() => {}); return; }
  }
  const parentChannelId = message.channel.isThread() ? (message.channel.parentId ?? conversationId) : conversationId;
  if (isBusy(conversationId) || sessionManager.isExecutionActive(conversationId)) {
    if (voiceAttachment) {
      dataStore.addToQueue(conversationId, { prompt: '', userId: message.author.id, timestamp: Date.now(), voiceAttachmentUrl: voiceAttachment.url, voiceAttachmentSize: voiceAttachment.size });
    } else {
      const media = hasImageAttachment ? await getMediaAttachments([message]) : [];
      dataStore.addToQueue(conversationId, { prompt, userId: message.author.id, timestamp: Date.now(), media });
    }
    return;
  }
  if (voiceAttachment) {
    await safeReact(message, '🎙️');
    try { prompt = await transcribe(voiceAttachment.url, voiceAttachment.size); await safeRemoveReaction(message, '🎙️'); }
    catch (error) { console.error('[Voice STT] Transcription failed:', error instanceof Error ? error.message : error); await safeReact(message, '❌'); await message.reply({ content: error instanceof Error && error.message === 'AUTH_FAILURE' ? '❌ Transcription failed. Check the voice API key with `/voice status`.' : '❌ Voice transcription failed. Check server logs.' }).catch(() => {}); return; }
    if (!prompt.trim()) { await safeReact(message, '❌'); return; }
  }
  if (!voiceAttachment) { scheduleActiveMessage(message, prompt, parentChannelId); return; }
  const discordContext = await buildDiscordContext(message);
  const contextualPrompt = discordContext ? `${discordContext}\n\n[Current user: ${message.member?.displayName ?? message.author.globalName ?? message.author.username} (${message.author.id})]\n[Current user message]\n${prompt}` : `[Current user: ${message.member?.displayName ?? message.author.globalName ?? message.author.username} (${message.author.id})]\n[Current user message]\n${prompt}`;
  await runPrompt(message.channel, conversationId, contextualPrompt, parentChannelId, message.author.id, undefined, []);
}
