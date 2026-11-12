import { Activity, FolderGit2 } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/panel/StatusBanner";
import { ChannelsSection } from "@/components/panel/ChannelsSection";
import { DriftTimeline } from "@/components/panel/DriftTimeline";
import { Sha512Gate } from "@/components/panel/Sha512Gate";
import { BuildManifest } from "@/components/panel/BuildManifest";
import { TransparencyTable } from "@/components/panel/TransparencyTable";

function App() {
  return (
    <TooltipProvider>
      <div className="dot-grid min-h-screen w-full">
        <div className="mx-auto flex max-w-[880px] flex-col gap-10 px-5 py-12 sm:px-8">
          <header className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Activity className="size-4" aria-hidden />
              </span>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold tracking-tight">actdsh 校验面板</span>
                <span className="text-xs text-muted-foreground">独立分发校验视图</span>
              </div>
            </div>
            <Button asChild variant="outline" className="rounded-full">
              <a
                href="https://github.com/TurnX-alt/actdsh"
                target="_blank"
                rel="noreferrer"
              >
                <FolderGit2 className="size-3.5" data-icon="inline-start" aria-hidden />
                仓库
              </a>
            </Button>
          </header>

          <main className="flex flex-col gap-10">
            <StatusBanner />
            <ChannelsSection />
            <DriftTimeline />
            <Sha512Gate />
            <BuildManifest />
            <TransparencyTable />
          </main>

          <footer className="border-t border-border pt-6 text-xs text-muted-foreground">
            actdsh · deepseek-harness 第三方 Windows 便携发行 · 校验数据可独立核对
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;