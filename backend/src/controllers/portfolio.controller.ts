import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as portfolioService from "../services/portfolio.service.js";

export const list = asyncHandler(async (req, res) => {
  const rows = await portfolioService.listPortfolios(currentUser(req).userId);
  ok(res, rows);
});

export const getOne = asyncHandler(async (req, res) => {
  const row = await portfolioService.getPortfolio(currentUser(req).userId, Number(req.params["id"]));
  ok(res, row);
});

export const create = asyncHandler(async (req, res) => {
  const row = await portfolioService.createPortfolio(currentUser(req).userId, req.body);
  ok(res, row, 201);
});

export const update = asyncHandler(async (req, res) => {
  const row = await portfolioService.updatePortfolio(currentUser(req).userId, Number(req.params["id"]), req.body);
  ok(res, row);
});

export const remove = asyncHandler(async (req, res) => {
  await portfolioService.deletePortfolio(currentUser(req).userId, Number(req.params["id"]));
  ok(res, { deleted: true });
});
