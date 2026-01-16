import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import * as fs from "fs";
// @ts-ignore
import qrcode from "qrcode-terminal";
import { API_ID, API_HASH, SESSION_FILE } from "../config.js";
import { log } from "../utils/logger.js";
import { prompt } from "../utils/prompt.js";

const AUTH_METHOD = process.env.AUTH_METHOD || "qr";

function loadSession(): string {
  log("INFO", "Checking for existing session file...", { path: SESSION_FILE });
  if (fs.existsSync(SESSION_FILE)) {
    const sessionString = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    log("INFO", "Found existing session, will attempt to reuse it", {
      sessionLength: sessionString.length,
    });
    return sessionString;
  }
  log("INFO", "No existing session found, will need to authenticate");
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

export async function createAndConnectClient(): Promise<TelegramClient> {
  const sessionString = loadSession();
  const stringSession = new StringSession(sessionString);

  log("DEBUG", "Creating TelegramClient instance...");
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  client.setLogLevel("error" as never);

  log("INFO", "Connecting to Telegram servers...");
  await client.connect();
  log("INFO", "Connected to Telegram servers!");

  const isAuthorized = await client.isUserAuthorized();
  log("INFO", `Authorization status: ${isAuthorized ? "Already authorized" : "Need to authenticate"}`);

  if (!isAuthorized) {
    if (AUTH_METHOD === "qr") {
      await authenticateWithQR(client);
    } else {
      await authenticateWithPhone(client);
    }
  }

  log("INFO", "Successfully authenticated with Telegram!");
  saveSession(client);

  return client;
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
      const entity = (await client.getEntity(channelName)) as Api.Channel;
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
