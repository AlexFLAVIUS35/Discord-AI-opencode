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
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GuildPersonalityMap; } catch { return {}; }
}
function save(data: GuildPersonalityMap): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function key(botId:string,guildId:string):string{return `${botId}:${guildId}`;}
export function get(botId:string,guildId:string):GuildPersonality|undefined{return load()[key(botId,guildId)];}
export function isEnabled(botId:string,guildId:string):boolean{return get(botId,guildId)?.enabled===true;}
export function getPersonality(botId:string,guildId:string):string|undefined{const value=get(botId,guildId);return value?.enabled?value.personality?.trim()||undefined:undefined;}
export function set(botId:string,guildId:string,personality:string):void{const data=load();data[key(botId,guildId)]={enabled:true,personality:personality.trim(),updatedAt:Date.now()};save(data);}
export function enable(botId:string,guildId:string):boolean{const data=load();const k=key(botId,guildId);const existing=data[k];if(!existing?.personality?.trim())return false;data[k]={...existing,enabled:true,updatedAt:Date.now()};save(data);return true;}
export function disable(botId:string,guildId:string):void{const data=load();const k=key(botId,guildId);const existing=data[k];data[k]={...(existing??{}),enabled:false,updatedAt:Date.now()};save(data);}
export function reset(botId:string,guildId:string):void{const data=load();delete data[key(botId,guildId)];save(data);}
