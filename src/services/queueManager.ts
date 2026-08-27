import { TextBasedChannel } from 'discord.js';
import * as dataStore from './dataStore.js';
import { runPrompt } from './executionService.js';
import * as sessionManager from './sessionManager.js';
import { transcribe } from './voiceService.js';
import { isExcessiveEnumerationRequest, EXCESSIVE_ENUMERATION_MESSAGE } from '../utils/requestGuard.js';

export async function processNextInQueue(channel: TextBasedChannel, threadId: string, parentChannelId: string): Promise<void> {
  const settings = dataStore.getQueueSettings(threadId);
  if (settings.paused) return;

  // Coalesce a burst of messages into ONE AI turn instead of making Leeha
  // answer every message separately. This prevents active-channel meltdowns.
  const first = dataStore.popFromQueue(threadId);
  if (!first) return;
  const pending = [first, ...dataStore.getQueue(threadId)];
  dataStore.clearQueue(threadId);

  const parts: string[] = [];
  for (const next of pending) {
    let prompt = next.prompt;

    if (!prompt && next.voiceAttachmentUrl) {
      try {
        prompt = await transcribe(next.voiceAttachmentUrl, next.voiceAttachmentSize);
        if (!prompt.trim()) continue;
      } catch (error) {
        console.error('[Voice STT] Queued voice transcription failed:', error instanceof Error ? error.message : error);
        continue;
      }
    }
    if (!prompt) continue;

    if (isExcessiveEnumerationRequest(prompt)) {
      try { await (channel as any).send(EXCESSIVE_ENUMERATION_MESSAGE); } catch { }
      continue;
    }

    parts.push(`[${next.userId}] ${prompt}`);
  }

  if (!parts.length) return;

  const combinedPrompt = `[Queued Discord messages from different users — treat each user ID as a separate person. Respond to the conversation naturally rather than producing a separate response for every message.\n${parts.join('\n')}]`;
  await runPrompt(channel, threadId, combinedPrompt, parentChannelId, first.userId);
}

export function isBusy(threadId: string): boolean {
  const sseClient = sessionManager.getSseClient(threadId);
  return !!(sseClient && sseClient.isConnected());
}
