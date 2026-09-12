import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as watchlistService from "../services/watchlist.service.js";

export const list = asyncHandler(async (req, res) => {
  const rows = await watchlistService.listWatchlist(currentUser(req).userId);
  ok(res, rows);
});

export const add = asyncHandler(async (req, res) => {
  const row = await watchlistService.addToWatchlist(currentUser(req).userId, req.body.symbol);
  ok(res, row, 201);
});

export const remove = asyncHandler(async (req, res) => {
  await watchlistService.removeByWatchlistId(currentUser(req).userId, Number(req.params["id"]));
  ok(res, { deleted: true });
});
