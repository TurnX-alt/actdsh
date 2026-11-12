import { ShieldCheck, ArrowUpRight } from "lucide-react";
import { sha512Gate } from "@/data/verification";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function Sha512Gate() {
  return (
    <section aria-label="sha512 门禁" className="flex flex-col gap-4">
      <h2 className="text-base font-medium text-muted-foreground">sha512 字节门禁</h2>
      <div className="flex flex-col gap-4 rounded-2xl bg-card p-6 ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-status-up-ink" aria-hidden />
            <span className="text-base font-medium">最近一次门禁通过</span>
          </div>
          <Badge variant="outline" className="text-status-up-ink">
            success
          </Badge>
        </div>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">运行日期</dt>
            <dd className="font-mono text-sm">{sha512Gate.runDate}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">发布 run</dt>
            <dd className="font-mono text-sm">{sha512Gate.runId}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">sha512 前缀</dt>
            <dd className="font-mono text-sm">{sha512Gate.sha512Prefix}…</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          门禁对官方分发字节做 sha512 校验，失败即中止打包（fail-closed）。下方链接指向
          产生该哈希的真实运行，可核对完整日志与产物。
        </p>
        <div>
          <Button asChild variant="default" className="rounded-full">
            <a href={sha512Gate.artifactUrl} target="_blank" rel="noreferrer">
              查看校验运行
              <ArrowUpRight className="size-3.5" data-icon="inline-end" aria-hidden />
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}