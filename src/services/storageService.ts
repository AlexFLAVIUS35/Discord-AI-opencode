import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface StorageState {
  enabled: boolean;
  path?: string;
}

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const STATE_FILE = join(CONFIG_DIR, 'storage.json');

function load(): Record<string, StorageState> {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, StorageState>;
  } catch {
    return {};
  }
}

function save(data: Record<string, StorageState>): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function getDefaultPath(): string {
  const configured = process.env.OPENCODE_STORAGE_PATH?.trim();
  if (!configured) throw new Error('OPENCODE_STORAGE_PATH is not configured. Set it before using /storage activate.');
  return resolve(configured);
}

export function activate(threadId: string, path?: string): string {
  const target = resolve(path?.trim() || getDefaultPath());
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  const data = load();
  data[threadId] = { enabled: true, path: target };
  save(data);
  return target;
}

export function deactivate(threadId: string): void {
  const data = load();
  delete data[threadId];
  save(data);
}

export function isEnabled(threadId: string): boolean {
  return load()[threadId]?.enabled === true;
}

export function getPath(threadId: string): string | undefined {
  const state = load()[threadId];
  return state?.enabled ? state.path : undefined;
}

export function getStatus(threadId: string): StorageState {
  return load()[threadId] ?? { enabled: false };
}
