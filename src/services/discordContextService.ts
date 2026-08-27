import type { Message, TextBasedChannel } from 'discord.js';

const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 1200;

function describeReactions(message: Message): string {
  const reactions = [...message.reactions.cache.values()]
    .filter(reaction => reaction.count > 0)
    .map(reaction => `${reaction.emoji.name ?? reaction.emoji.toString()} ×${reaction.count}`);
  return reactions.length ? ` | Reactions: ${reactions.join(', ')}` : '';
}

export async function buildDiscordContext(message: Message): Promise<string> {
  try {
    const messages = await (message.channel as TextBasedChannel & { messages?: any }).messages?.fetch({ limit: MAX_MESSAGES });
    if (!messages) return '';

    const ordered = [...messages.values()].sort((a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp);
    const lines: string[] = [];

    for (const item of ordered) {
      const author = item.author?.bot ? `${item.author.username} (BOT)` : item.member?.displayName ?? item.author?.globalName ?? item.author?.username ?? 'Unknown user';
      const content = item.content?.trim() || (item.attachments?.size ? '[attachment]' : '[empty message]');
      const safeContent = content.slice(0, MAX_MESSAGE_CHARS);
      let replyInfo = '';

      if (item.reference?.messageId) {
        try {
          const referenced = messages.get(item.reference.messageId) ?? await item.fetchReference();
          const referencedAuthor = referenced.author?.bot ? `${referenced.author.username} (BOT)` : referenced.member?.displayName ?? referenced.author?.globalName ?? referenced.author?.username ?? 'Unknown user';
          const referencedText = (referenced.content || '[empty message]').slice(0, 300);
          replyInfo = ` | Replying to ${referencedAuthor}: "${referencedText}"`;
        } catch {
          replyInfo = ` | Replying to message ${item.reference.messageId}`;
        }
      }

      lines.push(`[${item.id}] ${author}: ${safeContent}${replyInfo}${describeReactions(item)}`);
    }

    return lines.length
      ? `[Discord channel context — messages are from DIFFERENT PEOPLE; do not assume they are all the current user. Treat each author name as a separate person. Replies and reactions belong to the specific message shown. Only respond as Leeha to the current user's latest message.\n${lines.join('\n')}]`
      : '';
  } catch (error) {
    console.error('[Discord Context] Failed to build channel context:', error instanceof Error ? error.message : error);
    return '';
  }
}
