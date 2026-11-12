import { ArrowUpRight, CheckCircle2, AlertTriangle } from "lucide-react";
import type { Channel } from "@/data/verification";
import { statusMeta, formatDate } from "@/lib/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MicrosoftMark, AppleMark } from "./PlatformMark";

function PlatformIcon({ id }: { id: string }) {
  if (id.startsWith("win")) return <MicrosoftMark className="size-4" />;
  return <AppleMark className="size-4" />;
}

export function ChannelCard({ channel }: { channel: Channel }) {
  const meta = statusMeta[channel.status];
  const current = channel.lagVersions === 0;

  return (
    <Card className="gap-3">
      <CardHeader className="grid-cols-[1fr_auto]">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            <PlatformIcon id={channel.id} />
          </span>
          <CardTitle>{channel.label}</CardTitle>
        </div>
        <span
          className={`inline-flex items-center gap-1 text-xs font-medium ${meta.text}`}
        >
          {current ? (
            <CheckCircle2 className="size-3.5" aria-hidden />
          ) : (
            <AlertTriangle className="size-3.5" aria-hidden />
          )}
          {current ? "当前" : `落后 ${channel.lagVersions} 版`}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-base font-medium">{channel.version}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {channel.platform}
          </span>
        </div>

        <div className="flex gap-0.5" role="img" aria-label={`${channel.label} 近 10 日版本状态`}>
          {channel.strip.map((level, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <span
                  className={`h-7 flex-1 rounded-xs ${statusMeta[level].bar}`}
                />
              </TooltipTrigger>
              <TooltipContent>{statusMeta[level].label}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>发布 {formatDate(channel.releaseDate)}</span>
          <a
            href={`https://github.com/TurnX-alt/actdsh/actions/runs/${channel.runId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 font-mono hover:text-foreground hover:underline"
          >
            run {channel.runId}
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}