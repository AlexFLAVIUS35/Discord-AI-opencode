import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DataStore, ProjectConfig, ChannelBinding, ThreadSession, WorktreeMapping, PassthroughThread, QueuedMessage, QueueSettings, UserPersonality } from '../types/index.js';
import { sanitizeModel } from '../utils/stringUtils.js';

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const DATA_FILE = join(CONFIG_DIR, 'data.json');

function ensureDataDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadData(): DataStore {
  ensureDataDir();
  if (!existsSync(DATA_FILE)) return { projects: [], bindings: [] };
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf-8')) as DataStore; }
  catch { return { projects: [], bindings: [] }; }
}

function saveData(data: DataStore): void {
  ensureDataDir();
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function setUserPersonality(userId: string, personality: string): void {
  const data = loadData();
  if (!data.userPersonalities) data.userPersonalities = [];
  const existing = data.userPersonalities.findIndex(p => p.userId === userId);
  const value: UserPersonality = { userId, personality, updatedAt: Date.now() };
  if (existing >= 0) data.userPersonalities[existing] = value;
  else data.userPersonalities.push(value);
  saveData(data);
}

export function getUserPersonality(userId: string): string | undefined {
  return loadData().userPersonalities?.find(p => p.userId === userId)?.personality;
}

export function removeUserPersonality(userId: string): boolean {
  const data = loadData();
  if (!data.userPersonalities) return false;
  const idx = data.userPersonalities.findIndex(p => p.userId === userId);
  if (idx < 0) return false;
  data.userPersonalities.splice(idx, 1);
  saveData(data);
  return true;
}

export function addProject(alias: string, path: string): void {
  const data = loadData();
  const existing = data.projects.findIndex(p => p.alias === alias);
  if (existing >= 0) data.projects[existing].path = path;
  else data.projects.push({ alias, path });
  saveData(data);
}
export function getProjects(): ProjectConfig[] { return loadData().projects; }
export function getProject(alias: string): ProjectConfig | undefined { return loadData().projects.find(p => p.alias === alias); }
export function removeProject(alias: string): boolean {
  const data = loadData(); const idx = data.projects.findIndex(p => p.alias === alias);
  if (idx < 0) return false;
  data.projects.splice(idx, 1); data.bindings = data.bindings.filter(b => b.projectAlias !== alias); saveData(data); return true;
}
export function setChannelBinding(channelId: string, projectAlias: string, model?: string): void {
  const data = loadData(); const existing = data.bindings.findIndex(b => b.channelId === channelId);
  if (existing >= 0) { data.bindings[existing].projectAlias = projectAlias; if (model !== undefined) data.bindings[existing].model = model; }
  else data.bindings.push({ channelId, projectAlias, model });
  saveData(data);
}
export function setChannelModel(channelId: string, model: string): boolean {
  const data = loadData();
  const cleanModel = sanitizeModel(model);
  const existing = data.bindings.findIndex(b => b.channelId === channelId);
  if (existing >= 0) {
    data.bindings[existing].model = cleanModel;
    saveData(data);
    return true;
  }
  if (!data.channelModels) data.channelModels = {};
  data.channelModels[channelId] = cleanModel;
  saveData(data);
  return true;
}
export function getChannelModel(channelId: string): string | undefined {
  const data = loadData();
  return sanitizeModel(data.bindings.find(b => b.channelId === channelId)?.model ?? data.channelModels?.[channelId] ?? '');
}
export function getChannelBinding(channelId: string): string | undefined { return loadData().bindings.find(b => b.channelId === channelId)?.projectAlias; }
export function getChannelProjectPath(channelId: string): string | undefined { const alias = getChannelBinding(channelId); return alias ? getProject(alias)?.path : undefined; }

export function getThreadSession(threadId: string): ThreadSession | undefined { return loadData().threadSessions?.find(s => s.threadId === threadId); }
export function setThreadSession(session: ThreadSession): void { const data = loadData(); if (!data.threadSessions) data.threadSessions = []; const i = data.threadSessions.findIndex(s => s.threadId === session.threadId); if (i >= 0) data.threadSessions[i] = session; else data.threadSessions.push(session); saveData(data); }
export function updateThreadSessionLastUsed(threadId: string): void { const data = loadData(); const s = data.threadSessions?.find(s => s.threadId === threadId); if (s) { s.lastUsedAt = Date.now(); saveData(data); } }
export function clearThreadSession(threadId: string): void { const data = loadData(); if (data.threadSessions) { data.threadSessions = data.threadSessions.filter(s => s.threadId !== threadId); saveData(data); } }
export function getAllThreadSessions(): ThreadSession[] { return loadData().threadSessions ?? []; }

export function setWorktreeMapping(mapping: WorktreeMapping): void { const data = loadData(); if (!data.worktreeMappings) data.worktreeMappings = []; const i = data.worktreeMappings.findIndex(m => m.threadId === mapping.threadId); if (i >= 0) data.worktreeMappings[i] = mapping; else data.worktreeMappings.push(mapping); saveData(data); }
export function getWorktreeMapping(threadId: string): WorktreeMapping | undefined { return loadData().worktreeMappings?.find(m => m.threadId === threadId); }
export function getWorktreeMappingByBranch(projectPath: string, branchName: string): WorktreeMapping | undefined { return loadData().worktreeMappings?.find(m => m.projectPath === projectPath && m.branchName === branchName); }
export function removeWorktreeMapping(threadId: string): boolean { const data = loadData(); if (!data.worktreeMappings) return false; const i = data.worktreeMappings.findIndex(m => m.threadId === threadId); if (i < 0) return false; data.worktreeMappings.splice(i, 1); saveData(data); return true; }
export function getAllWorktreeMappings(): WorktreeMapping[] { return loadData().worktreeMappings ?? []; }
export function getWorktreeMappingsByProject(projectPath: string): WorktreeMapping[] { return loadData().worktreeMappings?.filter(m => m.projectPath === projectPath) ?? []; }

export function setPassthroughMode(threadId: string, enabled: boolean, userId: string): void { const data = loadData(); if (!data.passthroughThreads) data.passthroughThreads = []; const value = { threadId, enabled, enabledBy: userId, enabledAt: Date.now() }; const i = data.passthroughThreads.findIndex(p => p.threadId === threadId); if (i >= 0) data.passthroughThreads[i] = value; else data.passthroughThreads.push(value); saveData(data); }
export function getPassthroughMode(threadId: string): PassthroughThread | undefined { return loadData().passthroughThreads?.find(p => p.threadId === threadId); }
export function isPassthroughEnabled(threadId: string): boolean { return getPassthroughMode(threadId)?.enabled ?? false; }
export function removePassthroughMode(threadId: string): boolean { const data = loadData(); if (!data.passthroughThreads) return false; const i = data.passthroughThreads.findIndex(p => p.threadId === threadId); if (i < 0) return false; data.passthroughThreads.splice(i, 1); saveData(data); return true; }
export function setProjectAutoWorktree(alias: string, enabled: boolean): boolean { const data = loadData(); const p = data.projects.find(p => p.alias === alias); if (!p) return false; p.autoWorktree = enabled; saveData(data); return true; }
export function getProjectAutoWorktree(alias: string): boolean { return getProject(alias)?.autoWorktree ?? false; }
export function setProjectAutoPassthrough(alias: string, enabled: boolean): boolean { const data = loadData(); const p = data.projects.find(p => p.alias === alias); if (!p) return false; p.autoPassthrough = enabled; saveData(data); return true; }
export function getProjectAutoPassthrough(alias: string): boolean { return getProject(alias)?.autoPassthrough ?? false; }

export function getQueue(threadId: string): QueuedMessage[] { return loadData().queues?.[threadId] ?? []; }
export function addToQueue(threadId: string, message: QueuedMessage): void { const data = loadData(); if (!data.queues) data.queues = {}; if (!data.queues[threadId]) data.queues[threadId] = []; data.queues[threadId].push(message); saveData(data); }
export function popFromQueue(threadId: string): QueuedMessage | undefined { const data = loadData(); if (!data.queues?.[threadId]?.length) return undefined; const message = data.queues[threadId].shift(); saveData(data); return message; }
export function clearQueue(threadId: string): void { const data = loadData(); if (data.queues?.[threadId]) { delete data.queues[threadId]; saveData(data); } }
export function getQueueSettings(threadId: string): QueueSettings { return loadData().queueSettings?.[threadId] ?? { paused: false, continueOnFailure: false, freshContext: false }; }
export function updateQueueSettings(threadId: string, settings: Partial<QueueSettings>): void { const data = loadData(); if (!data.queueSettings) data.queueSettings = {}; data.queueSettings[threadId] = { ...getQueueSettings(threadId), ...settings }; saveData(data); }
