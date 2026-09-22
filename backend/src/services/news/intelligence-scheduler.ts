/**
 * Intelligence scheduler (Phase 1) — deliberately SEPARATE from the
 * market-data scheduler so the 45-minute Yahoo cadence is untouched.
 *
 *   news fetch : every NEWS_FETCH_INTERVAL_MINUTES  (default 30, min 15)
 *   cleanup    : every NEWS_CLEANUP_INTERVAL_MINUTES (default 60, min 10)
 *
 * Startup runs happen after short delays so server boot is never blocked on
 * the network; every tick catches its own errors (a provider outage logs a
 * warning and is retried next tick). Returns a stop function for shutdown.
 */
import { env } from "../../utils/env.js";
import { runIngest, isIngestRunning } from "./news-ingest.js";
import { cleanupExpiredIntelligenceData } from "./intelligence-cleanup.js";
import { processRecentEvents } from "./event-impact.service.js";
import { deliverAlerts, isAlertDeliveryRunning } from "./alert-delivery.service.js";
import { runDailySnapshots } from "./../risk-snapshot.service.js";
import { runAnomalyScan } from "./../market-anomaly.service.js";

export function startIntelligenceScheduler(): () => void {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const startupTimeouts: Array<ReturnType<typeof setTimeout>> = [];

  // ---- news ingest -------------------------------------------------------
  const ingestTick = async (trigger: "SCHEDULED" | "STARTUP") => {
    if (isIngestRunning()) return; // never overlap
    try {
      // Startup keeps to the broad feed only (fast, gentle on the free
      // provider); scheduled runs add a few per-company scans.
      const companyScans = trigger === "STARTUP" ? 0 : 4;
      const summary = await runIngest({ trigger, companyScans });
      console.log(
        `[intelligence] ${trigger} ingest ${summary.status} via ${summary.provider}` +
          (summary.degradedFrom ? ` (degraded from ${summary.degradedFrom})` : "") +
          `: fetched=${summary.fetched} stored=${summary.stored} dupes=${summary.duplicates}` +
          ` entities=${summary.entitiesMatched} events=${summary.eventsCreated} failures=${summary.failures}` +
          (summary.message ? ` — ${summary.message}` : ""),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("already running")) return;
      console.error("[intelligence] ingest tick failed:", error instanceof Error ? error.message : error);
    }

    // Phase 3 pipeline: after each successful ingest, map exposures and
    // deliver alerts. Both steps are single-flight and error-contained.
    await exposureTick(trigger);
  };

  const exposureTick = async (trigger: "SCHEDULED" | "STARTUP" | "MANUAL") => {
    try {
      const exposureSummary = await processRecentEvents(25);
      console.log(
        `[intelligence] ${trigger} exposure ${exposureSummary.status}: impacts +${exposureSummary.impactsCreated}/~${exposureSummary.impactsUpdated} events promoted=${exposureSummary.eventsPromoted} failures=${exposureSummary.eventsFailed}`,
      );
      const deliverySummary = await deliverAlerts();
      console.log(
        `[intelligence] ${trigger} alert delivery ${deliverySummary.status}: candidates=${deliverySummary.candidatesConsidered} created=${deliverySummary.alertsCreated} dup-skipped=${deliverySummary.skippedDuplicate} cooldown-skipped=${deliverySummary.skippedCooldown} failures=${deliverySummary.failures.length}`,
      );
    } catch (error) {
      console.error("[intelligence] exposure/delivery tick failed:", error instanceof Error ? error.message : error);
    }
  };

  // First fetch ~15s after boot (after the server binds), then the interval.
  startupTimeouts.push(setTimeout(() => void ingestTick("STARTUP"), 15_000));
  timers.push(setInterval(() => void ingestTick("SCHEDULED"), env.newsFetchIntervalMinutes * 60_000));

  // ---- cleanup -----------------------------------------------------------
  const cleanupTick = async () => {
    try {
      const summary = await cleanupExpiredIntelligenceData();
      const total =
        summary.articlesDeleted + summary.entitiesDeleted + summary.eventsDeleted + summary.eventEntitiesDeleted;
      if (total > 0 || summary.errors.length > 0) {
        console.log(
          `[intelligence] cleanup: articles=${summary.articlesDeleted} entities=${summary.entitiesDeleted}` +
            ` events=${summary.eventsDeleted} event_entities=${summary.eventEntitiesDeleted}` +
            (summary.errors.length > 0 ? ` errors=${summary.errors.length}` : ""),
        );
      }
    } catch (error) {
      console.error("[intelligence] cleanup tick failed:", error instanceof Error ? error.message : error);
    }
  };

  // ---- Req 1: market anomaly detection ------------------------------------
  // Runs with every ingest tick (startup + 45-min cadence): deterministic
  // z-score scan of latest price moves vs 90-day history, alerting holders
  // of affected stocks/sectors. Single-flight; failure-contained.
  const anomalyTick = async (trigger: "SCHEDULED" | "STARTUP" | "MANUAL") => {
    try {
      await runAnomalyScan(trigger);
    } catch (error) {
      console.error("[intelligence] anomaly tick failed:", error instanceof Error ? error.message : error);
    }
  };
  startupTimeouts.push(setTimeout(() => void anomalyTick("STARTUP"), 100_000));
  timers.push(setInterval(() => void anomalyTick("SCHEDULED"), env.newsFetchIntervalMinutes * 60_000));

  // First cleanup ~90s after boot, then its own interval.
  startupTimeouts.push(setTimeout(() => void cleanupTick(), 90_000));
  timers.push(setInterval(() => void cleanupTick(), env.newsCleanupIntervalMinutes * 60_000));

  // ---- Phase 7: daily risk snapshots -------------------------------------
  // Idempotent (UNIQUE portfolio/day/version): running hourly costs one
  // no-op pass and guarantees the day's snapshot exists even if the process
  // restarted. NEVER more frequent than hourly, NEVER heavy.
  const snapshotTick = async () => {
    try {
      const s = await runDailySnapshots();
      if (s.snapshotsWritten > 0 || s.failures > 0) {
        console.log(
          `[intelligence] risk snapshots: written=${s.snapshotsWritten} dup-skipped=${s.duplicatesSkipped} failures=${s.failures}`,
        );
      }
    } catch (error) {
      console.error("[intelligence] snapshot tick failed:", error instanceof Error ? error.message : error);
    }
  };
  startupTimeouts.push(setTimeout(() => void snapshotTick(), 120_000));
  timers.push(setInterval(() => void snapshotTick(), 60 * 60_000));

  return () => {
    for (const t of startupTimeouts) clearTimeout(t);
    for (const t of timers) clearInterval(t);
  };
}
