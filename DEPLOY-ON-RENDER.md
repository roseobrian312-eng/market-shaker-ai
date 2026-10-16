# Market Shaker AI — Phase 2 Demo Lab (Render Free)

This ZIP **updates your existing** `market-shaker-ai` GitHub repository, preserving the functioning V100 live feed. It is not a production-ready 24/7 trading service.

## 1. Upload this update to GitHub

1. Download the Phase 2 ZIP and extract it.
2. Open your existing GitHub repository `market-shaker-ai` → **Add file → Upload files**.
3. Drag **all the files and directories inside the extracted folder** (`public`, `src`, `test`, `server.js`, `package.json`, etc.) into GitHub; overwrite matching files. Do not upload the ZIP itself, and do not create an extra folder above `server.js`.
4. Commit changes on the `main` branch.
5. Render should redeploy automatically. If not: Render → your service → Manual Deploy → Deploy latest commit.
6. Keep **Build command** `npm install && npm test`, **Start command** `npm start`, **instance Free**.

## 2. Configure protected DEMO trading (not necessary for market scanner)

In Render: service → **Environment** → add these **secret environment variables**, then Save, rebuild/redeploy:

| Key | Value | Guidance |
|---|---|---|
| `DASHBOARD_PASSWORD` | Your own 12+ character secret passphrase | Needed to unlock protected trading endpoints. Avoid simple passwords. |
| `DERIV_APP_ID` | Your registered **PAT application ID** | Get this in your Deriv developer app dashboard. The old shared `1089` public scanner app ID is not your PAT app ID. |
| `DERIV_PAT` | Personal access token with **trade** scope | Generate privately in Deriv; use demo-only or tightly scoped credentials where available. Never paste into GitHub or this chat. |
| `DERIV_DEMO_ACCOUNT_ID` | Optional, a genuine demo Options account ID e.g. `DOT...` | Recommended if you have multiple accounts. The server checks the account list and refuses real accounts. |

Public market data requires no credentials. The app will not accept real-account connections or execute any real-money trade. Keep the GitHub repository Private to protect source code, although Render's hosted URL is still publicly accessible. All *trading actions* require the dashboard passphrase.

## 3. Using the dashboard

1. Visit your Render URL. The scanner should connect to Deriv as before.
2. In **Demo trading terminal**, enter your `DASHBOARD_PASSWORD` and choose **Unlock demo terminal**.
3. Click **Connect demo account**. If this fails, inspect the displayed error and Render logs; verify PAT, app ID, and account ID.
4. Verify the demo ID and balance in the dashboard.
5. Start with a $1 stake, one open contract, and $10 session loss cap. Choose `Over 1` or `Under 8`. Click **Place demo trade**, confirm, and wait for a settled result.
6. Only after you verify the order in your Deriv demo account, consider the repeat-order control and **experimental demo auto** (explicit confirmation required).

## IMPORTANT limitations

- **We have tested the quote/buy/settlement workflow with a mock Deriv server, not with your real credentials.** Live demo execution still needs to be verified on your account.
- This is a **rules-based digit-frequency prototype**, not a trained AI model. Historical digit counts are NOT proven predictive; actual profit after contract payouts is not established.
- **No real trades:** the backend rejects any URL that is not Deriv's demo authenticated WebSocket endpoint, and filters accounts to demo only.
- **Session-only** caps/trade history. Render Free has ephemeral storage; restarts may reset limits, trade history, and account state. The bot disables auto mode on reboot or disconnect, but it is NOT safe for unattended 24/7 trading.
- On any unknown buy outcome, it blocks additional orders; reconcile against the official Deriv account before restarting. Restarts clear that memory, so always inspect Deriv if there has been any interruption.
- Some accounts or instruments may reject certain digit contracts or the selected duration. The dashboard will show the Deriv rejection; it must not silently substitute trades.
- Repeated purchases are sequential and limited to three requests per click. This is not a parallel bulk-trade execution engine.

## Code layout

- `src/deriv.js` — public market data WebSocket, from your working scanner.
- `src/trading.js` — isolated, demo-only authenticated execution engine, trade lifecycle and risk checks.
- `src/decision.js` — explicitly experimental, transparent digit-frequency rule scoring.
- `src/access.js` — protected dashboard cookie login (no browser-side API token).
- `server.js` — REST routes and SSE tick stream.
- `public/trade.js` — trading terminal controls; `public/app.js` — chart and last-digit scanner.
- `test/` — unit, mock trade, scanner and route tests.

Official API documentation:
https://developers.deriv.com/docs/options/websocket/
https://developers.deriv.com/docs/trading/proposal/
https://developers.deriv.com/docs/trading/buy/
https://developers.deriv.com/docs/trading/proposal-open-contract/
