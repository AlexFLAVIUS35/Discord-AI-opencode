import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const STATE_FILE = join(CONFIG_DIR, 'activation.json');

type ActivationMap = Record<string, boolean>;

function load(): ActivationMap {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ActivationMap;
  } catch {
    return {};
  }
}

function save(data: ActivationMap): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function isActive(channelOrThreadId: string): boolean {
  return load()[channelOrThreadId] === true;
}

export function activate(channelOrThreadId: string): void {
  const data = load();
  data[channelOrThreadId] = true;
  save(data);
}

export function deactivate(channelOrThreadId: string): void {
  const data = load();
  delete data[channelOrThreadId];
  save(data);
}
