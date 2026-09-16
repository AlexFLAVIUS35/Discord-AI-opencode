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
  return `discord-${safePart(botId)}-${scope}-${safePart(scopeId)}`;
}

function globalAgentPath(botId: string, scope: Scope, scopeId: string): string {
  return path.join(os.homedir(), '.config', 'opencode', 'agents', `${agentId(botId, scope, scopeId)}.md`);
}

function workspaceAgentPath(workspacePath: string, botId: string, scope: Scope, scopeId: string): string {
  return path.join(workspacePath, '.opencode', 'agents', `${agentId(botId, scope, scopeId)}.md`);
}

function escapeFrontmatter(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

async function writeAgent(filePath: string, scope: Scope, personality: string): Promise<void> {
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
}

export async function syncEffectiveAgent(botId: string, userId?: string, guildId?: string, workspacePath?: string): Promise<string | undefined> {
  const write = async (scope: Scope, scopeId: string, personality: string): Promise<string> => {
    // Write into the active OpenCode workspace as well as the global agent
    // directory. OpenCode reliably discovers project agents for the workspace
    // it is serving, which avoids environment-specific HOME/XDG discovery issues.
    await writeAgent(globalAgentPath(botId, scope, scopeId), scope, personality);
    if (workspacePath) await writeAgent(workspaceAgentPath(workspacePath, botId, scope, scopeId), scope, personality);
    return agentId(botId, scope, scopeId);
  };

  if (guildId) {
    const serverPersonality = guildPersonality.getPersonality(botId, guildId);
    if (serverPersonality) return write('guild', guildId, serverPersonality);
  }
  if (userId) {
    const personalPersonality = dataStore.getUserPersonality(botId, userId);
    if (personalPersonality) return write('user', userId, personalPersonality);
  }
  return undefined;
}

export async function removeAgent(botId: string, scope: Scope, scopeId: string): Promise<void> {
  try {
    await fs.unlink(globalAgentPath(botId, scope, scopeId));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
