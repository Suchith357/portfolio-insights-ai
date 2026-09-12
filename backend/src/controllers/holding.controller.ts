import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as holdingService from "../services/holding.service.js";

export const listAll = asyncHandler(async (req, res) => {
  const rows = await holdingService.listAllHoldings(currentUser(req).userId);
  ok(res, rows);
});

export const listForPortfolio = asyncHandler(async (req, res) => {
  const rows = await holdingService.listPortfolioHoldings(
    currentUser(req).userId,
    Number(req.params["portfolioId"]),
  );
  ok(res, rows);
});

export const getOne = asyncHandler(async (req, res) => {
  const row = await holdingService.getHolding(currentUser(req).userId, Number(req.params["id"]));
  ok(res, row);
});

export const remove = asyncHandler(async (req, res) => {
  await holdingService.deleteHolding(currentUser(req).userId, Number(req.params["id"]));
  ok(res, { deleted: true });
});
