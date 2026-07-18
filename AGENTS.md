# Repository Instructions

## Non-Negotiable Local Price Parsing Boundary

All Taobao and Tmall product-price captures must keep this sequence:

1. Load the product only in the user's authorized account browser profile.
2. Collect the browser-observed HTML, visible text, and relevant response bodies.
3. Remove cookies, authorization values, tokens, signatures, account identity, and other secrets.
4. Atomically write the sanitized evidence to a local file and close the write.
5. Read that file back from disk.
6. Parse SKU and price data only from the reloaded local evidence.

The Node/backend process must never request Taobao or Tmall product, price, promotion, or review endpoints directly. Do not add a direct-request fallback, even if the browser response is incomplete.

The seven independent price channels are `normal`, `gift`, `government`, `coin`, `seckill`, `billion`, and `surprise`; `vip88` remains an additional account-only channel. A channel may be emitted only when current-SKU evidence and its calculation formula close exactly to the cent. Missing or ambiguous evidence must produce an unavailable value and preserve the last verified snapshot separately. Never substitute list price, a historical price, another account's price, a product-specific constant, or a guessed value.

Any change to capture or price parsing must retain tests that prove:

- the scraper source has no Node-side `fetch` escape hatch;
- browser evidence is sanitized, saved, and read from disk before parsing;
- unverified evidence cannot create a displayable or alertable price;
- each account type and price channel remains isolated.
