import { prisma } from "../utils/prisma.js";
import { toUserDto, type UserDto } from "../utils/mappers.js";
import { conflict, unauthorized } from "../utils/http.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { signToken } from "../utils/jwt.js";
import { recordAudit } from "../utils/audit.js";

interface AuthResult {
  token: string;
  user: UserDto;
}

export async function register(input: { name: string; email: string; password: string }): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim();

  const existing = await prisma.users.findUnique({ where: { email } });
  if (existing) {
    throw conflict("An account with this email already exists.");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.users.create({
    data: {
      name: input.name.trim(),
      email,
      password_hash: passwordHash,
      role: "USER",
    },
  });

  await recordAudit({
    userId: user.user_id,
    action: "REGISTER",
    entityType: "USER",
    entityId: user.user_id,
    details: `Account created for ${email}.`,
  });
  return { token: signToken({ userId: user.user_id, email: user.email, role: "USER" }), user: toUserDto(user) };
}

export async function login(input: { email: string; password: string }): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.users.findUnique({ where: { email } });

  // Same generic message for unknown email and wrong password (no user enumeration).
  if (!user || !(await verifyPassword(input.password, user.password_hash))) {
    await recordAudit({
      userId: user?.user_id ?? null,
      action: "LOGIN_FAILED",
      entityType: "USER",
      entityId: user?.user_id ?? null,
      details: "Failed sign-in attempt.",
    });
    throw unauthorized("Email or password is incorrect.");
  }

  await recordAudit({
    userId: user.user_id,
    action: "LOGIN",
    entityType: "USER",
    entityId: user.user_id,
    details: `${user.email} signed in.`,
  });

  return {
    token: signToken({ userId: user.user_id, email: user.email, role: user.role === "ADMIN" ? "ADMIN" : "USER" }),
    user: toUserDto(user),
  };
}

export async function getUserById(userId: number): Promise<UserDto> {
  const user = await prisma.users.findUnique({ where: { user_id: userId } });
  if (!user) throw unauthorized("Your session has expired. Please sign in again.");
  return toUserDto(user);
}
