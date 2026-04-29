import express from 'express';
import cors from 'cors';
import path from 'path';
import Database from 'better-sqlite3';
import { Deepgram } from '@deepgram/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

const db = new Database('doctorpd.db');

// ================= DATABASE =================

db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patientName TEXT,
    predicted INTEGER,
    actual INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    clinician_email TEXT,
    action TEXT,
    patient_name TEXT,
    lawful_basis TEXT,
    purpose TEXT,
    data_categories TEXT,
    recipients TEXT,
    international_transfer TEXT,
    retention_days INTEGER DEFAULT 2555,
    details TEXT
  );
`);

const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);

// ================= USERS =================

const users = {
  "clinician@doctorpd.com": { password: "clinician123", role: "clinician" },
  "patient@doctorpd.com": { password: "patient123", role: "patient" }
};

// ================= GDPR LOGGING =================

function logGDPR(email, action, patientName, lawfulBasis, purpose, dataCategories, details) {
  db.prepare(`
    INSERT INTO audit_logs 
    (clinician_email, action, patient_name, lawful_basis, purpose, data_categories, recipients, international_transfer, details)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(email, action, patientName, lawfulBasis, purpose, dataCategories, "Deepgram (US) – SCCs", details);
}

// ================= AUTH =================

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users[email];

  if (user && user.password === password) {
    logGDPR(email, 'LOGIN', null, 'Legitimate Interest', 'Authentication', 'User credentials', 'Successful login');
    res.json({ success: true, email, role: user.role });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

// ================= GDPR =================

app.get('/gdpr/processing-activities', (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC').all();
  res.json(logs);
});

app.get('/gdpr/export', (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC').all();
  res.json({ controller: "DOCTORPD", records: logs });
});

// ================= AI =================

app.post('/ai/personal-check', (req, res) => {
  res.json({
    follow_up_questions: req.body.stage === "initial"
      ? ["Duration of symptoms?", "Any fever?", "Any recent injury?"]
      : [],
    red_flags: [],
    triage_score: 75,
    urgency: "Moderate",
    conditions: [
      {
        name: "Acute musculoskeletal injury",
        likelihood: "High",
        reason: "Clinical presentation"
      }
    ],
    overall_assessment: "Stable. Recommend conservative management.",
    revenue_prompts: [
      { message: "Add detailed exam findings", value: 420 }
    ],
    funding: { baseline: 1450, potential: 2100, uplift: 650 }
  });
});

// ================= DIAGNOSTICS (FIXED) =================

app.post('/ai/diagnostics-assist', (req, res) => {
  // Accepts JSON instead of file upload
  const { description } = req.body;

  res.json({
    image_assessment: description
      ? `Assessment based on description: ${description}`
      : "No description provided.",
    triage: { score: 68, urgency: "Moderate" },
    possible_conditions: [
      {
        name: "Soft tissue injury",
        likelihood: "High",
        reason: "Based on provided description"
      }
    ],
    recommended_diagnostics: {
      imaging: [
        {
          test: "X-ray (relevant area)",
          reason: "Rule out fracture",
          urgency: "Routine"
        }
      ],
      pathology: []
    }
  });
});

// ================= DOCUMENTATION =================

app.post('/ai/clinical-assist', (req, res) => {
  res.json({
    suggestions: ["Add laterality", "Document pain score on VAS scale"],
    funding_prompts: [
      { prompt: "Functional limitations", estimated_uplift: 350 }
    ]
  });
});

// ================= FUNDING =================

app.post('/drg/estimate', (req, res) => {
  res.json({ funding: 2450 });
});

// ================= CASE TRACKING =================

app.post('/pilot/track', (req, res) => {
  const { predicted, actual, patientName = "Unknown" } = req.body;

  db.prepare(
    'INSERT INTO cases (patientName, predicted, actual) VALUES (?,?,?)'
  ).run(patientName, predicted, actual || 0);

  res.sendStatus(201);
});

app.get('/pilot/data', (req, res) => {
  const rows = db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/pilot/metrics', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM cases').get().c;

  const stats = db.prepare(
    'SELECT SUM(predicted) as pred, SUM(actual) as act FROM cases'
  ).get();

  res.json({
    predicted: stats.pred || 0,
    actual: stats.act || 0,
    delta: (stats.act || 0) - (stats.pred || 0),
    total
  });
});

// ================= HEALTH =================

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'DOCTORPD',
    model: 'nova-3-medical'
  });
});

// ================= SERVER =================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 DOCTORPD running at http://localhost:${PORT}`);
});
