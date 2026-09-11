import { prisma } from "./prisma.js";

export type AuditAction =
  | "LOGIN"
  | "LOGOUT"
  | "REGISTER"
  | "PROFILE_UPDATE"
  | "PASSWORD_CHANGE"
  | "PORTFOLIO_CREATE"
  | "PORTFOLIO_UPDATE"
  | "PORTFOLIO_DELETE"
  | "HOLDING_CREATE"
  | "HOLDING_UPDATE"
  | "HOLDING_DELETE"
  | "TRANSACTION_CREATE"
  | "TRANSACTION_DELETE"
  | "WATCHLIST_ADD"
  | "WATCHLIST_REMOVE"
  | "ALERT_READ"
  | "ANALYSIS_SNAPSHOT"
  | "ADMIN_USER_UPDATE"
  | "ADMIN_STOCK_UPDATE";

/**
 * Best-effort audit trail. Never blocks or fails the originating request.
 */
export async function recordAudit(params: {
  userId?: number | null;
  action: AuditAction;
  entityType: string;
  entityId?: number | null;
  details?: string;
}): Promise<void> {
  try {
    await prisma.audit_logs.create({
      data: {
        user_id: params.userId ?? null,
        action: params.action,
        entity_type: params.entityType,
        entity_id: params.entityId ?? null,
        details: params.details ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] failed to write audit log", error);
  }
}
