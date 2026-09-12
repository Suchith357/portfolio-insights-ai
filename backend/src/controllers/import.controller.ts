import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as importService from "../services/import.service.js";

/**
 * POST /api/portfolios/:id/import
 * Body: { rows: [{ symbol, quantity, price, date? }] } — rows have already
 * been parsed and mapped from CSV columns by the frontend.
 */
export const importHoldings = asyncHandler(async (req, res) => {
  const result = await importService.importHoldings(
    currentUser(req).userId,
    Number(req.params["id"]),
    req.body.rows,
  );
  ok(res, result);
});
