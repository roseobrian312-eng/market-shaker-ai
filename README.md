# Market Shaker AI — Phase 5: Live ChatGPT-Style Assistant and Adaptive ML Demo Terminal

This is a complete replacement source package for the existing **Market Shaker AI** Node 22 website hosted on GitHub + Render. It preserves the existing chart, Deriv data feed, authenticated demo account, market discovery, adaptive online model and trade controls.

## Phase 5: what has been added

- **Actual OpenAI API integration**, not just an 'AI' button: chat messages are sent from your Render server to an OpenAI language model.
- **Live Deriv tick context**: each question carries a fresh, timestamped SERVER-GENERATED snapshot of the current multi-market tick scanner (sampled recent digits, model rankings, scorecards, symbol counts, demo outcomes). The model is **not** called once per tick; the underlying scanner receives ticks continuously.
- **Conversational panel**: ask in plain English to scan markets, compare Over 1 / Under 8 / Matches 5 / Differs 5 and explain why it recommends **WAIT**. Preset buttons included.
- **Optional AI-assisted auto demo mode**: after you connect a verified Deriv demo account, choose `ChatGPT-assisted demo (API usage)` in the auto controls. During eligible entry windows, the server collects up to five valid, **live broker quotes**, asks the model to choose one of those candidates or `WAIT`, validates its returned index, then only the existing DemoTrader order engine can execute the selected **demo** option. The model has no direct order tools, has no account token, cannot invent symbols or order amounts, and cannot bypass risk checks.
- **Usage limits**: 40 chat requests and 20 AI selection requests per server process, with at least 45 seconds between model selections. They reset if Render restarts.
- **Model learning**: the Phase 4 online ML still trains on next-tick outcomes and can be backed up. OpenAI language-model chat is a distinct service; it is not trained or fine-tuned on your ticks.

**Important:** This is demo-only research software. ChatGPT and the online classifier have no demonstrated profitable edge on Deriv digit contracts. Frequent API calls, especially low-stake trades, may have negative expected returns. A chat answer is not a broker quote. Some LLM suggestions will correctly be WAIT.

## Existing settings (do not change if working)

Set private environment variables in **Render → your web service → Environment**:

- `DASHBOARD_PASSWORD`: 12+ characters, your existing private dashboard password.
- `DERIV_APP_ID`: your existing Deriv PAT app ID.
- `DERIV_PAT`: your existing private Deriv PAT with trading permission.
- Optional `DERIV_DEMO_ACCOUNT_ID`: the exact DOT... demo Options account ID.

## New Phase 5 settings (required for ChatGPT-style features)

- `OPENAI_API_KEY`: create at https://platform.openai.com/api-keys and paste it ONLY into Render's private Environment settings, never into GitHub, a chat message, or browser code. Your ChatGPT subscription **does not** include API usage; this account requires separate API billing/credit.
- Optional `OPENAI_MODEL`: defaults to `gpt-4.1-mini`, a relatively affordable API model. Only use a model your API project can access.

**You cannot use a regular ChatGPT login, Deriv PAT or Deriv app ID as an OpenAI API key.**

The OpenAI key is kept on the server. Chat sends an anonymized market snapshot with no Deriv PAT, dashboard passphrase or account ID. Never upload a `.env` file. This project uses no npm dependencies outside built-in Node 22 libraries.

## How to use

1. Deploy the files at the **repository root**, keeping your existing Render service and URL.
2. Add `OPENAI_API_KEY` under Render Environment, then Save + Deploy.
3. Open the site, unlock the demo terminal with your existing dashboard passphrase, and press **Scan all markets**.
4. In the new **Talk to Market Shaker AI** chat, ask: "Scan the live markets and tell me which strategies have the strongest current evidence." The assistant should respond with a timestamp, market statistics and limitations.
5. For **AI-assisted DEMO** execution, click Connect demo account; set stake and loss limits; select `ChatGPT-assisted demo (API usage)`; pick a quantity 1–20; click Start demo auto. The model considers quoted candidates at no more than one selection request per 45 seconds; it may choose WAIT. Do not expect the target quantity to execute.
6. Use **STOP auto** to stop future orders (already placed contracts continue settling).

The older Evidence-gated and Exploratory modes still use the ML decision engine without OpenAI API calls.

## API routes

All assistant routes require your password-based dashboard session:

- `GET /api/assistant/status` — OpenAI key configured? current call counts and limits, never the key.
- `GET /api/assistant/context` — sanitized, timestamped market snapshot sent to the LLM.
- `POST /api/assistant/chat` — `{ "message":"Scan the markets", "history":[] }` returns `{reply,snapshotTime,model}`. Same-origin CSRF guard, authenticated cookie, limits and input validation.

Original scanner / risk / trading routes remain.

## Testing and limitations

Run `npm test` using Node 22+. **34 automated tests** cover security gates, chat/LLM mock responses, sanitized snapshots, supported choices, WAIT behavior, risk validation, synthetic SSE feed and simulated Deriv order execution.

- Automated tests **do not** validate actual live Deriv order execution or an actual OpenAI account.
- Render Free may sleep and reset in-memory learning, API usage counters, trade history and risk state. It is **not** suitable for unattended 24/7 trading. Download model backups if you want to preserve learning.
- This app scans available active markets in rotating groups (default up to 24), **not all at the same instant**.
- Deriv decides which contracts are available on each symbol.
- LLM selection is not continuously reasoning over every incoming tick; it is asked to review a fresh summarized snapshot at each decision window, to control latency and API costs.
- Existing trading risk caps are server-session caps, not guaranteed daily persistent account-level caps.
