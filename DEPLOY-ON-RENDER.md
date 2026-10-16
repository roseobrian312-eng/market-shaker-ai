# Upgrade your existing Market Shaker AI website to Phase 5

**You already have the GitHub repository and Render website. Do not create another one.**

## A. Update GitHub

1. Download `Market-Shaker-AI-Phase5-Live-ChatGPT.zip` and use Windows **Extract All**.
2. Open the extracted folder. You should see `public`, `src`, `test`, `server.js` and `package.json` directly inside it.
3. Go to your existing GitHub repository `roseobrian312-eng/market-shaker-ai`, branch `main`.
4. Choose **Add file → Upload files**. Select the **contents** inside your extracted project using **Ctrl+A**, not the enclosing Phase 5 folder. Upload them at the repository root. The new `server.js`, `public/`, `src/`, `test/` and `package.json` must replace the older versions. If GitHub won't overwrite files, do not delete your working app: request assistance updating the existing files.
5. Commit changes. Render should redeploy automatically. Otherwise use **Manual Deploy → Deploy latest commit**.

## B. Add the separate OpenAI API key

1. Open https://platform.openai.com/api-keys and create a **secret API key** for your OpenAI API project (separate usage billing may be required; ChatGPT Plus does not cover API calls).
2. Open https://dashboard.render.com → **market-shaker-ai → Environment**.
3. Leave your existing `DASHBOARD_PASSWORD`, `DERIV_APP_ID`, and `DERIV_PAT` unchanged.
4. Add one new environment variable: **Key:** `OPENAI_API_KEY` · **Value:** your newly created secret key.
5. Optional `OPENAI_MODEL` = `gpt-4.1-mini` (default; can leave unset).
6. Click **Save, deploy**. Wait until Render shows **Live**.

**Keep the API key secret. Never paste it in ChatGPT, GitHub, screenshots or browser code.**

## C. Test the real AI chat

1. Open your existing website: https://market-shaker-ai.onrender.com
2. Unlock the demo terminal using the dashboard password you already set.
3. Click **Scan all markets** and allow some markets to collect ticks.
4. Scroll to **Talk to Market Shaker AI**.
5. Verify status says **AI API ready**, then press **Scan markets**.
6. You should receive a ChatGPT-style written answer that mentions the captured snapshot time and market data. If you see an API billing/quota error, check your OpenAI API project balance and model access. If you see `AI API not configured`, check the Render environment variable and redeploy.

## D. Test optional ChatGPT-assisted DEMO auto mode

1. Click **Connect demo account** (must show an account clearly marked DEMO).
2. Set safe demo risk settings and save them; for initial testing use $1 stake, $1 max stake, max open 1, $10 loss cap, 15s cooldown, 5 session trades.
3. In the AI decision mode selector, choose **ChatGPT-assisted demo (API usage)**.
4. Choose **1 demo trade**, press **Start demo auto**, confirm DEMO.
5. The server will score live markets and quote up to five candidates, send the summary to the language model, and let it select a verified option or WAIT. It might not place any trade. Check the dashboard/Deriv demo account before increasing frequency.
6. Press **STOP auto** when done. Check any uncertain order on Deriv rather than retrying.

You can continue using the older ML-only Evidence-gated and Exploratory auto modes without an OpenAI API key.

## Troubleshooting

- **Website unchanged after upgrade:** New files are likely inside a new `Phase5` folder on GitHub instead of at the root; or Render hasn't redeployed.
- **AI API not configured:** Add `OPENAI_API_KEY` on Render and deploy again.
- **AI API key rejected / quota:** OpenAI API uses separate billing/quotas; verify API key and account.
- **AI says WAIT:** Normal; weak or overpriced digit contracts do not imply a positive expected return.
- **Not every market is listed or ready:** Deriv contract support varies; scanner rotates live feeds to avoid overwhelming free hosting.
- **Trading refuses to start:** Check demo account connected, scanner active, risk settings and available daily/session trades.
- **Render sleeps:** Free hosting isn't suitable for unattended trading or persistent model memory.
