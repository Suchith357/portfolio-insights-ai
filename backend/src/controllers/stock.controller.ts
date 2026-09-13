import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/error.js";
import { ok } from "../utils/http.js";
import * as stockService from "../services/stock.service.js";

interface StockQuery {
  search?: string | number;
  sector?: string | number;
  sort?: string | number;
  page?: string | number;
  pageSize?: string | number;
}

const asString = (v: unknown): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : String(v);

const asNumber = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const list = asyncHandler(async (req: Request, res: Response) => {
  const q = (req.query ?? {}) as StockQuery;
  const sector = asString(q.sector);
  const { result, meta } = await stockService.searchStocks({
    search: asString(q.search),
    sector: sector && sector !== "all" ? sector : undefined,
    sort: asString(q.sort),
    page: asNumber(q.page),
    pageSize: asNumber(q.pageSize),
  });
  ok(res, result.rows, 200, meta);
});

export const listSectors = asyncHandler(async (_req: Request, res: Response) => {
  const sectors = await stockService.listSectors();
  ok(res, sectors);
});

export const getDetail = asyncHandler(async (req: Request, res: Response) => {
  const detail = await stockService.getStockDetail(String(req.params["symbol"]));
  ok(res, detail);
});

export const getPrices = asyncHandler(async (req: Request, res: Response) => {
  const limitRaw = asNumber(req.query["limit"]);
  const prices = await stockService.getPriceHistory(String(req.params["symbol"]), limitRaw);
  ok(res, prices);
});

export const getRisk = asyncHandler(async (req: Request, res: Response) => {
  const risk = await stockService.getStockRisk(String(req.params["symbol"]));
  ok(res, risk);
});
