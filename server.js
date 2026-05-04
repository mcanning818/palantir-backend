// ────────────────────────────────────────────────────────────
//  PALANTIR INTELLIGENCE BRIEF — BACKEND PROXY
//  Aggregates 8 live data sources for PLTR (NASDAQ)
// ────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const TICKER = 'PLTR';
const COMPANY = 'Palantir';
const SEC_CIK = '0001321655'; // Palantir's SEC CIK number

app.use(express.json());

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500').split(',');

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: ${origin} not allowed`));
  }
}));

// ─── RATE LIMITING ───────────────────────────────────────────
const requestCounts = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60 * 1000;

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!requestCounts.has(ip)) requestCounts.set(ip, []);
  const requests = requestCounts.get(ip).filter(t => now - t < RATE_WINDOW);
  if (requests.length >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded.' });
  }
  requests.push(now);
  requestCounts.set(ip, requests);
  next();
});

// ─── CACHE — different TTLs per data type ────────────────────
const cache = {
  news:       { data: null, fetchedAt: null, ttl: 60 * 60 * 1000 },     // 1hr
  contracts:  { data: null, fetchedAt: null, ttl: 60 * 60 * 1000 },     // 1hr
  github:     { data: null, fetchedAt: null, ttl: 60 * 60 * 1000 },     // 1hr
  wikipedia:  { data: null, fetchedAt: null, ttl: 6 * 60 * 60 * 1000 }, // 6hr
  spending:   { data: null, fetchedAt: null, ttl: 60 * 60 * 1000 },     // 1hr
  quote:      { data: null, fetchedAt: null, ttl: 5 * 60 * 1000 },      // 5min  (stock price)
  filings:    { data: null, fetchedAt: null, ttl: 60 * 60 * 1000 },     // 1hr   (SEC filings)
  insiders:   { data: null, fetchedAt: null, ttl: 60 * 60 * 1000 }      // 1hr   (insider trades)
};

function isCacheValid(key) {
  const c = cache[key];
  return c.data && (Date.now() - c.fetchedAt < c.ttl);
}

function setCache(key, data) {
  cache[key] = { ...cache[key], data, fetchedAt: Date.now() };
}

// ─── HEALTH ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    company: COMPANY,
    ticker: TICKER,
    timestamp: new Date().toISOString(),
    keys: {
      newsapi: !!process.env.NEWSAPI_KEY,
      samgov:  !!process.env.SAMGOV_KEY
    },
    endpoints: ['/api/news', '/api/contracts', '/api/github', '/api/wikipedia',
                '/api/spending', '/api/quote', '/api/filings', '/api/insiders', '/api/sources']
  });
});

// ═════════════════════════════════════════════════════════════
//  NEWSAPI — keyed
// ═════════════════════════════════════════════════════════════
app.get('/api/news', async (req, res) => {
  if (!process.env.NEWSAPI_KEY) return res.status(500).json({ error: 'NewsAPI key not configured' });
  if (isCacheValid('news')) return res.json(cache.news.data);
  try {
    const q = encodeURIComponent('Palantir Technologies');
    const url = `https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=12&apiKey=${process.env.NEWSAPI_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`NewsAPI ${r.status}`);
    const d = await r.json();
    const articles = (d.articles || []).map(a => ({
      title: a.title,
      source: a.source?.name || 'Unknown',
      publishedAt: a.publishedAt,
      url: a.url,
      description: a.description
    }));
    const result = { success: true, count: articles.length, articles };
    setCache('news', result);
    res.json(result);
  } catch (err) {
    console.error('NewsAPI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  SAM.GOV — keyed
// ═════════════════════════════════════════════════════════════
app.get('/api/contracts', async (req, res) => {
  if (!process.env.SAMGOV_KEY) return res.status(500).json({ error: 'SAM.gov key not configured' });
  if (isCacheValid('contracts')) return res.json(cache.contracts.data);
  try {
    const params = new URLSearchParams({
      api_key: process.env.SAMGOV_KEY,
      keyword: 'Palantir',
      limit: '10',
      PostedFrom: '01/01/2024',
      PostedTo: '12/31/2026'
    });
    const r = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`);
    if (!r.ok) throw new Error(`SAM.gov ${r.status}`);
    const d = await r.json();
    const opportunities = (d.opportunitiesData || []).map(o => ({
      title: o.title,
      department: o.department || o.fullParentPathName,
      postedDate: o.postedDate,
      responseDeadLine: o.responseDeadLine,
      uiLink: o.uiLink,
      noticeId: o.noticeId
    }));
    const result = { success: true, count: opportunities.length, opportunities };
    setCache('contracts', result);
    res.json(result);
  } catch (err) {
    console.error('SAM.gov error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  GITHUB — keyless
// ═════════════════════════════════════════════════════════════
app.get('/api/github', async (req, res) => {
  if (isCacheValid('github')) return res.json(cache.github.data);
  try {
    const r = await fetch('https://api.github.com/orgs/palantir/repos?sort=updated&per_page=8', {
      headers: { 'User-Agent': 'palantir-dashboard' }
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const reposData = await r.json();
    const repos = reposData.map(x => ({
      name: x.name,
      description: x.description,
      stars: x.stargazers_count,
      language: x.language,
      url: x.html_url,
      updatedAt: x.updated_at
    }));
    const result = {
      success: true,
      org: { name: 'Palantir Technologies', description: 'Open-source projects from Palantir', url: 'https://github.com/palantir' },
      repos
    };
    setCache('github', result);
    res.json(result);
  } catch (err) {
    console.error('GitHub error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  WIKIPEDIA — keyless
// ═════════════════════════════════════════════════════════════
app.get('/api/wikipedia', async (req, res) => {
  if (isCacheValid('wikipedia')) return res.json(cache.wikipedia.data);
  try {
    const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/Palantir%20Technologies', {
      headers: { 'User-Agent': 'palantir-dashboard (educational)' }
    });
    if (!r.ok) throw new Error(`Wikipedia ${r.status}`);
    const d = await r.json();
    const result = {
      success: true,
      title: d.title,
      description: d.description,
      extract: d.extract,
      lastModified: d.timestamp,
      url: d.content_urls?.desktop?.page
    };
    setCache('wikipedia', result);
    res.json(result);
  } catch (err) {
    console.error('Wikipedia error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  USASPENDING.GOV — keyless
// ═════════════════════════════════════════════════════════════
app.get('/api/spending', async (req, res) => {
  if (isCacheValid('spending')) return res.json(cache.spending.data);
  try {
    const r = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: { recipient_search_text: ['Palantir'], award_type_codes: ['A','B','C','D'] },
        fields: ['Award ID','Recipient Name','Award Amount','Awarding Agency','Start Date','Description'],
        sort: 'Award Amount', order: 'desc', limit: 10
      })
    });
    if (!r.ok) throw new Error(`USASpending ${r.status}`);
    const d = await r.json();
    const awards = (d.results || []).map(a => ({
      awardId: a['Award ID'],
      recipient: a['Recipient Name'],
      amount: a['Award Amount'],
      agency: a['Awarding Agency'],
      startDate: a['Start Date'],
      description: a['Description']
    }));
    const result = { success: true, count: awards.length, awards };
    setCache('spending', result);
    res.json(result);
  } catch (err) {
    console.error('USASpending error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  STOCK QUOTE — Stooq (keyless, free)
//  Returns current price + 30 day history for sparkline
// ═════════════════════════════════════════════════════════════
app.get('/api/quote', async (req, res) => {
  if (isCacheValid('quote')) return res.json(cache.quote.data);
  try {
    // Stooq returns CSV — daily OHLCV history
    const r = await fetch('https://stooq.com/q/d/l/?s=pltr.us&i=d');
    if (!r.ok) throw new Error(`Stooq ${r.status}`);
    const csv = await r.text();

    // Parse CSV: Date,Open,High,Low,Close,Volume
    const lines = csv.trim().split('\n').slice(1); // skip header
    const rows = lines.map(line => {
      const [date, open, high, low, close, volume] = line.split(',');
      return {
        date,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseInt(volume, 10)
      };
    }).filter(r => !isNaN(r.close));

    // Last 60 days for chart, latest for headline
    const recent = rows.slice(-60);
    const latest = rows[rows.length - 1];
    const yearAgo = rows[rows.length - 252] || rows[0];
    const oneMonthAgo = rows[rows.length - 22] || rows[0];

    const change1d = rows.length >= 2
      ? latest.close - rows[rows.length - 2].close
      : 0;
    const changePct1d = rows.length >= 2
      ? (change1d / rows[rows.length - 2].close) * 100
      : 0;
    const changePct30d = ((latest.close - oneMonthAgo.close) / oneMonthAgo.close) * 100;
    const changePct1y = ((latest.close - yearAgo.close) / yearAgo.close) * 100;

    // 52-week high/low
    const yearWindow = rows.slice(-252);
    const weekHigh52 = Math.max(...yearWindow.map(r => r.high));
    const weekLow52 = Math.min(...yearWindow.map(r => r.low));

    const result = {
      success: true,
      ticker: TICKER,
      latest: {
        date: latest.date,
        price: latest.close,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        volume: latest.volume
      },
      change: {
        oneDay: change1d,
        oneDayPct: changePct1d,
        thirtyDayPct: changePct30d,
        oneYearPct: changePct1y
      },
      range52w: { high: weekHigh52, low: weekLow52 },
      history: recent.map(r => ({ date: r.date, close: r.close }))
    };
    setCache('quote', result);
    res.json(result);
  } catch (err) {
    console.error('Stooq error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  SEC FILINGS — EDGAR (keyless, free)
//  Fetches recent 10-K, 10-Q, 8-K, etc.
// ═════════════════════════════════════════════════════════════
app.get('/api/filings', async (req, res) => {
  if (isCacheValid('filings')) return res.json(cache.filings.data);
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${SEC_CIK}.json`, {
      headers: { 'User-Agent': 'palantir-dashboard educational@example.com' }
    });
    if (!r.ok) throw new Error(`SEC EDGAR ${r.status}`);
    const d = await r.json();

    const recent = d.filings?.recent;
    if (!recent) throw new Error('No recent filings in response');

    // Build list of recent filings (zip together parallel arrays)
    const filings = [];
    const limit = Math.min(15, recent.accessionNumber?.length || 0);
    for (let i = 0; i < limit; i++) {
      const accession = recent.accessionNumber[i].replace(/-/g, '');
      filings.push({
        form: recent.form[i],
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate[i],
        primaryDocument: recent.primaryDocument[i],
        accessionNumber: recent.accessionNumber[i],
        url: `https://www.sec.gov/Archives/edgar/data/${parseInt(SEC_CIK)}/${accession}/${recent.primaryDocument[i]}`
      });
    }

    const result = {
      success: true,
      company: d.name,
      cik: SEC_CIK,
      ticker: d.tickers?.[0] || TICKER,
      sic: d.sicDescription,
      count: filings.length,
      filings
    };
    setCache('filings', result);
    res.json(result);
  } catch (err) {
    console.error('SEC filings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  INSIDER TRADES — SEC EDGAR Form 4 filings (keyless)
//  Filters /api/filings down to just Form 4 (insider trades)
// ═════════════════════════════════════════════════════════════
app.get('/api/insiders', async (req, res) => {
  if (isCacheValid('insiders')) return res.json(cache.insiders.data);
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${SEC_CIK}.json`, {
      headers: { 'User-Agent': 'palantir-dashboard educational@example.com' }
    });
    if (!r.ok) throw new Error(`SEC EDGAR ${r.status}`);
    const d = await r.json();

    const recent = d.filings?.recent;
    if (!recent) throw new Error('No recent filings');

    // Form 4 = insider transactions
    const trades = [];
    for (let i = 0; i < recent.accessionNumber.length && trades.length < 12; i++) {
      if (recent.form[i] === '4') {
        const accession = recent.accessionNumber[i].replace(/-/g, '');
        trades.push({
          form: recent.form[i],
          filingDate: recent.filingDate[i],
          reportDate: recent.reportDate[i],
          accessionNumber: recent.accessionNumber[i],
          url: `https://www.sec.gov/Archives/edgar/data/${parseInt(SEC_CIK)}/${accession}/${recent.primaryDocument[i]}`
        });
      }
    }

    const result = {
      success: true,
      company: d.name,
      ticker: TICKER,
      count: trades.length,
      trades,
      note: 'Form 4 filings: insider transactions. Click through for transaction details (shares, price, type).'
    };
    setCache('insiders', result);
    res.json(result);
  } catch (err) {
    console.error('SEC insiders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  SOURCES / CITATIONS — static
// ═════════════════════════════════════════════════════════════
app.get('/api/sources', (req, res) => {
  try {
    const sourcesPath = path.join(__dirname, 'data', 'sources.json');
    if (!fs.existsSync(sourcesPath)) {
      return res.json({ success: true, sources: { note: 'No sources file yet. Add data/sources.json.' } });
    }
    const raw = fs.readFileSync(sourcesPath, 'utf8');
    const sources = JSON.parse(raw);
    res.json({ success: true, sources });
  } catch (err) {
    res.status(500).json({ error: 'Could not load sources' });
  }
});

// ─── ROOT ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Palantir Intelligence Brief Backend',
    company: COMPANY,
    ticker: TICKER,
    cik: SEC_CIK,
    endpoints: ['/health', '/api/news', '/api/contracts', '/api/github',
                '/api/wikipedia', '/api/spending', '/api/quote',
                '/api/filings', '/api/insiders', '/api/sources']
  });
});

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Palantir backend running on port ${PORT}`);
  console.log(`  Ticker: ${TICKER}  ·  CIK: ${SEC_CIK}`);
  console.log(`  NewsAPI key: ${process.env.NEWSAPI_KEY ? '✓ loaded' : '✗ missing'}`);
  console.log(`  SAM.gov key: ${process.env.SAMGOV_KEY ? '✓ loaded' : '✗ missing'}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`  Endpoints: 9 live data feeds`);
});
