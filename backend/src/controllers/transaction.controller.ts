import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as transactionService from "../services/transaction.service.js";

export const listAll = asyncHandler(async (req, res) => {
  const rows = await transactionService.listAllTransactions(currentUser(req).userId);
  ok(res, rows);
});

export const listForPortfolio = asyncHandler(async (req, res) => {
  const rows = await transactionService.listPortfolioTransactions(
    currentUser(req).userId,
    Number(req.params["portfolioId"]),
  );
  ok(res, rows);
});

export const create = asyncHandler(async (req, res) => {
  const row = await transactionService.recordTransaction(currentUser(req).userId, req.body);
  ok(res, row, 201);
});
