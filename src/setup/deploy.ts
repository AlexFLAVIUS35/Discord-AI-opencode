import { Client, Events, REST, Routes } from 'discord.js';
import { getBotTokens } from '../services/configStore.js';
import { commands } from '../commands/index.js';
import { initializeProxySupport } from '../services/proxySupport.js';
import pc from 'picocolors';

const intents: never[] = [];

export async function deployCommandsForClient(client: Client<true>): Promise<void> {
  const applicationId = client.application?.id;
  const token = client.token;
  if (!applicationId || !token) {
    throw new Error('Discord client is not ready for command deployment.');
  }

  const commandsData = Array.from(commands.values()).map(c => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);
  initializeProxySupport();

  await rest.put(Routes.applicationCommands(applicationId), { body: commandsData });
  console.log(pc.green(`Successfully deployed ${commandsData.length} global slash commands for ${client.user.tag}.`));
}

export async function deployCommands(): Promise<void> {
  const tokens = getBotTokens();
  if (tokens.length === 0) {
    throw new Error('No bot tokens found. Configure BOT_1TOKEN, BOT_2TOKEN, etc.');
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const client = new Client({ intents });

    try {
      console.log(pc.dim(`Connecting bot ${index + 1} for command deployment...`));
      await client.login(token);
      await new Promise<void>((resolve, reject) => {
        if (client.isReady()) {
          resolve();
          return;
        }
        client.once(Events.ClientReady, () => resolve());
        client.once(Events.Error, reject);
      });
      await deployCommandsForClient(client);
    } finally {
      client.destroy();
    }
  }
}
