type PersonalitySplitSession = {
  guildId: string;
  userId: string;
  parts: string[];
  createdAt: number;
};

const sessions = new Map<string, PersonalitySplitSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function getValidSession(guildId: string, userId: string): PersonalitySplitSession | undefined {
  const session = sessions.get(key(guildId, userId));
  if (!session) return undefined;

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(key(guildId, userId));
    return undefined;
  }

  return session;
}

export function start(guildId: string, userId: string): void {
  sessions.set(key(guildId, userId), {
    guildId,
    userId,
    parts: [],
    createdAt: Date.now(),
  });
}

export function addPart(guildId: string, userId: string, part: string): number | undefined {
  const session = getValidSession(guildId, userId);
  if (!session) return undefined;

  const value = part.trim();
  if (!value) return session.parts.length;

  session.parts.push(value);
  session.createdAt = Date.now();
  return session.parts.length;
}

export function finish(guildId: string, userId: string): string | undefined {
  const session = getValidSession(guildId, userId);
  if (!session) return undefined;

  sessions.delete(key(guildId, userId));
  return session.parts.join('\n\n');
}

export function cancel(guildId: string, userId: string): void {
  sessions.delete(key(guildId, userId));
}

export function getPartCount(guildId: string, userId: string): number {
  return getValidSession(guildId, userId)?.parts.length ?? 0;
}
