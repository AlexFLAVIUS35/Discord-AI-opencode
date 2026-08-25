import { TextBasedChannel } from 'discord.js';
import * as dataStore from './dataStore.js';
import { runPrompt } from './executionService.js';
import * as sessionManager from './sessionManager.js';
import { transcribe } from './voiceService.js';

export async function processNextInQueue(channel: TextBasedChannel, threadId: string, parentChannelId: string): Promise<void> {
  const settings = dataStore.getQueueSettings(threadId);
  if (settings.paused) return;
  const next = dataStore.popFromQueue(threadId);
  if (!next) return;
  let prompt = next.prompt;

  if (!prompt && next.voiceAttachmentUrl) {
    try {
      prompt = await transcribe(next.voiceAttachmentUrl, next.voiceAttachmentSize);
      if (!prompt.trim()) { await processNextInQueue(channel, threadId, parentChannelId); return; }
    } catch (error) {
      console.error('[Voice STT] Queued voice transcription failed:', error instanceof Error ? error.message : error);
      await processNextInQueue(channel, threadId, parentChannelId);
      return;
    }
  }
  if (!prompt) return;
  if ('send' in channel) await (channel as any).send('🔄 **Queue**: Starting next task...');
  await runPrompt(channel, threadId, prompt, parentChannelId, next.userId);
}

export function isBusy(threadId: string): boolean {
  const sseClient = sessionManager.getSseClient(threadId);
  return !!(sseClient && sseClient.isConnected());
}
