import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import * as auth from "../controllers/auth.controller.js";

const registerSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(255),
  password: z.string().min(8, "Password must be at least 8 characters.").max(128),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(1, "Password is required.").max(128),
});

export const authRouter = Router();

authRouter.post("/register", validate(registerSchema), auth.register);
authRouter.post("/login", validate(loginSchema), auth.login);
authRouter.get("/me", requireAuth, auth.me);
