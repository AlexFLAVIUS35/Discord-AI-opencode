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
const DISCORD_FETCH_TIMEOUT_MS = 12_000;
const DISCORD_FETCH_ATTEMPTS = 4;

const recentTypingAt = new Map<string, number>();

type PendingActiveMessage = { message: Message; prompt: string; userId: string; parentChannelId: string };
type PendingActiveTurn = { channel: TextBasedChannel; messages: PendingActiveMessage[]; timer: NodeJS.Timeout; lastTypingAt: number };
const pendingActiveTurns = new Map<string, PendingActiveTurn>();

function isSupportedImageMime(mime: string | null | undefined): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes((mime ?? '').split(';')[0].toLowerCase());
}

function discordCdnCandidates(value: string): string[] {
  try {
    const original = new URL(value);
    if (original.protocol !== 'http:' && original.protocol !== 'https:') return [];
    const candidates = [original.href];
    const host = original.hostname.toLowerCase();
    if (host === 'cdn.discordapp.com') {
      const proxy = new URL(original.href);
      proxy.hostname = 'media.discordapp.net';
      candidates.push(proxy.href);
    } else if (host === 'media.discordapp.net') {
      const cdn = new URL(original.href);
      cdn.hostname = 'cdn.discordapp.com';
      candidates.push(cdn.href);
    }
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

async function fetchDiscordAttachment(url: string): Promise<{ response: Response; bytes: Uint8Array } | null> {
  const candidates = discordCdnCandidates(url);
  if (!candidates.length) return null;
  let lastStatus = '';
  for (let attempt = 0; attempt < DISCORD_FETCH_ATTEMPTS; attempt++) {
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Leeha/1.0',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            Referer: 'https://discord.com/',
            Origin: 'https://discord.com',
            'Cache-Control': 'no-cache',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          lastStatus = `${response.status} ${response.statusText}`;
          continue;
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > MAX_MEDIA_BYTES) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
        return { response, bytes };
      } catch (error) {
        lastStatus = error instanceof Error ? error.message : String(error);
      }
    }
    if (attempt + 1 < DISCORD_FETCH_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 350 * 2 ** attempt));
  }
  console.error(`[Media] Discord CDN fetch exhausted for ${url} (${lastStatus || 'unknown error'})`);
  return null;
}

async function downloadDiscordAttachment(attachment: { url: string; name: string; contentType?: string | null }): Promise<RunPromptMedia | null> {
  const declaredMime = attachment.contentType?.split(';')[0]?.toLowerCase();
  if (!declaredMime || !isSupportedImageMime(declaredMime)) return null;
  try {
    const fetched = await fetchDiscordAttachment(attachment.url);
    if (!fetched) return { url: attachment.url, name: attachment.name, mime: declaredMime };
    const responseMime = fetched.response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
    const mime = isSupportedImageMime(responseMime) ? responseMime! : sniffImageMime(fetched.bytes) ?? declaredMime;
    return { url: `data:${mime};base64,${Buffer.from(fetched.bytes).toString('base64')}`, name: attachment.name, mime };
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
    if (!mime || !isSupportedImageMime(mime) || seen.has(attachment.url)) continue;
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
  const hasImageAttachment = [...message.attachments.values()].some(a => isSupportedImageMime(a.contentType?.split(';')[0]?.toLowerCase()));
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
