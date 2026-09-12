import { prisma } from "../utils/prisma.js";
import { toUserDto, type UserDto } from "../utils/mappers.js";
import { conflict, notFound } from "../utils/http.js";
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
