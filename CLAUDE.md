# Project Instructions

## Tech Stack

- React 19 + TypeScript + Vite frontend.
- Node.js + Express backend.
- Chrome DevTools Protocol for authenticated Tmall/Taobao capture.
- JSON storage in `server/data/db.json`.

## Project Structure

- `server/index.js`: HTTP routes and process startup.
- `server/services/`: capture, browser, monitoring, and analysis services.
- `server/storage/`: JSON persistence.
- `src/features/`: React feature areas.
- `src/types/`: shared frontend contracts.
- `scripts/`: maintenance and diagnostics.

## Code Style

- Use ESM imports and `async`/`await`.
- Keep parsing and media selection in `tmallScraper.js`; keep orchestration in `monitorService.js`.
- Prefer existing helpers and domain types over new parallel abstractions.
- Preserve real seller data. Do not invent prices, videos, or empty media placeholders.

## Testing and Verification

- `npm test`
- `npm run lint`
- `npm run build`

Add focused scraper tests in `server/services/tmallScraper.test.js` when changing extraction rules.

## Important Media Contract

- `mainImage800` comes from the mobile detail API 1:1 image.
- `gallery750Images` contains the five PC detail gallery images.
- Keep placeholder, unrelated seller, and invalid video URLs filtered.

## Runtime

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4317`
- Do not expose cookies or browser profiles from `server/data`.
