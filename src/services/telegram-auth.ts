import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import QRCode from "qrcode";
import { API_ID, API_HASH } from "../config.js";
import { log } from "../utils/logger.js";

// Interactive Telegram login driven by the web UI (see web/server.ts)

export type AuthStatus =
  | "connecting"
  | "needs_login"
  | "qr"
  | "code"
  | "password"
  | "logged_in";

export interface AuthState {
  status: AuthStatus;
  qrDataUrl?: string;
  passwordHint?: string;
  error?: string;
  user?: string;
}

interface PendingInput {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

let state: AuthState = { status: "connecting" };
let pendingInput: PendingInput | null = null;
let attemptId = 0;
let activeClient: TelegramClient | null = null;
let onLoginComplete: ((client: TelegramClient) => void) | null = null;

export function createClient(session = ""): TelegramClient {
  const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });
  client.setLogLevel("error" as never);
  return client;
}

export function getAuthState(): AuthState {
  return state;
}

export function setLoggedIn(user: string): void {
  state = { status: "logged_in", user };
}

export function waitForWebLogin(): Promise<TelegramClient> {
  state = { status: "needs_login" };
  log("WARN", "Telegram login required - open the web UI to log in");
  return new Promise((resolve) => {
    onLoginComplete = resolve;
  });
}

function updateState(id: number, next: Partial<AuthState>): void {
  if (id === attemptId) state = { ...state, ...next };
}

function waitForInput(
  id: number,
  status: "code" | "password",
  extra: Partial<AuthState> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (id !== attemptId) return reject(new Error("Login attempt cancelled"));
    pendingInput = { resolve, reject };
    updateState(id, { status, qrDataUrl: undefined, ...extra });
  });
}

export function submitInput(value: string): boolean {
  if (!pendingInput || !value) return false;
  const input = pendingInput;
  pendingInput = null;
  state = { ...state, error: undefined };
  input.resolve(value);
  return true;
}

export async function cancelLogin(): Promise<void> {
  attemptId++;
  pendingInput?.reject(new Error("Login attempt cancelled"));
  pendingInput = null;
  const client = activeClient;
  activeClient = null;
  if (onLoginComplete) state = { status: "needs_login" };
  await client?.destroy().catch(() => undefined);
}

function toQrUrl(token: Buffer): string {
  const base64url = token
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `tg://login?token=${base64url}`;
}

export function startLogin(method: "qr" | "phone", phone?: string): string | null {
  if (state.status !== "needs_login") return "Login is not available right now";
  if (method === "phone" && !phone) return "Phone number is required";

  const id = ++attemptId;
  state = { status: method === "qr" ? "qr" : "connecting" };
  runLogin(id, method, phone).catch(() => undefined);
  return null;
}

async function runLogin(id: number, method: "qr" | "phone", phone?: string): Promise<void> {
  const client = createClient();
  activeClient = client;
  const cancelled = () => id !== attemptId;

  // Code/password errors are retried (the user can type again), anything else aborts
  const onError = async (err: Error): Promise<boolean> => {
    if (cancelled()) return true;
    log("WARN", "Telegram login error", { message: err.message });
    const retry = state.status === "code" || state.status === "password";
    updateState(id, { error: err.message });
    return !retry;
  };

  try {
    await client.connect();

    if (method === "qr") {
      log("INFO", "Starting QR code login from web UI");
      await client.signInUserWithQrCode(
        { apiId: API_ID, apiHash: API_HASH },
        {
          qrCode: async ({ token }) => {
            updateState(id, { status: "qr", qrDataUrl: await QRCode.toDataURL(toQrUrl(token)) });
          },
          password: (hint) => waitForInput(id, "password", { passwordHint: hint }),
          onError,
        }
      );
    } else {
      log("INFO", "Starting phone login from web UI");
      // Errors while still "connecting" (e.g. invalid phone number) abort the attempt,
      // otherwise gramjs would retry forever with the same number
      await client.start({
        phoneNumber: async () => phone!,
        phoneCode: () => waitForInput(id, "code"),
        password: (hint) => waitForInput(id, "password", { passwordHint: hint }),
        onError,
      });
    }

    if (cancelled()) return;
    activeClient = null;
    log("INFO", "Successfully authenticated with Telegram via web UI");
    const complete = onLoginComplete;
    onLoginComplete = null;
    state = { status: "connecting" };
    complete?.(client);
  } catch (error) {
    if (cancelled()) return;
    const message = error instanceof Error ? error.message : String(error);
    log("ERROR", "Telegram login failed", { message });
    activeClient = null;
    pendingInput = null;
    state = { status: "needs_login", error: state.error ?? message };
    await client.destroy().catch(() => undefined);
  }
}
