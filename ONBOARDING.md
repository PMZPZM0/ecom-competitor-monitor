# Tmall Competitor Monitor Onboarding

## Overview

This project is a local Tmall/Taobao competitor monitor. It captures product pages through a reusable Chrome login session, stores snapshots in a JSON database, and presents prices, SKU data, media, and trends in a React dashboard.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS |
| Backend | Node.js, Express 5 |
| Browser access | Chrome DevTools Protocol with a per-account profile |
| Storage | `server/data/db.json` |
| Media | `sharp`, `jszip` |
| Tests | Node test runner |

## Architecture

```text
React UI -> /api routes -> monitorService -> tmallScraper
                                      -> browserService / Chrome
                                      -> Tmall PC HTML + mobile detail API
                         -> server/data/db.json
```

`mainImage800` is sourced from the mobile detail API's `item.images` (the authoritative 1:1 image). `gallery750Images` comes from the PC detail gallery. SKU images, detail images, and videos are filtered separately.

## Key Entry Points

- `server/index.js`: Express routes, capture/download endpoints, scheduler startup.
- `server/services/monitorService.js`: capture orchestration and snapshot persistence.
- `server/services/tmallScraper.js`: Tmall parsing, mobile API signing, media selection, SKU and price extraction.
- `server/services/browserService.js`: Chrome profile lifecycle and rendered HTML capture.
- `server/storage/db.js`: JSON database reads and writes.
- `src/App.tsx`: frontend shell and feature routing.
- `src/features/products/ProductMonitorCard.tsx`: product card and snapshot actions.
- `src/features/classification/MonitorClassification.tsx`: grouped monitoring view.
- `src/features/products/productDisplayUtils.ts`: media and price display rules.
- `src/types/domain.ts`: frontend snapshot/product contracts.

## Request Lifecycle

1. `POST /api/products/:id/capture` enters `server/index.js`.
2. `monitorService` selects the enabled account session and calls `scrapeTmallProduct`.
3. `tmallScraper` loads rendered PC HTML, then calls the signed mobile detail API for the 1:1 main image.
4. The scraper extracts prices, SKUs, gallery/detail media, and real videos.
5. `monitorService` persists the snapshot and returns it to the UI.
6. React renders the snapshot through the product display helpers.

## Conventions

- Backend modules use ESM, `async`/`await`, and narrow service responsibilities.
- React components use PascalCase filenames; shared helpers use camelCase.
- Boundary data is validated in `server/index.js` with Zod where applicable.
- Tests live beside the scraper as `*.test.js` and use `node:test`.
- Keep real media only; do not synthesize prices, videos, or placeholder images.

## Common Commands

- `npm run dev`: start frontend and backend.
- `npm test`: run scraper tests.
- `npm run lint`: run Oxlint.
- `npm run build`: type-check and build the frontend.
- `node "C:\\Users\\Administrator\\.codex\\skills\\codegraph\\analyze.js" . graph.json`: refresh the code graph.

## Where To Look

| Goal | Files |
| --- | --- |
| Change image selection | `server/services/tmallScraper.js` |
| Change capture scheduling | `server/services/monitorService.js` |
| Add an API route | `server/index.js` |
| Change product card UI | `src/features/products/ProductMonitorCard.tsx` |
| Change media/price display rules | `src/features/products/productDisplayUtils.ts` |
| Change snapshot contracts | `src/types/domain.ts` |
