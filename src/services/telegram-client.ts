import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";
import * as fs from "fs";
// @ts-ignore
import qrcode from "qrcode-terminal";
import { API_ID, API_HASH, SESSION_FILE } from "../config.js";
import { log } from "../utils/logger.js";
import { prompt } from "../utils/prompt.js";

const AUTH_METHOD = process.env.AUTH_METHOD || "qr";
const SESSION_STRING_ENV = process.env.SESSION_STRING || "";

function loadSessionFromFile(): string {
  log("INFO", "Checking for existing session file...", { path: SESSION_FILE });
  if (fs.existsSync(SESSION_FILE)) {
    const sessionString = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    log("INFO", "Found existing session file, will attempt to reuse it", {
      sessionLength: sessionString.length,
    });
    return sessionString;
  }
  log("INFO", "No existing session file found");
  return "";
}

function saveSession(client: TelegramClient): void {
  const savedSession = client.session.save() as unknown as string;
  fs.writeFileSync(SESSION_FILE, savedSession);
  log("INFO", "Session saved to file", {
    path: SESSION_FILE,
    sessionLength: savedSession.length,
  });
}

function deleteSessionFile(): void {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    log("INFO", "Session file deleted", { path: SESSION_FILE });
  }
}

function isAuthKeyDuplicatedError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("AUTH_KEY_DUPLICATED");
  }
  return false;
}

async function authenticateWithQR(client: TelegramClient): Promise<void> {
  log("INFO", "Starting QR code authentication...");
  log("INFO", "Scan the QR code below with your Telegram app:");
  log("INFO", "Go to Settings -> Devices -> Link Desktop Device");
  console.log("");

  await client.signInUserWithQrCode(
    { apiId: API_ID, apiHash: API_HASH },
    {
      qrCode: async (qrCode) => {
        const base64 = qrCode.token.toString("base64");
        const base64url = base64
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        const qrUrl = `tg://login?token=${base64url}`;

        log("DEBUG", "QR code token received", {
          tokenLength: qrCode.token.length,
          base64url: base64url.substring(0, 20) + "...",
        });

        console.log("\n" + "=".repeat(50));
        console.log("  SCAN THIS QR CODE WITH TELEGRAM APP");
        console.log("  Settings -> Devices -> Link Desktop Device");
        console.log("=".repeat(50) + "\n");

        qrcode.generate(qrUrl, { small: true });

        console.log("\n" + "=".repeat(50));
        log("INFO", "Waiting for QR code scan... (code refreshes every 30s)");
      },
      password: async (hint) => {
        log("INFO", "2FA password required", { hint });
        return await prompt("Enter your 2FA password: ");
      },
      onError: async (err) => {
        log("ERROR", "QR authentication error", { message: err.message });
        return true;
      },
    }
  );
}

async function authenticateWithPhone(client: TelegramClient): Promise<void> {
  log("INFO", "Starting phone number authentication...");
  log("INFO", "Phone number must be in international format (e.g., +380XXXXXXXXX)");

  await client.start({
    phoneNumber: async () => {
      log("DEBUG", "phoneNumber callback triggered - waiting for user input");
      const phone = await prompt("Enter your phone number: ");
      log("INFO", "Phone number entered", {
        phone: phone.replace(/\d(?=\d{4})/g, "*"),
      });
      log("DEBUG", "Sending phone number to Telegram API...");
      return phone;
    },
    password: async () => {
      log("DEBUG", "password callback triggered - 2FA is enabled");
      log("INFO", "2FA password required");
      const password = await prompt("Enter your 2FA password: ");
      log("DEBUG", "Password entered, sending to Telegram API...");
      return password;
    },
    phoneCode: async () => {
      log("DEBUG", "phoneCode callback triggered - code was sent");
      log("INFO", "Authentication code sent! Check your Telegram app or SMS.");
      const code = await prompt("Enter the code you received: ");
      log("DEBUG", "Code entered", { codeLength: code.length });
      return code;
    },
    onError: (err) => {
      log("ERROR", "Authentication error occurred", {
        message: err.message,
        name: err.name,
        stack: err.stack,
      });
    },
  });
}

interface SessionResult {
  client: TelegramClient | null;
  authKeyDuplicated: boolean;
}

async function tryConnectWithSession(sessionString: string): Promise<SessionResult> {
  const stringSession = new StringSession(sessionString);

  log("DEBUG", "Creating TelegramClient instance...");
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  client.setLogLevel("error" as never);

  try {
    log("INFO", "Connecting to Telegram servers...");
    await client.connect();
    log("INFO", "Connected to Telegram servers!");

    const isAuthorized = await client.isUserAuthorized();
    if (isAuthorized) {
      log("INFO", "Session is valid and authorized");
      return { client, authKeyDuplicated: false };
    }

    log("WARN", "Session is invalid or expired");
    await client.disconnect();
    return { client: null, authKeyDuplicated: false };
  } catch (error) {
    if (isAuthKeyDuplicatedError(error)) {
      log("WARN", "AUTH_KEY_DUPLICATED error detected - session used from another location");
      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      return { client: null, authKeyDuplicated: true };
    }
    throw error;
  }
}

async function performFreshAuthentication(): Promise<TelegramClient> {
  log("INFO", "Starting fresh authentication...");
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  client.setLogLevel("error" as never);

  await client.connect();

  if (AUTH_METHOD === "qr") {
    await authenticateWithQR(client);
  } else {
    await authenticateWithPhone(client);
  }

  log("INFO", "Successfully authenticated with Telegram!");
  saveSession(client);

  return client;
}

export async function createAndConnectClient(): Promise<TelegramClient> {
  let needsFreshAuth = false;

  // Try SESSION_STRING from env first
  if (SESSION_STRING_ENV) {
    log("INFO", "Trying SESSION_STRING from environment...");
    const result = await tryConnectWithSession(SESSION_STRING_ENV);
    if (result.client) {
      return result.client;
    }
    if (result.authKeyDuplicated) {
      log("WARN", "SESSION_STRING from env has AUTH_KEY_DUPLICATED error");
      needsFreshAuth = true;
    } else {
      log("WARN", "SESSION_STRING from env is invalid, trying session file...");
    }
  }

  // Try session file (skip if we already know we need fresh auth due to AUTH_KEY_DUPLICATED)
  if (!needsFreshAuth) {
    const fileSession = loadSessionFromFile();
    if (fileSession) {
      const result = await tryConnectWithSession(fileSession);
      if (result.client) {
        saveSession(result.client);
        return result.client;
      }
      if (result.authKeyDuplicated) {
        log("WARN", "Session file has AUTH_KEY_DUPLICATED error, deleting and re-authenticating...");
        deleteSessionFile();
        needsFreshAuth = true;
      } else {
        log("WARN", "Session file is invalid, need to authenticate...");
      }
    }
  } else {
    // If env session had AUTH_KEY_DUPLICATED, also delete local session file
    deleteSessionFile();
  }

  // No valid session, need to authenticate
  return performFreshAuthentication();
}

export async function logCurrentUser(client: TelegramClient): Promise<void> {
  const me = await client.getMe();
  log("INFO", "Logged in as", {
    id: me.id.toString(),
    firstName: me.firstName,
    lastName: me.lastName,
    username: me.username,
    phone: me.phone,
  });
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
