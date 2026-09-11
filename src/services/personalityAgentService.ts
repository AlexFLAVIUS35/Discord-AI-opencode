import * as dataStore from './dataStore.js';
import * as guildPersonality from './guildPersonalityStore.js';

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function agentId(botId: string, scope: 'user' | 'guild', scopeId: string): string {
  return `discord/${safePart(botId)}/${scope}-${safePart(scopeId)}`;
}

function agentPath(botId: string, scope: 'user' | 'guild', scopeId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return `${home}/.config/opencode/agents/${agentId(botId, scope, scopeId)}.md`;
}

function escapeFrontmatter(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

async function writeAgent(botId: string, scope: 'user' | 'guild', scopeId: string, personality: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = agentPath(botId, scope, scopeId);
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(path, `---\ndescription: "${escapeFrontmatter(`${scope} Discord personality`)}"\nmode: all\nhidden: true\n---\n\n${personality.trim()}\n`, 'utf8');
  return agentId(botId, scope, scopeId);
}

export async function syncEffectiveAgent(botId: string, userId?: string, guildId?: string): Promise<string | undefined> {
  if (guildId) {
    const serverPersonality = guildPersonality.getPersonality(botId, guildId);
    if (serverPersonality) return writeAgent(botId, 'guild', guildId, serverPersonality);
  }
  if (userId) {
    const personalPersonality = dataStore.getUserPersonality(botId, userId);
    if (personalPersonality) return writeAgent(botId, 'user', userId, personalPersonality);
  }
  return undefined;
}

export async function removeAgent(botId: string, scope: 'user' | 'guild', scopeId: string): Promise<void> {
  const fs = await import('node:fs/promises');
  try { await fs.unlink(agentPath(botId, scope, scopeId)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}
