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

/**
 * 从 WS `confirm` 载荷里取 runId。
 *
 * 兼容两种形状：直接 `{run_id}`，以及前端 `{type:"confirm", data:{run_id}}`。
 * 只接受正整数，拒绝 NaN/负数/字符串注入。
 */
export function parseConfirmRunId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  return parseProjectRoomId(nested.run_id);
}

/** 从 socket 已加入的房间反查项目 id（只认 project:<id> 这一个前缀）。 */
export function projectIdFromRooms(rooms: Iterable<string>): number | null {
  for (const room of rooms) {
    if (!room.startsWith("project:")) continue;
    const projectId = parseProjectRoomId(room.slice("project:".length));
    if (projectId !== null) return projectId;
  }
  return null;
}
