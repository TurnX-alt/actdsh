import { useState } from "react";
import { channels } from "@/data/verification";
import { ChannelCard } from "./ChannelCard";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Filter = "all" | "up" | "degraded";

export function ChannelsSection() {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = channels.filter((c) =>
    filter === "all" ? true : c.status === filter,
  );

  return (
    <section aria-label="官方通道" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium text-muted-foreground">官方分发通道</h2>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList variant="line">
            <TabsTrigger value="all" className="px-2.5 text-xs">
              全部
            </TabsTrigger>
            <TabsTrigger value="up" className="px-2.5 text-xs">
              当前
            </TabsTrigger>
            <TabsTrigger value="degraded" className="px-2.5 text-xs">
              落后
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c) => (
          <ChannelCard key={c.id} channel={c} />
        ))}
      </div>
      {visible.length === 0 && (
        <p className="rounded-xl bg-card p-6 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
          该类别下暂无通道
        </p>
      )}
    </section>
  );
}