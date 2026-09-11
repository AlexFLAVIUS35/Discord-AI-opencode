import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as dataStore from './dataStore.js';
import * as guildPersonality from './guildPersonalityStore.js';

const AGENTS_DIR = join(homedir(), '.config', 'opencode', 'agents', 'discord');

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function agentId(botId: string, scope: 'user' | 'guild', scopeId: string): string {
  return `discord/${safeSegment(botId)}/${scope}-${safeSegment(scopeId)}`;
}

function agentPath(botId: string, scope: 'user' | 'guild', scopeId: string): string {
  return join(AGENTS_DIR, safeSegment(botId), `${scope}-${safeSegment(scopeId)}.md`);
}

function writeAgent(path: string, personality: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const content = [
    '---',
    'description: Discord personality',
    'mode: all',
    'hidden: true',
    '---',
    '',
    '# Personality',
    '',
    personality.trim(),
    '',
  ].join('\n');
  writeFileSync(path, content, 'utf8');
}

function removeAgent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

export function syncPersonalityAgent(botId: string, guildId?: string, userId?: string): string | undefined {
  const serverPersonality = guildId ? guildPersonality.getPersonality(botId, guildId) : undefined;
  const personalPersonality = userId ? dataStore.getUserPersonality(botId, userId) : undefined;

  if (serverPersonality && guildId) {
    const id = agentId(botId, 'guild', guildId);
    writeAgent(agentPath(botId, 'guild', guildId), serverPersonality);
    if (userId) removeAgent(agentPath(botId, 'user', userId));
    return id;
  }

  if (personalPersonality && userId) {
    const id = agentId(botId, 'user', userId);
    writeAgent(agentPath(botId, 'user', userId), personalPersonality);
    if (guildId) removeAgent(agentPath(botId, 'guild', guildId));
    return id;
  }

  if (guildId) removeAgent(agentPath(botId, 'guild', guildId));
  if (userId) removeAgent(agentPath(botId, 'user', userId));
  return undefined;
}
