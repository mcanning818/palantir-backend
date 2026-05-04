# Palantir Intelligence Brief — Backend

Secure Express proxy for the Palantir Intelligence Brief frontend. Aggregates 8 live data sources for PLTR (NASDAQ).

## Endpoints

| Endpoint | Source | Auth | Cache |
|----------|--------|------|-------|
| `/health` | — | — | — |
| `/api/news` | NewsAPI | API key | 1hr |
| `/api/contracts` | SAM.gov | API key | 1hr |
| `/api/github` | GitHub API | none | 1hr |
| `/api/wikipedia` | Wikipedia REST | none | 6hr |
| `/api/spending` | USASpending.gov | none | 1hr |
| `/api/quote` | Stooq (PLTR.US) | none | **5min** |
| `/api/filings` | SEC EDGAR | none | 1hr |
| `/api/insiders` | SEC EDGAR (Form 4) | none | 1hr |
| `/api/sources` | local JSON | — | — |

## Setup

```bash
npm install
cp .env.example .env
# fill in NEWSAPI_KEY and SAMGOV_KEY in .env
npm start
```

Server runs on http://localhost:3000 (or `PORT` env var).

## Deploying to Render

1. Create a new Web Service, connect your GitHub repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Add environment variables in Render dashboard:
   - `NEWSAPI_KEY` — your NewsAPI.org key
   - `SAMGOV_KEY` — your SAM.gov API key
   - `ALLOWED_ORIGINS` — comma-separated frontend domains

## Architecture

- All credentials stay server-side. Frontend never sees keys.
- Per-IP rate limiting: 60 req/min.
- In-memory cache per endpoint with custom TTLs (5min for quote, 6hr for Wikipedia).
- CORS locked to specific frontend origins.

## Testing endpoints

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/quote
curl http://localhost:3000/api/filings
curl http://localhost:3000/api/insiders
```
