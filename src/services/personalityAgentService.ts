import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as dataStore from './dataStore.js';
import * as guildPersonality from './guildPersonalityStore.js';

type Scope = 'user' | 'guild';

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function agentId(botId: string, scope: Scope, scopeId: string): string {
  return `discord/${safePart(botId)}/${scope}-${safePart(scopeId)}`;
}

function agentPath(botId: string, scope: Scope, scopeId: string): string {
  return path.join(os.homedir(), '.config', 'opencode', 'agents', ...agentId(botId, scope, scopeId).split('/')) + '.md';
}

function escapeFrontmatter(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

async function writeAgent(botId: string, scope: Scope, scopeId: string, personality: string): Promise<string> {
  const filePath = agentPath(botId, scope, scopeId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = [
    '---',
    `description: "${escapeFrontmatter(`${scope} Discord personality`)}"`,
    'mode: all',
    'hidden: true',
    '---',
    '',
    personality.trim(),
    '',
  ].join('\n');
  await fs.writeFile(filePath, content, 'utf8');
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

export async function removeAgent(botId: string, scope: Scope, scopeId: string): Promise<void> {
  try {
    await fs.unlink(agentPath(botId, scope, scopeId));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
