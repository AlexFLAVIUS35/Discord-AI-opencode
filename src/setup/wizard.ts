import * as p from '@clack/prompts';
import pc from 'picocolors';
import open from 'open';
import { setBotConfig, setBotEnvironment, getBotConfig, hasBotConfig, addAllowedUserId, setOpenAIApiKey } from '../services/configStore.js';
import { deployCommands } from './deploy.js';

const DISCORD_DEV_URL = 'https://discord.com/developers/applications';
const BOT_PERMISSIONS = '2147534848';
const BOT_SCOPES = 'bot applications.commands';

function validateApplicationId(value: string): string | undefined {
  if (!value) return 'Application ID is required';
  if (!/^\d{17,20}$/.test(value)) return 'Invalid format (should be 17-20 digits)';
  return undefined;
}

function validateToken(value: string): string | undefined {
  if (!value) return 'Bot token is required';
  if (value.length < 50) return 'Invalid token format (too short)';
  return undefined;
}

function validateGuildId(value: string): string | undefined {
  if (!value) return 'Guild ID is required';
  if (!/^\d{17,20}$/.test(value)) return 'Invalid format (should be 17-20 digits)';
  return undefined;
}

function validateUserId(value: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{17,20}$/.test(value)) return 'Invalid format (should be 17-20 digits)';
  return undefined;
}

function generateInviteUrl(clientId: string): string {
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('permissions', BOT_PERMISSIONS);
  url.searchParams.set('scope', BOT_SCOPES);
  return url.toString();
}

// ... existing setup flow remains unchanged until the configuration-save step ...
