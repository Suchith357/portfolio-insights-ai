import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DemoDataBadge, PnlText, SectionHeader } from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/common/states";
import { Progress } from "@/components/ui/progress";
import { formatCurrency, formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import * as portfolioService from "@/services/portfolio.service";
import type { Portfolio } from "@/types";

export const Route = createFileRoute("/_app/portfolios/")({
  head: () => ({
    meta: [
      { title: "Portfolios — PortfolioIQ" },
      {
        name: "description",
        content:
          "Create, edit and analyse individual portfolios with value, invested amount, profit and loss, risk and diversification scores.",
      },
      { property: "og:title", content: "Portfolios — PortfolioIQ" },
      { property: "og:description", content: "Manage every portfolio and review its risk and diversification." },
    ],
  }),
  component: PortfoliosPage,
});

interface FormState {
  name: string;
  description: string;
}

function validate(form: FormState) {
  const errors: Partial<FormState> = {};
  if (form.name.trim().length < 3) errors.name = "Enter a name with at least 3 characters.";
  if (form.name.trim().length > 60) errors.name = "Keep the name under 60 characters.";
  if (form.description.trim().length > 200) errors.description = "Keep the description under 200 characters.";
  return errors;
}

function PortfoliosPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<Portfolio | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Portfolio | null>(null);
  const [form, setForm] = useState<FormState>({ name: "", description: "" });
  const [errors, setErrors] = useState<Partial<FormState>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const portfolios = useQuery({
    queryKey: ["portfolios", userId],
    queryFn: () => portfolioService.listPortfolios(userId),
    enabled: !!userId,
  });

  const list = useMemo(() => portfolios.data ?? [], [portfolios.data]);

  const views = useQueries({
    queries: list.map((p) => ({
      queryKey: ["portfolio-view", p.id],
      queryFn: () => portfolioService.getPortfolioView(p.id),
    })),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["portfolios"] });
    void queryClient.invalidateQueries({ queryKey: ["portfolio-view"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  const saveMutation = useMutation({
    mutationFn: async (values: FormState) => {
      if (editing) return portfolioService.updatePortfolio(editing.id, values);
      return portfolioService.createPortfolio({ userId, ...values });
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditing(null);
    },
    onError: (err: unknown) =>
      setSubmitError(err instanceof Error ? err.message : "We couldn't save this portfolio. Please try again."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => portfolioService.deletePortfolio(id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
    },
  });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", description: "" });
    setErrors({});
    setSubmitError(null);
    setDialogOpen(true);
  }

  function openEdit(p: Portfolio) {
    setEditing(p);
    setForm({ name: p.name, description: p.description });
    setErrors({});
    setSubmitError(null);
    setDialogOpen(true);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitError(null);
    saveMutation.mutate(form);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolios</h1>
          <p className="text-sm text-muted-foreground">
            Create, review and analyse each portfolio separately. Figures come from the analytics engine.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DemoDataBadge className="hidden sm:inline-flex" />
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            Create portfolio
          </Button>
        </div>
      </div>

      {portfolios.isLoading ? (
        <CardsSkeleton count={2} />
      ) : portfolios.isError ? (
        <ErrorState
          title="We couldn't load your portfolios"
          description="The portfolio service didn't respond. Please try again."
          onRetry={() => portfolios.refetch()}
        />
      ) : list.length === 0 ? (
        <EmptyState
          title="No portfolios yet"
          description="Create your first portfolio to start tracking holdings, risk and diversification."
          icon={<Briefcase className="h-5 w-5" />}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              Create portfolio
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {list.map((p, i) => {
            const view = views[i];
            const metrics = view?.data?.metrics;
            return (
              <article key={p.id} className="panel flex flex-col gap-4 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to="/portfolios/$id"
                      params={{ id: p.id }}
                      className="text-base font-semibold hover:text-primary"
                    >
                      {p.name}
                    </Link>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {p.description || "No description added."}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" aria-label="Edit portfolio" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete portfolio"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleting(p)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {view?.isError ? (
                  <ErrorState
                    title="Analytics unavailable"
                    description="We couldn't compute this portfolio's summary."
                    onRetry={() => view.refetch()}
                  />
                ) : !metrics ? (
                  <CardsSkeleton count={2} />
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total value</p>
                        <p className="num mt-1 font-semibold">{formatCurrency(metrics.totalValue)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Invested</p>
                        <p className="num mt-1 font-semibold">{formatCurrency(metrics.totalInvested)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Unrealised P&L</p>
                        <p className="mt-1">
                          <PnlText value={metrics.pnl} pct={metrics.pnlPct} />
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="flex items-baseline justify-between text-xs">
                          <span className="text-muted-foreground">Risk score</span>
                          <span className="num font-medium">{metrics.riskScore.toFixed(1)}/100</span>
                        </div>
                        <Progress value={metrics.riskScore} className="mt-1.5 h-1.5" />
                      </div>
                      <div>
                        <div className="flex items-baseline justify-between text-xs">
                          <span className="text-muted-foreground">Diversification</span>
                          <span className="num font-medium">{metrics.diversificationScore.toFixed(1)}/100</span>
                        </div>
                        <Progress value={metrics.diversificationScore} className="mt-1.5 h-1.5" />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                      <span>
                        {metrics.holdingCount} holding{metrics.holdingCount === 1 ? "" : "s"} · created{" "}
                        {formatDate(p.createdAt)}
                      </span>
                      <Button asChild size="sm" variant="outline">
                        <Link to="/portfolios/$id" params={{ id: p.id }}>
                          Open portfolio
                        </Link>
                      </Button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit portfolio" : "Create portfolio"}</DialogTitle>
              <DialogDescription>
                Portfolios group holdings so risk and diversification can be measured separately.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pf-name">Portfolio name</Label>
                <Input
                  id="pf-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Long-term equity"
                  aria-invalid={!!errors.name}
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-desc">Description</Label>
                <Textarea
                  id="pf-desc"
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What is this portfolio for?"
                  aria-invalid={!!errors.description}
                />
                {errors.description && <p className="text-xs text-destructive">{errors.description}</p>}
              </div>
              {submitError && <p className="text-sm text-destructive">{submitError}</p>}
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving…" : editing ? "Save changes" : "Create portfolio"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the portfolio along with its holdings and recorded transactions. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleting) deleteMutation.mutate(deleting.id);
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete portfolio"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SectionHeader
        title=""
        description="Values shown are computed from the synthetic demo dataset, not live market prices."
      />
    </div>
  );
}
