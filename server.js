const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Storage location for the transaction ledger. On Render, this should point
// at the mounted persistent disk (e.g. DATA_DIR=/var/data) so history
// survives restarts and redeploys. Falls back to a local ./data folder for
// local testing.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

// ---------- optional basic auth ----------
// Set QBO_USER and QBO_PASS as environment variables in the GoDaddy Node.js
// Hosting dashboard to require a login. If either is unset, auth is skipped
// (useful for local testing) but you should set both before going live,
// since this app handles real bank transaction data.
const AUTH_USER = process.env.QBO_USER;
const AUTH_PASS = process.env.QBO_PASS;

app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!AUTH_USER || !AUTH_PASS) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === AUTH_USER && pass === AUTH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="QBO Dedup"');
  res.status(401).send('Authentication required.');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- OFX parsing helpers ----------
function extractTag(text, tag) {
  const re = new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function detectAccountKey(text) {
  const acctid = extractTag(text, 'ACCTID');
  const bankid = extractTag(text, 'BANKID');
  const accttype = extractTag(text, 'ACCTTYPE');
  const parts = [];
  if (bankid) parts.push('bank' + bankid);
  if (acctid) parts.push('acct' + acctid);
  if (accttype) parts.push(accttype);
  return parts.length ? parts.join('_') : null;
}

function parseTransactions(text) {
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  return blocks.map((b) => ({
    fitid: extractTag(b, 'FITID'),
    dtposted: extractTag(b, 'DTPOSTED'),
    trnamt: extractTag(b, 'TRNAMT'),
    name: extractTag(b, 'NAME') || extractTag(b, 'PAYEE'),
    raw: b,
  }));
}

function safeKey(s) {
  return s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
}

function ledgerPath(accountKey) {
  return path.join(DATA_DIR, 'ledger_' + safeKey(accountKey) + '.json');
}

function loadLedger(accountKey) {
  const p = ledgerPath(accountKey);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      return { seen: {} };
    }
  }
  return { seen: {} };
}

function saveLedger(accountKey, ledger) {
  fs.writeFileSync(ledgerPath(accountKey), JSON.stringify(ledger, null, 2));
}

function loadIndex() {
  if (fs.existsSync(INDEX_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    } catch (e) {
      return { accounts: [] };
    }
  }
  return { accounts: [] };
}

function saveIndex(idx) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
}

// ---------- routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Wipes all stored account history. Protected by the same login as
// everything else (this route is not exempted from the auth middleware
// above). Intended for resetting during setup/testing.
app.post('/api/reset', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR);
    files.forEach((f) => fs.unlinkSync(path.join(DATA_DIR, f)));
    res.json({ ok: true, filesRemoved: files.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not reset: ' + e.message });
  }
});

app.get('/api/accounts', (req, res) => {
  const idx = loadIndex();
  const accounts = idx.accounts.map((key) => {
    const ledger = loadLedger(key);
    return {
      key,
      label: ledger.label || key,
      count: Object.keys(ledger.seen || {}).length,
      lastRun: ledger.lastRun || null,
    };
  });
  res.json({ accounts });
});

app.post('/api/process', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const text = req.file.buffer.toString('utf8');
    const txns = parseTransactions(text);

    if (txns.length === 0) {
      return res.status(400).json({ error: "No transactions found in this file. Check that it's a valid .qbo/.ofx export." });
    }

    const detected = detectAccountKey(text);
    const label = (req.body.label || '').trim();
    // The auto-detected bank ID / account number is the reliable identity key
    // -- it comes straight from the file and can't be typo'd. The label is
    // only used as identity when detection genuinely fails (rare), so a
    // mislabeled upload can never accidentally split an account's history.
    const accountKey = detected || label;

    if (!accountKey) {
      return res.status(400).json({ error: 'Could not identify the account from this file. Provide an account label and try again.' });
    }

    const ledger = loadLedger(accountKey);
    const seen = ledger.seen || {};

    const newTxns = [];
    const dupeTxns = [];
    txns.forEach((t) => {
      if (t.fitid && seen[t.fitid]) {
        dupeTxns.push(t);
      } else {
        newTxns.push(t);
      }
    });

    txns.forEach((t) => {
      if (t.fitid && !seen[t.fitid]) {
        seen[t.fitid] = { date: t.dtposted, amount: t.trnamt, name: t.name };
      }
    });
    ledger.seen = seen;
    ledger.label = label || ledger.label || detected;
    ledger.lastRun = new Date().toISOString();
    saveLedger(accountKey, ledger);

    const idx = loadIndex();
    if (!idx.accounts.includes(accountKey)) {
      idx.accounts.push(accountKey);
      saveIndex(idx);
    }

    let outText = text;
    dupeTxns.forEach((t) => {
      outText = outText.replace(t.raw, '');
    });

    res.json({
      accountKey,
      total: txns.length,
      dupeCount: dupeTxns.length,
      newCount: newTxns.length,
      transactions: txns.map((t) => ({
        name: t.name,
        amount: t.trnamt,
        date: t.dtposted,
        isDupe: dupeTxns.includes(t),
      })),
      outputText: newTxns.length > 0 ? outText : null,
      outputFilename: req.file.originalname.replace(/\.(qbo|ofx)$/i, '') + '_NEW.qbo',
    });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong processing this file: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('QBO dedup app listening on port ' + PORT);
});
