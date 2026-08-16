export interface WebviewMessage {
  readonly type?: string;
  readonly [key: string]: unknown;
}
export type WebviewMessageHandler = () => void | Promise<void>;
export function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
