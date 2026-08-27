import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const STATE_FILE = join(CONFIG_DIR, 'guild-personalities.json');

export interface GuildPersonality {
  enabled: boolean;
  personality?: string;
  updatedAt: number;
}

type GuildPersonalityMap = Record<string, GuildPersonality>;

function load(): GuildPersonalityMap {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GuildPersonalityMap;
  } catch {
    return {};
  }
}

function save(data: GuildPersonalityMap): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function get(guildId: string): GuildPersonality | undefined {
  return load()[guildId];
}

export function isEnabled(guildId: string): boolean {
  return get(guildId)?.enabled === true;
}

export function getPersonality(guildId: string): string | undefined {
  const value = get(guildId);
  return value?.enabled ? value.personality?.trim() || undefined : undefined;
}

export function set(guildId: string, personality: string): void {
  const data = load();
  data[guildId] = { enabled: true, personality: personality.trim(), updatedAt: Date.now() };
  save(data);
}

export function enable(guildId: string): boolean {
  const data = load();
  const existing = data[guildId];
  if (!existing?.personality?.trim()) return false;
  data[guildId] = { ...existing, enabled: true, updatedAt: Date.now() };
  save(data);
  return true;
}

export function disable(guildId: string): void {
  const data = load();
  const existing = data[guildId];
  data[guildId] = { ...(existing ?? {}), enabled: false, updatedAt: Date.now() };
  save(data);
}

export function reset(guildId: string): void {
  const data = load();
  delete data[guildId];
  save(data);
}
