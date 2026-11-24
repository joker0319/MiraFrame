/**
 * WebSocket 房间 ID 解析。
 * 只接受正整数，拒绝把任意字符串塞进房间名，也挡住 NaN / 负数 / 超大数。
 */
export function parseProjectRoomId(raw: unknown): number | null {
  let value: string | number;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "string") value = raw.trim();
  else return null;

  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
