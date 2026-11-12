# actdsh 校验面板

actdsh 发行链路的独立校验视图：官方通道可达性与版本漂移、官方产物 sha512 门禁、
钉死依赖构建清单。静态单页，数据取自每日探针与构建记录的真实快照。

## 本地开发

```sh
pnpm install
pnpm dev
```

## 构建

```sh
pnpm build      # 产物在 dist/
pnpm preview
```

## 技术栈

React + TypeScript + Vite，shadcn/ui，Tailwind v4，oklch 设计令牌。功能图标用
lucide，平台品牌标用 Microsoft / Apple 官方形状。

## 数据与说明

快照见 `src/data/verification.ts`；产品说明见 `PRODUCT.md`。