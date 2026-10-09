export interface MessageStats {
  messageCount: number;
  matchCount: number;
}

export interface ParsedPost {
  type: "rent" | "sell" | null;
  price: { amount: number; currency: string; period: "month" | "day" | null } | null;
  location: string | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  area: number | null;
  contacts: string[];
}
