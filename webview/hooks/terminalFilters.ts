export function shouldStripQueryResponse(sequence: string): boolean {
  return (
    isPrimaryDeviceAttributesReply(sequence) ||
    isSecondaryDeviceAttributesReply(sequence) ||
    isCursorPositionReply(sequence) ||
    isWindowSizeReply(sequence) ||
    isDecModeReply(sequence) ||
    isOscColorQueryReply(sequence)
  );
}
export function shouldStripReplayedOutput(sequence: string): boolean {
  return isTerminalQuery(sequence) || isCursorVisibilityControl(sequence);
}
export function isTerminalQuery(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[(?:>|\?)?\d*(?:;\d+)*[cn]$`).test(sequence) ||
    new RegExp(String.raw`^\x1b\[(?:\?|>)?\d*(?:;\d+)*t$`).test(sequence) ||
    new RegExp(String.raw`^\x1b\[\?\d+(?:;\d+)*\$p$`).test(sequence)
  );
}
export function isPrimaryDeviceAttributesReply(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[\?\d+(?:;\d+)*c$`).test(sequence) ||
    new RegExp(String.raw`^\x9b\?\d+(?:;\d+)*c$`).test(sequence)
  );
}
export function isSecondaryDeviceAttributesReply(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[>\d+(?:;\d+)*c$`).test(sequence) ||
    new RegExp(String.raw`^\x9b>\d+(?:;\d+)*c$`).test(sequence)
  );
}
export function isCursorPositionReply(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[(?:\?)?\d+;\d+R$`).test(sequence) ||
    new RegExp(String.raw`^\x9b(?:\?)?\d+;\d+R$`).test(sequence)
  );
}
export function isWindowSizeReply(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[8;\d+;\d+t$`).test(sequence) ||
    /^\x9b8;\d+;\d+t$/.test(sequence)
  );
}
export function isDecModeReply(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[\?\d+(?:;\d+)*;\d+\$y$`).test(sequence) ||
    new RegExp(String.raw`^\x9b\?\d+(?:;\d+)*;\d+\$y$`).test(sequence)
  );
}
export function isOscColorQueryReply(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\](?:10|11);[\s\S]*(?:\x07|\x1b\\)$`).test(
      sequence,
    ) || new RegExp(String.raw`^\x9d(?:10|11);[\s\S]*\x9c$`).test(sequence)
  );
}
export function isMouseReport(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[<\d+;\d+;\d+[Mm]$`).test(sequence) ||
    new RegExp(String.raw`^\x1b\[M[\s\S]{3}$`).test(sequence)
  );
}
export function isCursorVisibilityControl(sequence: string): boolean {
  return isCursorVisibilityHide(sequence) || isCursorVisibilityShow(sequence);
}
export function isCursorVisibilityHide(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[\?25l$`).test(sequence) ||
    /^\x9b\?25l$/.test(sequence)
  );
}
export function isCursorVisibilityShow(sequence: string): boolean {
  return (
    new RegExp(String.raw`^\x1b\[\?25h$`).test(sequence) ||
    /^\x9b\?25h$/.test(sequence)
  );
}
