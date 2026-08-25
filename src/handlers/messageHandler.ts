import { Message, MessageFlags, ThreadChannel } from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';
import { isAuthorized } from '../services/configStore.js';
import { transcribe, isVoiceEnabled } from '../services/voiceService.js';

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

  const channel = message.channel;
  const mentioned = message.client.user ? message.mentions.users.has(message.client.user.id) : false;
  const mentionOnly = (process.env.DISCORD_MENTION_ONLY ?? 'true').toLowerCase() === 'true';

  // DMs always work. In servers, mention the bot unless DISCORD_MENTION_ONLY=false.
  if (message.guild && mentionOnly && !mentioned) return;

  let prompt = message.content.trim();
  if (mentioned && message.client.user) {
    prompt = prompt.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
  }

  const isVoiceMessage = !prompt && isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage);
  const voiceAttachment = isVoiceMessage ? message.attachments.first() : undefined;
  if (!prompt && !voiceAttachment) return;

  const conversationId = channel.id;
  const parentChannelId = channel.isThread() ? ((channel as ThreadChannel).parentId ?? channel.id) : channel.id;

  if (isBusy(conversationId)) {
    if (voiceAttachment) {
      dataStore.addToQueue(conversationId, {
        prompt: '', userId: message.author.id, timestamp: Date.now(),
        voiceAttachmentUrl: voiceAttachment.url, voiceAttachmentSize: voiceAttachment.size,
      });
    } else {
      dataStore.addToQueue(conversationId, { prompt, userId: message.author.id, timestamp: Date.now() });
    }
    await safeReact(message, '📥');
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
      await message.reply({ content: error instanceof Error && error.message === 'AUTH_FAILURE'
        ? '❌ Transcription failed. Check the voice API key with `/voice status`.'
        : '❌ Voice transcription failed. Check server logs.' }).catch(() => {});
      return;
    }
    if (!prompt.trim()) { await safeReact(message, '❌'); return; }
  }

  await runPrompt(channel, conversationId, prompt, parentChannelId);
}
