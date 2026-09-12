import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as users from "../controllers/user.controller.js";

const updateSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100).optional(),
    email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(255).optional(),
  })
  .refine((v) => v.name !== undefined || v.email !== undefined, {
    message: "Provide a name or an email to update.",
  });

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters.")
      .max(72, "Password must be at most 72 characters."),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "The new password must differ from the current one.",
  });

export const usersRouter = Router();

usersRouter.use(requireAuth);
usersRouter.get("/me", users.getProfile);
usersRouter.patch("/me", validate(updateSchema), users.updateProfile);
usersRouter.patch("/me/password", validate(passwordSchema), users.changePassword);
