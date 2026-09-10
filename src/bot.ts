import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import pc from 'picocolors';
import { getBotTokens } from './services/configStore.js';
import { handleInteraction } from './handlers/interactionHandler.js';
import { handleMessageCreate, handleTypingStart } from './handlers/messageHandler.js';
import * as serveManager from './services/serveManager.js';
import { initializeProxySupport } from './services/proxySupport.js';
import { getCachedModels } from './commands/model.js';
import { deployCommandsForClient } from './setup/deploy.js';

const clientOptions = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent,
  ],
  // DM channels are not guaranteed to be cached. Without the Channel
  // partial, discord.js can fail to construct the DM message/channel object
  // needed by MessageCreate, which breaks automatic DM active mode.
  partials: [Partials.Channel],
};

export async function startBot(): Promise<void> {
  const tokens = getBotTokens();

  if (tokens.length === 0) {
    throw new Error('No bot tokens found. Configure BOT_1TOKEN, BOT_2TOKEN, etc.');
  }

  const clients: Client[] = [];
  let shuttingDown = false;

  function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(pc.yellow(`\n${signal} received. Shutting down ${clients.length} Discord bot(s) gracefully...`));
    serveManager.stopAll();
    console.log(pc.dim('All opencode serve instances stopped.'));
    for (const client of clients) client.destroy();
    console.log(pc.dim('All Discord clients destroyed.'));
    process.exit(0);
  }

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

  initializeProxySupport();

  const startOne = async (token: string, index: number): Promise<void> => {
    const client = new Client(clientOptions);
    clients.push(client);

    client.once(Events.ClientReady, async (c) => {
      console.log(pc.green(`Bot ${index + 1}: Ready! Logged in as ${pc.bold(c.user.tag)}`));
      try { getCachedModels(); } catch { }

      try {
        await deployCommandsForClient(c);
      } catch (error) {
        console.error(pc.red(`Bot ${index + 1}: Failed to deploy slash commands:`), error);
      }
    });

    client.on(Events.InteractionCreate, handleInteraction);
    client.on(Events.MessageCreate, handleMessageCreate);
    client.on(Events.TypingStart, (typing) => {
      if (typing.user.bot) return;
      handleTypingStart(typing.channel.id, typing.user.id);
    });
    client.on(Events.Error, (error) => {
      console.error(pc.red(`Bot ${index + 1}: Discord client error:`), error);
    });

    console.log(pc.dim(`Connecting bot ${index + 1}...`));
    try {
      await client.login(token);
    } catch (error) {
      console.error(pc.red(`Bot ${index + 1}: Discord login failed:`), error);
      client.destroy();
    }
  };

  await Promise.all(tokens.map((token, index) => startOne(token, index)));
}
