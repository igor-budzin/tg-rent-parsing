import { TelegramClient, Api } from "telegram";
import bigInt from "big-integer";
import { log } from "../utils/logger.js";
import { loadSession, saveSession, deleteSession } from "./session-store.js";
import { createClient, waitForWebLogin } from "./telegram-auth.js";

const SESSION_STRING_ENV = process.env.SESSION_STRING || "";

function isAuthKeyDuplicatedError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("AUTH_KEY_DUPLICATED");
  }
  return false;
}

async function tryConnectWithSession(sessionString: string): Promise<TelegramClient | null> {
  const client = createClient(sessionString);

  try {
    log("INFO", "Connecting to Telegram servers...");
    await client.connect();
    log("INFO", "Connected to Telegram servers!");

    if (await client.isUserAuthorized()) {
      log("INFO", "Session is valid and authorized");
      return client;
    }

    log("WARN", "Session is invalid or expired");
  } catch (error) {
    if (!isAuthKeyDuplicatedError(error)) throw error;
    log("WARN", "AUTH_KEY_DUPLICATED error detected - session used from another location");
  }

  await client.destroy().catch(() => undefined);
  return null;
}

export async function createAndConnectClient(): Promise<TelegramClient> {
  const sources = [
    { name: "database", session: await loadSession() },
    { name: "SESSION_STRING env", session: SESSION_STRING_ENV },
  ];

  for (const source of sources) {
    if (!source.session) continue;
    log("INFO", `Trying Telegram session from ${source.name}...`);
    const client = await tryConnectWithSession(source.session);
    if (client) {
      await saveSession(client.session.save() as unknown as string);
      return client;
    }
    if (source.name === "database") await deleteSession();
  }

  // No valid session - wait until someone logs in through the web UI
  const client = await waitForWebLogin();
  await saveSession(client.session.save() as unknown as string);
  log("INFO", "Session saved to database");
  return client;
}

export async function logCurrentUser(client: TelegramClient): Promise<Api.User> {
  const me = await client.getMe();
  log("INFO", "Logged in as", {
    id: me.id.toString(),
    firstName: me.firstName,
    lastName: me.lastName,
    username: me.username,
    phone: me.phone,
  });
  return me;
}

export async function resolveChannels(
  client: TelegramClient,
  channelNames: string[]
): Promise<Map<string, Api.Channel>> {
  log("DEBUG", "Resolving channel entities...");
  const channelEntities = new Map<string, Api.Channel>();

  for (const channelName of channelNames) {
    log("DEBUG", `Attempting to resolve channel: ${channelName}`);
    try {
      let entity: Api.Channel;

      // Check if the channel identifier is a numeric ID (with optional -100 prefix)
      const numericMatch = channelName.match(/^-?(\d+)$/);
      if (numericMatch) {
        let channelIdStr = channelName;

        // Handle the -100 prefix that Telegram uses for channel IDs in some contexts
        // If ID is negative and starts with -100, extract the actual channel ID
        if (channelIdStr.startsWith("-100")) {
          channelIdStr = channelIdStr.slice(4);
        } else if (channelIdStr.startsWith("-")) {
          channelIdStr = channelIdStr.slice(1);
        }

        log("DEBUG", `Resolving as numeric channel ID: ${channelIdStr}`);
        entity = (await client.getEntity(
          new Api.PeerChannel({ channelId: bigInt(channelIdStr) })
        )) as Api.Channel;
      } else {
        // Treat as username
        entity = (await client.getEntity(channelName)) as Api.Channel;
      }

      channelEntities.set(channelName, entity);
      log("INFO", `Channel resolved: ${channelName}`, {
        title: entity.title,
        id: entity.id.toString(),
        username: entity.username,
        participantsCount: entity.participantsCount,
      });
    } catch (error) {
      log("ERROR", `Could not find channel: ${channelName}`, { error });
    }
  }

  return channelEntities;
}
