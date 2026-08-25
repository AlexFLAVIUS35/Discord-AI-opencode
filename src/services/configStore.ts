import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BotConfig {
  discordToken: string;
  clientId: string;
  guildId: string;
}

export interface PortConfig {
  min: number;
  max: number;
}

export interface AppConfig {
  bot?: BotConfig;
  ports?: PortConfig;
  allowedUserIds?: string[];
  openaiApiKey?: string;
}

const CONFIG_DIR = join(homedir(), '.remote-opencode');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const ENV_FILE = join(CONFIG_DIR, '.env');

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadEnvFile(): void {
  if (!existsSync(ENV_FILE)) return;
  try {
    const content = readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // Ignore an unreadable local env file.
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): AppConfig {
  ensureConfigDir();
  loadEnvFile();
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as AppConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function getBotConfig(): BotConfig | undefined {
  const bot = loadConfig().bot;
  const discordToken = process.env.DISCORD_TOKEN || bot?.discordToken;
  const clientId = process.env.DISCORD_CLIENT_ID || bot?.clientId;
  const guildId = process.env.DISCORD_GUILD_ID || bot?.guildId;

  if (!discordToken || !clientId || !guildId) return undefined;
  return { discordToken, clientId, guildId };
}

export function setBotConfig(bot: BotConfig): void {
  const config = loadConfig();
  config.bot = bot;
  saveConfig(config);
}

export function setBotEnvironment(bot: BotConfig): void {
  ensureConfigDir();
  const content = [
    `DISCORD_TOKEN=${JSON.stringify(bot.discordToken)}`,
    `DISCORD_CLIENT_ID=${JSON.stringify(bot.clientId)}`,
    `DISCORD_GUILD_ID=${JSON.stringify(bot.guildId)}`,
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

export function removeBotEnvironment(): void {
  if (existsSync(ENV_FILE)) unlinkSync(ENV_FILE);
}

export function getPortConfig(): PortConfig | undefined {
  return loadConfig().ports;
}

export function setPortConfig(ports: PortConfig): void {
  const config = loadConfig();
  config.ports = ports;
  saveConfig(config);
}

export function hasBotConfig(): boolean {
  return getBotConfig() !== undefined;
}

export function clearBotConfig(): void {
  const config = loadConfig();
  delete config.bot;
  saveConfig(config);
}

export function getAllowedUserIds(): string[] {
  return loadConfig().allowedUserIds ?? [];
}

export function setAllowedUserIds(ids: string[]): void {
  const config = loadConfig();
  config.allowedUserIds = ids;
  saveConfig(config);
}

export function addAllowedUserId(id: string): void {
  const config = loadConfig();
  const current = config.allowedUserIds ?? [];
  if (!current.includes(id)) {
    config.allowedUserIds = [...current, id];
    saveConfig(config);
  }
}

export function removeAllowedUserId(id: string): boolean {
  const config = loadConfig();
  const current = config.allowedUserIds ?? [];
  if (!current.includes(id)) return false;
  if (current.length <= 1) return false;
  config.allowedUserIds = current.filter(uid => uid !== id);
  saveConfig(config);
  return true;
}

export function isAuthorized(userId: string): boolean {
  const ids = getAllowedUserIds();
  if (ids.length === 0) return true;
  return ids.includes(userId);
}

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY || loadConfig().openaiApiKey;
}

export function setOpenAIApiKey(key: string): void {
  const config = loadConfig();
  config.openaiApiKey = key;
  saveConfig(config);
}

export function removeOpenAIApiKey(): void {
  const config = loadConfig();
  delete config.openaiApiKey;
  saveConfig(config);
}
