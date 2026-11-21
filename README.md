# cardwise-data

Keeps CardWise's card rules and bank offers fresh. Every morning at 06:00 IST a GitHub Action reads the banks' pages, checks and extracts with Grok (xAI) under strict guardrails, and publishes a **signed** catalog the app downloads anonymously.

```
sources/sources.json ──fetch (robots.txt respected)──▶ page text
        │                                                  │
        ▼                                                  ▼
catalog/catalog.json ◀── apply ◀── guardrails ◀── Claude: check rules / list offers (with verbatim quotes)
        │
        ├─ SAFE (re-confirmed rules, new/expired offers) ──▶ committed ──▶ publish.yml ──▶ GitHub Pages
        └─ RISKY (any card rate/cap/minimum change) ──▶ pull request for you to review ──▶ merge ──▶ publish
```

**Guardrails.** The model never edits rules freely. On card pages it can only say each existing rule is the same, changed or not found. Every answer must quote the page verbatim; the quote is checked against the page text, and every number must appear inside its quote. Offers must use our merchant/issuer ids, have an end date, and pass sanity bounds. Rate, cap or minimum changes always wait for your approval in a pull request. The final catalog is validated with the same rules the app enforces, then signed with Ed25519. The app refuses anything it can't verify and keeps its last good copy.

## One-time setup (≈15 minutes)

1. **Create the repo.** On GitHub, create a public repository named `cardwise-data`, then from this folder:
   ```
   git init && git add . && git commit -m "CardWise data pipeline"
   git branch -M main
   git remote add origin https://github.com/<you>/cardwise-data.git
   git push -u origin main
   ```
   (Public is simplest: GitHub Pages and Actions are free for public repos, and the catalog is public information anyway.)
2. **Make a signing key.** `npm ci && npm run keygen`. It prints two lines:
   - the private key → GitHub repo **Settings → Secrets and variables → Actions → New secret** named `CATALOG_SIGNING_KEY`
   - the public key → keep it for step 6
3. **Add your xAI API key** as another secret, `XAI_API_KEY` (from console.x.ai). Default model `grok-4-1-fast-reasoning`; set a repository variable `GROK_MODEL` to change it. (Claude still works: add `ANTHROPIC_API_KEY` instead and leave `XAI_API_KEY` unset.)
4. **Turn on Pages.** Settings → Pages → Source: **GitHub Actions**.
5. **Let the bot open PRs.** Settings → Actions → General → Workflow permissions: **Read and write**, and tick **Allow GitHub Actions to create and approve pull requests**.
6. **Connect the app.** Actions → **Publish catalog** → Run workflow. When it's done, `https://<you>.github.io/cardwise-data/catalog.json` exists. In the CardWise project's `gradle.properties` add:
   ```
   cardwise.catalogUrl=https://<you>.github.io/cardwise-data/
   cardwise.catalogPublicKey=<public key from step 2>
   ```
   Rebuild the app. It now checks for a new catalog once a day on Wi-Fi or mobile data, and you can force it in Settings → Card data → Check now.

## Day to day

- Most days nothing needs you: re-confirmed rules and new or expired offers publish on their own. Each run's report shows on the Actions run page.
- When a bank changes a card's terms, you get a pull request titled **"Review: card terms changed"** with the old and new values, the verbatim quote and a source link. Check it against the link and merge (publishes) or close (ignored).
- To track another page, add an entry to `sources/sources.json`. `kind: "card"` re-checks a card's rules; `kind: "offers"` lists offers. Pages that block bots in `robots.txt` are skipped and reported.

## Costs

GitHub Actions and Pages are free for public repos. Claude API usage is the only cost: each source page that changed since yesterday is one request (unchanged pages are hashed and skipped), so quiet days cost almost nothing. Bank offer portals change most often.

## Honest limits

- Some sources are JavaScript-heavy or block bots. The workflow renders pages in headless Chromium (`USE_BROWSER=1`); a page that still yields no text is skipped and listed in the report. A few URLs in `sources.json` are best guesses at each bank's page; fix any the report says 404.
- PDF terms documents aren't machine-read yet (noted on the Swiggy Ornge source).
- Merchant sites (Amazon, Flipkart, Myntra…) generally forbid scraping, so their bank offers are picked up from the **issuers'** offer portals instead.
- New benefits a card adds that no rule covers yet are listed in the report for you to model by hand.

## Commands

```
npm test             # 14 tests: schema, guardrails, robots.txt, end-to-end run, signing
npm run typecheck
npm run validate     # check catalog/catalog.json
npm run pipeline     # needs XAI_API_KEY (or ANTHROPIC_API_KEY); USE_BROWSER=1 for JS pages
npm run keygen
CATALOG_SIGNING_KEY=... npm run sign   # writes public/catalog.json + .sig
```
