# Market Shaker AI — Phase 2 Demo Lab

A browser-based, live Deriv tick scanner plus a protected **demo-only** options trading terminal.

- Working public Deriv tick chart and last-digit distribution (V10, V25, V50, V75, V100, V10 1s, V100 1s).
- Private demo account login using a server-stored PAT, registered PAT app ID and Deriv's short-lived OTP demo WebSocket.
- Manual Over 1, Under 8, Differs 5 and Matches 5 digit contracts (1-tick duration).
- Experimental rules-based demo automation, sequential repeat orders (max 3), trade history and session risk controls.
- Login protection, same-origin requests and anti-retry protection for uncertain buys.

**Not trained AI. Not verified profitable. Not ready for real trading or unattended cloud auto trading.** No production database; free hosting may restart and reset session caps.

## Windows/local

Node.js 22+. `npm test`, `npm start`. For offline chart simulation use `npm run dev:synthetic`, which **disables all demo order execution**. Environment variable instructions and Render deployment guide in `DEPLOY-ON-RENDER.md`.
