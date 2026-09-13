import { prisma } from "../utils/prisma.js";
import { toUserDto, type UserDto } from "../utils/mappers.js";
import { conflict, notFound, unauthorized } from "../utils/http.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { recordAudit } from "../utils/audit.js";

export async function getProfile(userId: number): Promise<UserDto> {
  const user = await prisma.users.findUnique({ where: { user_id: userId } });
  if (!user) throw notFound("Account not found.");
  return toUserDto(user);
}

export async function updateProfile(
  userId: number,
  patch: { name?: string; email?: string },
): Promise<UserDto> {
  const user = await prisma.users.findUnique({ where: { user_id: userId } });
  if (!user) throw notFound("Account not found.");

  if (patch.email && patch.email !== user.email) {
    const clash = await prisma.users.findUnique({ where: { email: patch.email } });
    if (clash) throw conflict("An account with this email already exists.");
  }

  const updated = await prisma.users.update({
    where: { user_id: userId },
    data: {
      name: patch.name ?? undefined,
      email: patch.email ?? undefined,
    },
  });

  await recordAudit({
    userId,
    action: "PROFILE_UPDATE",
    entityType: "USER",
    entityId: userId,
    details: "Profile details updated.",
  });

  return toUserDto(updated);
}

/**
 * Changes the account password. Requires and verifies the current password,
 * then revokes nothing else — other sessions keep working because JWTs are
 * stateless; the audit trail records the change.
 */
export async function changePassword(
  userId: number,
  input: { currentPassword: string; newPassword: string },
): Promise<{ changed: boolean }> {
  const user = await prisma.users.findUnique({ where: { user_id: userId } });
  if (!user) throw notFound("Account not found.");

  const currentOk = await verifyPassword(input.currentPassword, user.password_hash);
  if (!currentOk) {
    throw unauthorized("Your current password is incorrect.");
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();
  await prisma.users.update({
    where: { user_id: userId },
    data: { password_hash: passwordHash, password_changed_at: now },
  });

  await recordAudit({
    userId,
    action: "PASSWORD_CHANGE",
    entityType: "USER",
    entityId: userId,
    details: "Password changed; sessions issued before now are invalidated.",
  });

  return { changed: true };
}
