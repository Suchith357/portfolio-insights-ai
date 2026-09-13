import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
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

// Brute-force protection on the unauthenticated endpoints.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, scope: "auth" });

authRouter.post("/register", authLimiter, validate(registerSchema), auth.register);
authRouter.post("/login", authLimiter, validate(loginSchema), auth.login);
authRouter.get("/me", requireAuth, auth.me);
