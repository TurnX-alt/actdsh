import { CheckCircle2, AlertTriangle } from "lucide-react";
import { channels, PROBE_OBSERVED_AT } from "@/data/verification";
import { formatDateTime } from "@/lib/status";
import { Badge } from "@/components/ui/badge";

export function StatusBanner() {
  const reachable = channels.filter((c) => c.status !== "down").length;
  const degraded = channels.filter((c) => c.status === "degraded").length;
  const allUp = degraded === 0 && reachable === channels.length;

  return (
    <section
      aria-label="整体状态"
      className="flex flex-col gap-4 rounded-2xl bg-card p-6 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <span
          className={
            allUp
              ? "mt-0.5 text-status-up-ink"
              : "mt-0.5 text-status-degraded-ink"
          }
        >
          {allUp ? (
            <CheckCircle2 className="size-6" aria-hidden />
          ) : (
            <AlertTriangle className="size-6" aria-hidden />
          )}
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {allUp ? "全部通道与上游一致" : "存在版本漂移"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {reachable}/{channels.length} 通道可达
            {degraded > 0 ? ` · ${degraded} 条落后上游` : " · 无落后通道"}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5 sm:items-end">
        <Badge variant="outline" className="font-mono text-xs">
          {reachable}/{channels.length} 通道可达
        </Badge>
        <span className="text-xs text-muted-foreground">
          探针时间 {formatDateTime(PROBE_OBSERVED_AT)}
        </span>
      </div>
    </section>
  );
}