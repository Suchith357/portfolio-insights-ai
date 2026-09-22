/**
 * AI Deep Analysis panel (Prompt 4 + Requirements 4–6, 8–10).
 *
 * The panel is now a JOB CLIENT, not the analysis owner:
 *
 *   Run AI Deep Analysis → POST start → jobId
 *     → poll GET /ai/stock/jobs/:jobId every 2.5s
 *     → lifecycle states render as progress (STARTED → FETCHING_DATA →
 *       ANALYZING → GENERATING_INSIGHTS → COMPLETED | FAILED)
 *
 * Because only the backend runs the analysis, the user may navigate to Risk
 * Analysis, switch pages, minimize the tab or leave the site entirely — the
 * run continues. On remount (user returns) the panel queries jobs/latest and
 * resumes rendering the in-progress or completed result. This component
 * NEVER navigates the user anywhere.
 *
 * Metric explanations (Req 8): every number in the factor grid carries a
 * beginner-friendly meaning line from explainFactor().
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, ExternalLink, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import * as researchService from "@/services/research.service";
import type { ResearchReport, ResearchFactor, JobStatus } from "@/services/research.service";

const POLL_MS = 2_500;

/** Human phrasing for each lifecycle state. */
const STAGE_LABEL: Record<JobStatus, string> = {
  STARTED: "Starting…",
  FETCHING_DATA: "Gathering market data, financials and news…",
  ANALYZING: "Analysing evidence and computing factors…",
  GENERATING_INSIGHTS: "Writing the research narrative…",
  COMPLETED: "Analysis complete",
  FAILED: "Analysis failed",
};

/**
 * Req 8: beginner-friendly explanation for every deterministic factor shown
 * in the report. Keyed by factor name from decision-engine-v1.
 */
function explainFactor(name: string): string | null {
  switch (name) {
    case "financial_quality":
      return "How the valuation looks: P/E, dividend and size. Higher = market pricing looks more reasonable.";
    case "fy_growth":
      return "Year-over-year change in revenue and profit from the company's own statements. Higher = the business is growing.";
    case "momentum":
      return "Recent price direction across 1–12 months. Higher = the trend has been upward.";
    case "risk":
      return "How violently the price swings and how deep past falls were. Higher = calmer price behaviour.";
    case "relative_performance":
      return "The stock's 1-year return compared with the NIFTY 50. Higher = beating the index.";
    case "news_outlook":
      return "Direction of significant recent news events. Higher = net positive coverage.";
    case "evidence_quality":
      return "How complete and trustworthy the underlying data was. Higher = more of the report rests on solid data.";
    default:
      return null;
  }
}

