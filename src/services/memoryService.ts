import * as dataStore from './dataStore.js';
import type { MemoryEntry } from '../types/index.js';

const MAX_STORED_MEMORIES = 5000;
const MAX_MEMORY_TEXT = 4000;

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_'-]{3,}/g) ?? []).filter(w => !['the','and','that','this','with','you','are','was','for','but','not','have','has','from'].includes(w)));
}

export function remember(conversationId: string, userId: string, role: MemoryEntry['role'], text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const data = (dataStore as any).__loadRaw?.();
  // Use the public datastore extension when available; otherwise memory persistence is handled below.
  addMemory(conversationId, userId, role, clean.slice(0, MAX_MEMORY_TEXT));
}

function addMemory(conversationId: string, userId: string, role: MemoryEntry['role'], text: string): void {
  const existing = getAll();
  existing.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, conversationId, userId, role, text, createdAt: Date.now() });
  while (existing.length > MAX_STORED_MEMORIES) existing.shift();
  dataStore.setMemories(existing);
}

function getAll(): MemoryEntry[] { return dataStore.getMemories(); }

export function buildMemoryContext(conversationId: string, userId: string, query: string, limit = 12): string {
  const all = getAll().filter(m => m.conversationId === conversationId || m.userId === userId);
  if (!all.length) return '';
  const q = tokens(query);
  const ranked = all.map(m => {
    const mt = tokens(m.text);
    let score = m.conversationId === conversationId ? 3 : 0;
    for (const word of q) if (mt.has(word)) score += 2;
    score += Math.min(1, (Date.now() - m.createdAt) < 86400000 ? 1 : 0);
    return { m, score };
  }).sort((a,b) => b.score - a.score || b.m.createdAt - a.m.createdAt).slice(0, limit).sort((a,b) => a.m.createdAt - b.m.createdAt);
  return ranked.length ? `\n\n[Long-term memory — retrieved relevant history]\n${ranked.map(({m}) => `[${m.role}] ${m.text}`).join('\n')}\n[End long-term memory]` : '';
}
