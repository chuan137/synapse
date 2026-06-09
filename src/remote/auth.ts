export function parseAllowedChats(envValue: string | undefined): number[] {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(n => !isNaN(n));
}

export function isAllowedChat(chatId: number, allowedList: number[]): boolean {
  return allowedList.includes(chatId);
}
