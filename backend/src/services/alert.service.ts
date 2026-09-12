import { prisma } from "../utils/prisma.js";
import { toAlertDto, type AlertDto } from "../utils/mappers.js";
import { notFound } from "../utils/http.js";

export async function listAlerts(userId: number): Promise<AlertDto[]> {
  const rows = await prisma.alerts.findMany({
    where: { user_id: userId },
    include: { stocks: { select: { symbol: true } } },
    orderBy: { created_at: "desc" },
  });
  return rows.map((a) => toAlertDto(a, a.stocks?.symbol ?? null));
}

export async function markRead(userId: number, alertId: number): Promise<AlertDto> {
  const alert = await prisma.alerts.findUnique({
    where: { alert_id: alertId },
    include: { stocks: { select: { symbol: true } } },
  });
  if (!alert || alert.user_id !== userId) {
    throw notFound("We couldn't find that alert.");
  }

  const updated = await prisma.alerts.update({
    where: { alert_id: alertId },
    data: { is_read: true },
    include: { stocks: { select: { symbol: true } } },
  });
  return toAlertDto(updated, updated.stocks?.symbol ?? null);
}

export async function markAllRead(userId: number): Promise<{ updated: number }> {
  const result = await prisma.alerts.updateMany({
    where: { user_id: userId, is_read: false },
    data: { is_read: true },
  });
  return { updated: result.count };
}
