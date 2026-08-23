export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string") return error;

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;

    try {
      const serialized = JSON.stringify(error);
      if (serialized) return serialized;
    } catch {
      // Fall through to String for circular or otherwise unserializable values.
    }
  }

  return String(error);
}
