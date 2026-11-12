import { channels, timeline, timelineDates } from "@/data/verification";
import { statusMeta } from "@/lib/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function DriftTimeline() {
  return (
    <section aria-label="版本漂移时间线" className="flex flex-col gap-4">
      <h2 className="text-base font-medium text-muted-foreground">近 10 日版本漂移</h2>
      <div className="overflow-x-auto rounded-2xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="flex min-w-[560px] flex-col gap-3">
          {channels.map((channel) => (
            <div key={channel.id} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">
                {channel.label}
              </span>
              <div className="flex flex-1 gap-1">
                {timeline.map((row) => {
                  const version = row.versions[channel.id];
                  const level = version === row.upstream ? "up" : "degraded";
                  return (
                    <Tooltip key={row.date}>
                      <TooltipTrigger asChild>
                        <span
                          className={`h-6 flex-1 rounded-xs ${statusMeta[level].bar}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="font-mono">{row.date}</span>
                        <span className="font-mono">{version}</span>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <span className="w-28 shrink-0" />
            <div className="flex flex-1 justify-between gap-1">
              <span className="font-mono text-xs text-muted-foreground">
                {timelineDates[0].slice(5)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {timelineDates[timelineDates.length - 1].slice(5)}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-xs bg-status-up" /> 与上游一致
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-xs bg-status-degraded" /> 落后上游
        </span>
      </div>
    </section>
  );
}