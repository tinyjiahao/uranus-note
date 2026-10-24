import { ApiError } from "../lib/http";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateOperationId(operationId: string, now = Date.now()) {
  if (!UUID_V7.test(operationId)) throw new ApiError(400, "INVALID_OPERATION_ID", "operation_id 必须是 UUIDv7");
  const milliseconds = Number.parseInt(operationId.replaceAll("-", "").slice(0, 12), 16);
  if (milliseconds > now + 300_000) throw new ApiError(409, "OPERATION_FROM_FUTURE", "设备时钟过快，请校准后重试");
  if (milliseconds < now - 7 * 86_400_000) throw new ApiError(409, "OPERATION_EXPIRED", "操作标识已过期，请确认资源状态");
}

export type OperationRow = {
  operation_id: string;
  request_hash: string;
  status: "pending" | "succeeded" | "failed";
  result_id: string | null;
  result_revision: number | null;
  result_code: string | null;
};

export async function existingOperation(db: D1Database, id: string, hash: string): Promise<OperationRow | null> {
  const row = await db.prepare("SELECT operation_id, request_hash, status, result_id, result_revision, result_code FROM uranus_operations WHERE operation_id = ?").bind(id).first<OperationRow>();
  if (!row) return null;
  if (row.request_hash !== hash) throw new ApiError(409, "OPERATION_PAYLOAD_MISMATCH", "operation_id 已用于不同请求");
  return row;
}
