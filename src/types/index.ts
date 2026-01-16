import { Api } from "telegram";

export type NotifyEntity = Api.User | Api.Chat | Api.Channel;

export interface AppContext {
  client: import("telegram").TelegramClient;
  channelEntities: Map<string, Api.Channel>;
  notifyEntity: NotifyEntity;
  useBot: boolean;
}

export interface MessageStats {
  messageCount: number;
  matchCount: number;
}
