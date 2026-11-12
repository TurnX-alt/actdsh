import { Package, Lock } from "lucide-react";
import { manifest } from "@/data/verification";
import { Separator } from "@/components/ui/separator";

export function BuildManifest() {
  return (
    <section aria-label="构建清单" className="flex flex-col gap-4">
      <h2 className="text-base font-medium text-muted-foreground">构建依赖清单</h2>
      <div className="flex flex-col gap-5 rounded-2xl bg-card p-6 ring-1 ring-foreground/10">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Lock className="size-5 text-muted-foreground" aria-hidden />
          </span>
          <div className="flex flex-col">
            <span className="text-2xl font-semibold tracking-tight">
              {manifest.pinnedCount}
            </span>
            <span className="text-xs text-muted-foreground">
              个依赖按版本钉死（lockfile 锁定）
            </span>
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Package className="size-4 text-muted-foreground" aria-hidden />
            独立补充依赖
            <span className="text-xs font-normal text-muted-foreground">
              {manifest.independent.length} 个 · 上游清单外单独固定
            </span>
          </div>
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {manifest.independent.map((dep) => (
              <li
                key={dep.name}
                className="flex items-baseline justify-between gap-2 font-mono text-xs"
              >
                <span className="truncate">{dep.name}</span>
                <span className="shrink-0 text-muted-foreground">{dep.version}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}