import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as userService from "../services/user.service.js";

export const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getProfile(currentUser(req).userId);
  ok(res, user);
});

export const updateProfile = asyncHandler(async (req, res) => {
  const result = await userService.updateProfile(currentUser(req).userId, req.body);
  ok(res, result);
});
