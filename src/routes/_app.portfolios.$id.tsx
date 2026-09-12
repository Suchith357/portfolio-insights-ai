import { useMemo, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AiDisclaimer,
  AiInsightCard,
  DemoDataBadge,
  PnlText,
  ScoreMeter,
  SectionHeader,
  StatCard,
} from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { AllocationBars, SectorDonut } from "@/components/charts/charts";
import { offlineExplainer } from "@/lib/ai-insights";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { parseHoldingsCsv, type ParsedCsvRow } from "@/lib/csv-import";
import { useAuth } from "@/hooks/use-auth";
import * as portfolioService from "@/services/portfolio.service";
import * as stockService from "@/services/stock.service";

export const Route = createFileRoute("/_app/portfolios/$id")({
  head: () => ({
    meta: [
      { title: "Portfolio detail — PortfolioIQ" },
      {
        name: "description",
        content: "Holdings, sector allocation, risk and diversification breakdown for a single portfolio.",
      },
      { property: "og:title", content: "Portfolio detail — PortfolioIQ" },
      { property: "og:description", content: "Holdings, allocation and risk breakdown for this portfolio." },
    ],
  }),
  component: PortfolioDetail,
});

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel p-4 sm:p-5 ${className}`}>{children}</section>;
}

/* ------------------------------------------------------------------ */
/* Record transaction dialog: BUY (add stock) / SELL (reduce position) */
/* ------------------------------------------------------------------ */

interface TxnFormState {
  mode: "BUY" | "SELL";
  symbol: string;
  quantity: string;
  price: string;
  date: string;
}

interface TxnErrors {
  symbol?: string;
  quantity?: string;
  price?: string;
  general?: string;
}

function TransactionDialog({
  portfolioId,
  holdings,
  open,
  onOpenChange,
  onDone,
}: {
  portfolioId: string;
  holdings: Array<{ symbol: string; stock: { name: string; lastPrice: number }; quantity: number }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<TxnFormState>({ mode: "BUY", symbol: "", quantity: "", price: "", date: "" });
  const [errors, setErrors] = useState<TxnErrors>({});

  const isBuy = form.mode === "BUY";
  const selectedHolding = holdings.find((h) => h.symbol === form.symbol);
  const suggestedPrice = selectedHolding?.stock.lastPrice ?? "";

  function reset() {
    setForm({ mode: "BUY", symbol: "", quantity: "", price: "", date: "" });
    setErrors({});
  }

  function setMode(mode: "BUY" | "SELL") {
    setForm((f) => ({ ...f, mode, symbol: "", price: "", quantity: "" }));
    setErrors({});
  }

  function validate(): boolean {
    const found: TxnErrors = {};
    if (!form.symbol) found.symbol = "Select a stock.";
    const qty = Number(form.quantity);
    if (!Number.isFinite(qty) || qty <= 0) found.quantity = "Quantity must be a number greater than 0.";
    const price = Number(form.price);
    if (!Number.isFinite(price) || price <= 0) found.price = "Price must be a number greater than 0.";
    if (!isBuy && selectedHolding && Number.isFinite(qty) && qty > selectedHolding.quantity) {
      found.quantity = `You hold ${selectedHolding.quantity} shares — you cannot sell more than that.`;
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  const record = useMutation({
    mutationFn: () =>
      portfolioService.recordTransaction({
        portfolioId,
        symbol: form.symbol,
        type: form.mode,
        quantity: Number(form.quantity),
        price: Number(form.price),
        executedAt: form.date ? new Date(form.date).toISOString() : new Date().toISOString(),
      }),
    onSuccess: (_data, _vars) => {
      onDone(
        isBuy
          ? `Recorded BUY of ${form.quantity} ${form.symbol} — holdings and analytics updated.`
          : `Recorded SELL of ${form.quantity} ${form.symbol} — holdings and analytics updated.`,
      );
      reset();
      onOpenChange(false);
    },
    onError: (err: unknown) =>
      setErrors({ general: err instanceof Error ? err.message : "We couldn't record this transaction." }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    record.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isBuy ? "Add stock / record BUY" : "Record SELL"}</DialogTitle>
          <DialogDescription>
            {isBuy
              ? "Buying creates or extends a holding and updates the weighted average purchase price. Analytics recalculate immediately."
              : "Selling reduces the position. You cannot sell more than you hold. The transaction history keeps every trade."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mt-2 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={isBuy ? "default" : "outline"}
              onClick={() => setMode("BUY")}
            >
              BUY
            </Button>
            <Button
              type="button"
              variant={!isBuy ? "default" : "outline"}
              onClick={() => setMode("SELL")}
            >
              SELL
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="txn-symbol">Stock</Label>
            <Select
              value={form.symbol}
              onValueChange={(v) =>
                setForm((f) => {
                  const held = holdings.find((h) => h.symbol === v);
                  return { ...f, symbol: v, price: f.price || String(held?.stock.lastPrice ?? "") };
                })
              }
            >
              <SelectTrigger id="txn-symbol" aria-invalid={!!errors.symbol}>
                <SelectValue placeholder={isBuy ? "Search and select a stock" : "Select a held stock"} />
              </SelectTrigger>
              <SelectContent>
                {(isBuy ? holdings : holdings.filter((h) => h.quantity > 0)).map((h) => (
                  <SelectItem key={h.symbol} value={h.symbol}>
                    {h.symbol} — {h.stock.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.symbol && <p className="text-xs text-destructive">{errors.symbol}</p>}
            {isBuy && !errors.symbol && (
              <p className="text-xs text-muted-foreground">
                The list shows the full catalogue below; pick any stock. Existing positions are merged with a weighted
                average price.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="txn-qty">Quantity</Label>
              <Input
                id="txn-qty"
                inputMode="decimal"
                value={form.quantity}
                aria-invalid={!!errors.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
              />
              {errors.quantity && <p className="text-xs text-destructive">{errors.quantity}</p>}
              {!isBuy && selectedHolding && !errors.quantity && (
                <p className="text-xs text-muted-foreground">You hold {selectedHolding.quantity} shares.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn-price">Price per share (₹)</Label>
              <Input
                id="txn-price"
                inputMode="decimal"
                value={form.price}
                aria-invalid={!!errors.price}
                placeholder={typeof suggestedPrice === "number" ? String(suggestedPrice) : undefined}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              />
              {errors.price && <p className="text-xs text-destructive">{errors.price}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="txn-date">Transaction date (optional — defaults to now)</Label>
            <Input
              id="txn-date"
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>

          {form.symbol && Number(form.quantity) > 0 && Number(form.price) > 0 && (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              Total: <span className="num font-semibold">{formatCurrency(Number(form.quantity) * Number(form.price))}</span>
            </p>
          )}

          {errors.general && <p className="text-sm text-destructive">{errors.general}</p>}

          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={record.isPending}>
              {record.isPending ? "Recording…" : isBuy ? "Record BUY" : "Record SELL"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* CSV import dialog: upload → preview → confirm → summary             */
/* ------------------------------------------------------------------ */

function ImportDialog({
  portfolioId,
  knownSymbols,
  open,
  onOpenChange,
  onDone,
}: {
  portfolioId: string;
  knownSymbols: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ParsedCsvRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ imported: number; skipped: number; errors: number } | null>(null);

  const validRows = useMemo(
    () => rows.filter((r) => !r.problem && r.symbol && r.quantity && r.price) as Array<
      ParsedCsvRow & { symbol: string; quantity: number; price: number }
    >,
    [rows],
  );
  const invalidRows = rows.filter((r) => r.problem);

  function handleFile(file: File) {
    setFileName(file.name);
    setSummary(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const parsed = parseHoldingsCsv(text);
      if (parsed.length === 0) {
        setParseError("The file appears to be empty or is not a CSV.");
        setRows([]);
        return;
      }
      if (parsed.length === 1 && parsed[0] && parsed[0].rowNumber === 0) {
        setParseError(parsed[0].problem ?? null);
        setRows([]);
        return;
      }
      setParseError(null);
      setRows(parsed.slice(0, 500));
    };
    reader.readAsText(file);
  }

  const doImport = useMutation({
    mutationFn: () =>              portfolioService.importHoldings(
                portfolioId,
                validRows.map((r) => {
                  const row: { symbol: string; quantity: number; price: number; date?: string } = {
                    symbol: r.symbol,
                    quantity: r.quantity,
                    price: r.price,
                  };
                  if (r.date !== undefined) row.date = r.date;
                  return row;
                }),
              ),
    onSuccess: (result) => {
      setSummary({ imported: result.imported, skipped: result.skipped, errors: result.errors.length });
      onDone(
        `Import finished: ${result.imported} stock(s) imported, ${result.skipped} row(s) skipped, ${result.errors.length} error(s).`,
      );
    },
    onError: (err: unknown) =>
      setParseError(err instanceof Error ? err.message : "The import failed. Please try again."),
  });

  function reset() {
    setFileName("");
    setRows([]);
    setParseError(null);
    setSummary(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import holdings from CSV</DialogTitle>
          <DialogDescription>
            Export holdings from any platform into a CSV with <span className="num">symbol</span>,{" "}
            <span className="num">quantity</span> and <span className="num">average_price</span> columns (a{" "}
            <span className="num">date</span> column is optional), then review every row here before anything is saved.
          </DialogDescription>
        </DialogHeader>

        {summary ? (
          <div className="mt-2 space-y-3">
            <div className="rounded-md border border-gain/40 bg-gain/10 p-4 text-sm">
              <p className="font-semibold text-gain">Import complete</p>
              <ul className="mt-2 space-y-1">
                <li>Imported: <span className="num font-medium">{summary.imported}</span> stock(s)</li>
                <li>Skipped: <span className="num font-medium">{summary.skipped}</span> row(s)</li>
                <li>Errors: <span className="num font-medium">{summary.errors}</span></li>
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Every imported row was recorded as a BUY transaction so the portfolio history stays complete. Holdings
              already in the portfolio were merged at a weighted average price.
            </p>
            <DialogFooter>
              <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="mt-2 space-y-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                aria-label="Choose a CSV file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <button
                type="button"
                className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-5 w-5" />
                {fileName ? fileName : "Choose a CSV file"}
                <span className="text-xs">Max 500 rows · comma, semicolon or tab separated</span>
              </button>

              {parseError && <p className="text-sm text-destructive">{parseError}</p>}

              {rows.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  <table className="w-full min-w-[420px] text-xs">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b border-border text-left uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Row</th>
                        <th className="px-3 py-2 font-medium">Symbol</th>
                        <th className="px-3 py-2 font-medium">Qty</th>
                        <th className="px-3 py-2 font-medium">Price</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const known = r.symbol ? knownSymbols.has(r.symbol) : false;
                        const status = r.problem
                          ? { label: r.problem, tone: "text-destructive" }
                          : !known
                            ? { label: "Symbol not in catalogue — will be skipped", tone: "text-warning" }
                            : { label: "Ready", tone: "text-gain" };
                        return (
                          <tr key={r.rowNumber} className="border-b border-border/50 last:border-0">
                            <td className="num px-3 py-1.5">{r.rowNumber}</td>
                            <td className="num px-3 py-1.5 font-medium">{r.symbol ?? "—"}</td>
                            <td className="num px-3 py-1.5">{r.quantity ?? "—"}</td>
                            <td className="num px-3 py-1.5">{r.price != null ? formatCurrency(r.price) : "—"}</td>
                            <td className={`px-3 py-1.5 ${status.tone}`}>{status.label}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <DialogFooter className="mt-3">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={validRows.length === 0 || doImport.isPending}
                onClick={() => doImport.mutate()}
              >
                {doImport.isPending
                  ? "Importing…"
                  : `Import ${validRows.length} row(s)`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */

function PortfolioDetail() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [txnOpen, setTxnOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [showAllTxns, setShowAllTxns] = useState(false);

  const view = useQuery({
    queryKey: ["portfolio-view", id],
    queryFn: () => portfolioService.getPortfolioView(id),
  });

  const transactions = useQuery({
    queryKey: ["transactions", id],
    queryFn: () => portfolioService.listTransactions(id),
  });

  const catalogue = useQuery({
    queryKey: ["stocks", "catalogue"],
    queryFn: () => stockService.searchStocks({ pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ["portfolio-view", id] });
    void qc.invalidateQueries({ queryKey: ["transactions", id] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    void qc.invalidateQueries({ queryKey: ["portfolios"] });
    void qc.invalidateQueries({ queryKey: ["holdings"] });
  }

  const backLink = (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/portfolios">
        <ArrowLeft className="mr-1.5 h-4 w-4" />
        Back to portfolios
      </Link>
    </Button>
  );

  if (view.isLoading) {
    return (
      <div className="space-y-4">
        {backLink}
        <CardsSkeleton />
        <div className="panel">
          <TableSkeleton />
        </div>
      </div>
    );
  }

  if (view.isError || !view.data) {
    return (
      <div className="space-y-4">
        {backLink}
        <ErrorState
          title="We couldn't open this portfolio"
          description="It may have been removed, or the analytics service didn't respond."
          onRetry={() => view.refetch()}
        />
      </div>
    );
  }

  const { portfolio, holdings, metrics } = view.data;
  const insights = offlineExplainer.explainPortfolio(metrics);
  const catalogueRows = catalogue.data?.rows ?? [];
  // Plain expressions (not useMemo) so no hook sits below the early returns.
  const dialogHoldings = (() => {
    const held = holdings.map((h) => ({
      symbol: h.symbol,
      stock: { name: h.stock.name, lastPrice: h.stock.lastPrice },
      quantity: h.quantity,
    }));
    const heldSymbols = new Set(held.map((h) => h.symbol));
    const rest = catalogueRows
      .filter((s) => !heldSymbols.has(s.symbol))
      .map((s) => ({ symbol: s.symbol, stock: { name: s.name, lastPrice: s.lastPrice }, quantity: 0 }));
    return [...held, ...rest];
  })();
  const knownSymbols = new Set([...dialogHoldings.map((d) => d.symbol), ...catalogueRows.map((s) => s.symbol)]);

  const allTransactions = transactions.data ?? [];
  const filteredTransactions = allTransactions.filter((t) => typeFilter === "ALL" || t.type === typeFilter);
  const visibleTransactions = showAllTxns ? filteredTransactions : filteredTransactions.slice(0, 10);

  function handleDone(message: string) {
    setBanner(message);
    invalidate();
    window.setTimeout(() => setBanner(null), 6000);
  }

  return (
    <div className="space-y-6">
      {backLink}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{portfolio.name}</h1>
          <p className="text-sm text-muted-foreground">
            {portfolio.description || "No description added."} · Created {formatDate(portfolio.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DemoDataBadge />
          <Button size="sm" onClick={() => setTxnOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add stock / record trade
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 h-4 w-4" />
            Import CSV
          </Button>
        </div>
      </div>

      {banner && (
        <p className="rounded-md border border-gain/40 bg-gain/10 px-3 py-2 text-sm text-gain" role="status">
          {banner}
        </p>
      )}

      {metrics.holdingCount === 0 ? (
        <EmptyState
          title="This portfolio has no holdings yet"
          description="Add your first stock to see value, P&L, risk and diversification analytics here."
          icon={<Plus className="h-5 w-5" />}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => setTxnOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Add stock
              </Button>
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1.5 h-4 w-4" />
                Import CSV
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total value"
              value={formatCurrency(metrics.totalValue)}
              sub={`${metrics.holdingCount} positions`}
            />
            <StatCard label="Invested" value={formatCurrency(metrics.totalInvested)} sub="At cost" />
            <StatCard
              label="Unrealised P&L"
              value={formatCurrency(metrics.pnl)}
              trend={metrics.pnlPct}
              tone={metrics.pnl >= 0 ? "gain" : "loss"}
            />
            <StatCard
              label="Largest position"
              value={metrics.topConcentrationSymbol ?? "—"}
              sub={`${metrics.topConcentrationPct.toFixed(1)}% of value`}
              tone={metrics.topConcentrationPct > 25 ? "warning" : "default"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ScoreMeter
              label="Risk score"
              score={metrics.riskScore}
              betterWhenLower
              hint={`Estimated annualised volatility ${metrics.annualisedVolatilityPct.toFixed(1)}% across the dataset.`}
            />
            <ScoreMeter
              label="Diversification score"
              score={metrics.diversificationScore}
              hint="Higher means value is spread across more positions and sectors."
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <SectionHeader title="Sector allocation" description="Share of this portfolio's value by sector." />
              <div className="mt-2">
                <SectorDonut data={metrics.sectorAllocation} />
              </div>
            </Panel>
            <Panel>
              <SectionHeader title="Stock allocation" description="Positions by weight." />
              <div className="mt-2">
                <AllocationBars
                  data={[...holdings]
                    .sort((a, b) => b.allocationPct - a.allocationPct)
                    .map((h) => ({ label: h.symbol, value: h.allocationPct }))}
                />
              </div>
            </Panel>
          </div>

          <Panel>
            <SectionHeader
              title="Holdings"
              description="Every position recorded in this portfolio."
              action={
                <Button size="sm" variant="outline" onClick={() => setTxnOpen(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add stock
                </Button>
              }
            />
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Stock</th>
                    <th className="py-2 pr-3 font-medium">Sector</th>
                    <th className="py-2 pr-3 font-medium">Qty</th>
                    <th className="py-2 pr-3 font-medium">Avg buy</th>
                    <th className="py-2 pr-3 font-medium">Price</th>
                    <th className="py-2 pr-3 font-medium">Value</th>
                    <th className="py-2 pr-3 font-medium">P&L</th>
                    <th className="py-2 pr-3 font-medium">Weight</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {[...holdings]
                    .sort((a, b) => b.allocationPct - a.allocationPct)
                    .map((h) => (
                      <tr key={h.id} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3">
                          <Link to="/holdings/$id" params={{ id: h.id }} className="font-medium hover:text-primary">
                            {h.symbol}
                          </Link>
                          <span className="block text-xs text-muted-foreground">{h.stock.name}</span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{h.stock.sector}</td>
                        <td className="num py-2 pr-3">{h.quantity}</td>
                        <td className="num py-2 pr-3">{formatCurrency(h.avgBuyPrice)}</td>
                        <td className="num py-2 pr-3">{formatCurrency(h.stock.lastPrice)}</td>
                        <td className="num py-2 pr-3">{formatCurrency(h.currentValue)}</td>
                        <td className="py-2 pr-3">
                          <PnlText value={h.pnl} pct={h.pnlPct} />
                        </td>
                        <td className="num py-2 pr-3">{h.allocationPct.toFixed(1)}%</td>
                        <td className="py-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setTxnOpen(true)}
                            aria-label={`Record a trade in ${h.symbol}`}
                          >
                            Trade
                          </Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <SectionHeader title="AI insights" description="Plain-language explanation of the figures above." />
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              {insights.map((insight) => (
                <AiInsightCard key={insight.title} insight={insight} />
              ))}
            </div>
            <div className="mt-3">
              <AiDisclaimer />
            </div>
          </Panel>
        </>
      )}

      <Panel>
        <SectionHeader
          title="Transaction history"
          description="Recorded trades for this portfolio — simulations are never included."
          action={
            <div className="flex items-center gap-2">
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
                <SelectTrigger className="h-8 w-28 text-xs" aria-label="Filter by transaction type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All types</SelectItem>
                  <SelectItem value="BUY">BUY</SelectItem>
                  <SelectItem value="SELL">SELL</SelectItem>
                </SelectContent>
              </Select>
              <Button
                asChild
                size="sm"
                variant="ghost"
              >
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(
                    ["type,symbol,quantity,price,total,date",
                      ...filteredTransactions.map(
                        (t) => `${t.type},${t.symbol},${t.quantity},${t.price},${(t.quantity * t.price).toFixed(2)},${t.executedAt}`,
                      ),
                    ].join("\n"),
                  )}`}
                  download={`${portfolio.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-transactions.csv`}
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  Export
                </a>
              </Button>
            </div>
          }
        />
        <div className="mt-3">
          {transactions.isLoading ? (
            <TableSkeleton rows={4} />
          ) : transactions.isError ? (
            <ErrorState
              title="Transactions unavailable"
              description="We couldn't load activity for this portfolio."
              onRetry={() => transactions.refetch()}
            />
          ) : visibleTransactions.length === 0 ? (
            <EmptyState
              title={typeFilter === "ALL" ? "No transactions recorded" : `No ${typeFilter} transactions`}
              description="Buy and sell activity you record for this portfolio will appear here."
              action={
                <Button size="sm" variant="outline" onClick={() => setTxnOpen(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Record a trade
                </Button>
              }
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Type</th>
                      <th className="py-2 pr-3 font-medium">Stock</th>
                      <th className="py-2 pr-3 font-medium">Qty</th>
                      <th className="py-2 pr-3 font-medium">Price</th>
                      <th className="py-2 pr-3 font-medium">Value</th>
                      <th className="py-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTransactions.map((t) => (
                      <tr key={t.id} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                              t.type === "BUY"
                                ? "border-gain/40 bg-gain/10 text-gain"
                                : "border-loss/40 bg-loss/10 text-loss"
                            }`}
                          >
                            {t.type}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-medium">{t.symbol}</td>
                        <td className="num py-2 pr-3">{t.quantity}</td>
                        <td className="num py-2 pr-3">{formatCurrency(t.price)}</td>
                        <td className="num py-2 pr-3">{formatCurrency(t.quantity * t.price)}</td>
                        <td className="py-2 text-muted-foreground">{formatDateTime(t.executedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredTransactions.length > 10 && (
                <div className="mt-3 text-center">
                  <Button size="sm" variant="ghost" onClick={() => setShowAllTxns((s) => !s)}>
                    {showAllTxns ? "Show fewer" : `Show all ${filteredTransactions.length} transactions`}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      <TransactionDialog
        portfolioId={id}
        holdings={dialogHoldings}
        open={txnOpen}
        onOpenChange={setTxnOpen}
        onDone={handleDone}
      />
      <ImportDialog
        portfolioId={id}
        knownSymbols={knownSymbols}
        open={importOpen}
        onOpenChange={setImportOpen}
        onDone={handleDone}
      />
    </div>
  );
}