export function AiResearchPanel({ symbol }: { symbol: string }) {
  const upper = symbol.toUpperCase();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"BUY" | "PORTFOLIO">("BUY");
  const [ask, setAsk] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const activeJobRef = useRef<string | null>(null);

  // Resume-on-return: on first mount ask the backend for this symbol's most
  // recent job. If one is running, we re-attach the polling; if one is
  // completed/failed, we render it immediately. Never navigates anywhere.
  const latest = useQuery({
    queryKey: ["research-job", "latest", upper, mode],
    queryFn: () => researchService.getLatestAnalysis(upper, mode),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const resumedJob = latest.data ?? null;
  const resumedIsFresh = resumedJob !== null && Date.now() - Date.parse(resumedJob.createdAt) < 15 * 60_000;

  // Poll the active job. Enabled only while a job exists and is not terminal;
  // if the user navigated away and back, this simply re-attaches.
  const activeJobId = activeJobRef.current ?? (resumedIsFresh && resumedJob && !isTerminal(resumedJob.status) ? resumedJob.jobId : null);
  const jobQuery = useQuery({
    queryKey: ["research-job", activeJobId],
    queryFn: () => researchService.getAnalysisJob(activeJobId!),
    enabled: !!activeJobId,
    refetchInterval: (query) => {
      const data = query.state.data as researchService.AnalysisJobView | undefined;
      return data && !isTerminal(data.status) ? POLL_MS : false;
    },
  });

  const job = jobQuery.data ?? (activeJobId ? null : resumedIsFresh ? resumedJob : null);
  const report: ResearchReport | null = job?.report?.status === "OK" ? job.report.report : null;
  const unavailable = job?.report?.status === "UNAVAILABLE" ? job.report.reason : job?.error ?? null;
  const running = !!job && !isTerminal(job.status);

  // Invalidate once when a job completes so cached panel state refreshes.
  const completedRef = useRef(false);
  useEffect(() => {
    if (job?.status === "COMPLETED" && !completedRef.current) {
      completedRef.current = true;
      void qc.invalidateQueries({ queryKey: ["research-job", "latest", upper] });
    }
    if (job && !isTerminal(job.status)) completedRef.current = false;
  }, [job?.status, job, qc, upper]);

  async function start() {
    setStartError(null);
    setStarting(true);
    try {
      const { jobId } = await researchService.startAnalysis(upper, mode, ask.trim() || undefined);
      activeJobRef.current = jobId;
      completedRef.current = false;
      // Seed the poll cache and attach immediately.
      qc.setQueryData(["research-job", jobId], {
        jobId,
        symbol: upper,
        mode,
        status: "STARTED" as JobStatus,
        stageDetail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: null,
        report: null,
        error: null,
      });
      await jobQuery.refetch();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Could not start the analysis.");
    } finally {
      setStarting(false);
    }
  }

  const decisionColor =
    report?.recommendation.decision === "BUY"
      ? "text-gain"
      : report?.recommendation.decision === "AVOID"
        ? "text-loss"
        : "text-muted-foreground";

  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">AI Deep Analysis</h2>
          <Badge variant="outline" className="text-[10px]">Qwen3-4B · local · grounded</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Runs in the background on the server — you can freely navigate to other pages or close the tab; when you
          come back, the result is waiting here. Evidence-based decision support: not personalized financial advice,
          not a prediction, nothing is executed.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={(v) => setMode(v as "BUY" | "PORTFOLIO")}>
            <SelectTrigger className="h-8 w-[240px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="BUY">Should I buy this stock?</SelectItem>
              <SelectItem value="PORTFOLIO">Is it good for MY portfolio?</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-8 max-w-sm"
            placeholder="Optional: ask e.g. “Is TCS attractive at the current price?”"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
          />
          <Button size="sm" onClick={() => void start()} disabled={starting || running}>
            {running ? "Analysing…" : report ? "Re-run analysis" : "Run AI Deep Analysis"}
          </Button>
        </div>

        {(running || (job && job.status !== "COMPLETED")) && (
          <div
            className="rounded-md border border-info/40 bg-info/5 px-3 py-2 text-xs"
            role="status"
            aria-live="polite"
            data-testid="research-job-progress"
          >
            <p className="font-medium">{STAGE_LABEL[job!.status] ?? "Working…"}</p>
            {job?.stageDetail && <p className="mt-0.5 text-muted-foreground">{job.stageDetail}</p>}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Started {job ? formatDateTime(job.createdAt) : ""} · this continues even if you leave the page. Job
              <span className="num"> {job?.jobId.slice(0, 8)}</span>…
            </p>
          </div>
        )}
        {startError && <p className="text-xs text-loss">{startError}</p>}
        {(jobQuery.isError || latest.isError) && !running && (
          <p className="text-xs text-loss">Could not check the analysis status. Is the backend running?</p>
        )}
        {unavailable && !running && (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            AI research unavailable: {unavailable} The quantitative tabs remain fully available.
          </p>
        )}
        {report?.meta.cached && (
          <p className="text-[11px] text-muted-foreground">Report reused from the evidence cache (nothing changed since the last run).</p>
        )}
        {job?.finishedAt && job.status === "COMPLETED" && (
          <p className="text-[11px] text-muted-foreground">Completed {formatDateTime(job.finishedAt)}.</p>
        )}
      </section>

      {report && (
        <>
          <section className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("text-xl font-bold", decisionColor)}>{report.recommendation.decision}</span>
              <Badge variant="outline">score {report.recommendation.score}/100</Badge>
              <Badge variant="outline">confidence {(report.recommendation.confidence * 100).toFixed(0)}%</Badge>
              <Badge variant="outline">risk {report.recommendation.riskLevel}</Badge>
              <Badge variant="outline">{report.stock.symbol}</Badge>
            </div>
            <p className="mt-2 text-sm">{report.executive_summary}</p>
            {report.metric_explanations?.length > 0 && (
              <div className="mt-3 rounded-md border border-border/60 p-3">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Info className="h-3.5 w-3.5" aria-hidden /> What these numbers mean
                </h4>
                <dl className="mt-2 grid gap-2.5 md:grid-cols-2">
                  {report.metric_explanations.map((m) => (
                    <div key={m.metric} className="rounded-md bg-muted/30 px-3 py-2">
                      <dt className="text-xs font-semibold">
                        {m.metric}: <span className="num">{m.value}</span>
                      </dt>
                      <dd className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                        <p><span className="font-medium text-foreground">Meaning:</span> {m.meaning}</p>
                        <p><span className="font-medium text-foreground">Higher →</span> {m.higherMeans}. <span className="font-medium text-foreground">Lower →</span> {m.lowerMeans}.</p>
                        <p className="text-foreground/90"><span className="font-medium">Read:</span> {m.interpretation}</p>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {report.meta.factors.map((f) => (
                <FactorCard key={f.name} factor={f} />
              ))}
            </div>
            {report.meta.confidenceReasons.length > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Confidence reduced by: {report.meta.confidenceReasons.join("; ")}.
              </p>
            )}
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {report.decision_reasoning.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <ReportCard title="Current situation">{report.current_situation}</ReportCard>
            <ReportCard
              title="Financial analysis"
              factors={report.financial_analysis.positive_factors}
              negatives={report.financial_analysis.negative_factors}
              footer={report.financial_analysis.valuation}
            >
              {report.financial_analysis.summary}
            </ReportCard>
            <ReportCard title="Performance" footer={report.performance_analysis.relative_to_benchmark}>
              {report.performance_analysis.summary}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {report.performance_analysis.periods.map((p) => (
                  <Badge key={p.period} variant="outline" className="text-[10px]">
                    {p.period}: {p.pct === null ? "n/a" : `${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(1)}%`}
                  </Badge>
                ))}
              </div>
            </ReportCard>
            <ReportCard title="Risk">
              {report.risk_analysis.summary}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[10px]">vol {report.risk_analysis.volatility?.toFixed(1) ?? "n/a"}%</Badge>
                <Badge variant="outline" className="text-[10px]">maxDD {report.risk_analysis.drawdown?.toFixed(1) ?? "n/a"}%</Badge>
                <Badge variant="outline" className="text-[10px]">beta {report.risk_analysis.beta?.toFixed(2) ?? "n/a"}</Badge>
              </div>
            </ReportCard>
            <ReportCard
              title={`News & events (${report.news_analysis.overall_direction.toLowerCase()})`}
              factors={report.news_analysis.positive_factors}
              negatives={report.news_analysis.negative_factors}
            >
              {report.news_analysis.summary}
              {report.news_analysis.important_events.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {report.news_analysis.important_events.map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              )}
            </ReportCard>
            <ReportCard title="Sector / macro" factors={report.sector_macro_analysis.factors}>
              {report.sector_macro_analysis.summary}
            </ReportCard>
            <ReportCard title={`Historical context (${report.historical_context.sample_size} events)`}>
              {report.historical_context.summary}
            </ReportCard>
          </div>

          <section className="panel p-4">
            <h3 className="text-sm font-semibold">Scenarios — hypothetical, not predictions</h3>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {(["bull", "base", "bear"] as const).map((k) => (
                <div key={k} className="rounded-md border p-3">
                  <h4 className={cn("text-xs font-semibold uppercase", k === "bull" ? "text-gain" : k === "bear" ? "text-loss" : "text-muted-foreground")}>
                    {k} case
                  </h4>
                  <p className="mt-1 text-xs">{report.scenarios[k].narrative}</p>
                  {report.scenarios[k].drivers.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">Drivers: {report.scenarios[k].drivers.join("; ")}</p>
                  )}
                  {report.scenarios[k].invalidators.length > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground">Invalidated if: {report.scenarios[k].invalidators.join("; ")}</p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <ReportCard title="What to watch">
              <ul className="space-y-1 text-xs">{report.what_to_watch.map((w, i) => <li key={i}>• {w}</li>)}</ul>
            </ReportCard>
            <ReportCard title={`Evidence (${report.evidence.length})`}>
              <ul className="space-y-1.5 text-xs">
                {report.evidence.map((e) => (
                  <li key={e.id}>
                    [{e.id}] {e.title} —{" "}
                    <span className="text-muted-foreground">
                      {e.source}
                      {e.published_at ? `, ${formatDate(e.published_at)}` : ""}
                    </span>
                    {e.url && (
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline">
                        source<ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </ReportCard>
          </div>

          <section className="panel p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Limitations</h3>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {report.limitations.map((l, i) => <li key={i}>• {l}</li>)}
            </ul>
            <p className="mt-3 text-[11px] text-muted-foreground">
              PortfolioIQ provides evidence-based financial analysis for research and decision support. It does not
              guarantee future performance and should not be treated as personalized financial advice.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function isTerminal(status: JobStatus): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

/** Req 8: factor card with value + one-line meaning + interpretation. */
function FactorCard({ factor }: { factor: ResearchFactor }) {
  const meaning = explainFactor(factor.name);
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <span className="font-semibold">{factor.name.replace(/_/g, " ")}: {factor.score}/100</span>
      {!factor.dataAvailable && <span className="ml-1 text-warning">(no data)</span>}
      <p className="text-muted-foreground">{factor.detail}</p>
      {meaning && (
        <p className="mt-0.5 flex items-start gap-1 text-[11px] text-muted-foreground/90">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>
            {meaning}{" "}
            <span className="opacity-80">
              Possible read: {factor.score >= 65 ? "this factor supports the stock" : factor.score <= 40 ? "this factor weighs against the stock" : "this factor is roughly neutral"}.
            </span>
          </span>
        </p>
      )}
    </div>
  );
}

function ReportCard({
  title,
  children,
  factors,
  negatives,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  factors?: string[];
  negatives?: string[];
  footer?: string;
}) {
  return (
    <section className="panel p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-1.5 text-xs">{children}</div>
      {factors && factors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-gain">{factors.map((f, i) => <li key={i}>+ {f}</li>)}</ul>
      )}
      {negatives && negatives.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-loss">{negatives.map((f, i) => <li key={i}>− {f}</li>)}</ul>
      )}
      {footer && <p className="mt-2 text-[11px] text-muted-foreground">{footer}</p>}
    </section>
  );
}
