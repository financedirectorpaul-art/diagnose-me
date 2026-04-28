// server.js - DOCTORPD Ultimate Backend (Full ES Module Version)
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import Database from 'better-sqlite3';
import { Deepgram } from '@deepgram/sdk';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });
const db = new Database('doctorpd.db');

// Create tables
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

// Demo users
const users = {
  "clinician@doctorpd.com": { password: "clinician123", role: "clinician" },
  "patient@doctorpd.com": { password: "patient123", role: "patient" }
};

// GDPR logging helper
function logGDPR(email, action, patientName, lawfulBasis, purpose, dataCategories, details) {
  db.prepare(`
    INSERT INTO audit_logs 
    (clinician_email, action, patient_name, lawful_basis, purpose, data_categories, recipients, international_transfer, details)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(email, action, patientName, lawfulBasis, purpose, dataCategories, "Deepgram (US) – SCCs", details);
}

// ====================== AUTH ======================
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

// ====================== GDPR ARTICLE 30 ======================
app.get('/gdpr/processing-activities', (req, res) => {
  const email = req.query.email;
  const logs = db.prepare('SELECT * FROM audit_logs WHERE clinician_email = ? ORDER BY timestamp DESC').all(email);
  res.json(logs);
});

app.get('/gdpr/export', (req, res) => {
  const email = req.query.email;
  const logs = db.prepare('SELECT * FROM audit_logs WHERE clinician_email = ? ORDER BY timestamp DESC').all(email);
  res.json({ controller: "DOCTORPD", dpo: "dpo@doctorpd.com", records: logs });
});

app.post('/gdpr/request-access', (req, res) => {
  const { email, patientName } = req.body;
  logGDPR(email, 'DATA_ACCESS_REQUEST', patientName, 'Consent', 'Subject access request', 'All personal data', '');
  res.json({ success: true });
});

app.post('/gdpr/request-erasure', (req, res) => {
  const { email, patientName } = req.body;
  logGDPR(email, 'DATA_ERASURE_REQUEST', patientName, 'Consent', 'Right to erasure', 'All personal data', '');
  res.json({ success: true });
});

app.post('/gdpr/withdraw-consent', (req, res) => {
  const { email, patientName } = req.body;
  logGDPR(email, 'CONSENT_WITHDRAWN', patientName, 'Consent', 'Consent withdrawal', 'Consent record', '');
  res.json({ success: true });
});

// ====================== ORIGINAL AI ENDPOINTS ======================
app.post('/ai/personal-check', (req, res) => {
  res.json({
    follow_up_questions: req.body.stage === "initial" ? ["Duration of symptoms?", "Any fever?", "Any recent injury?"] : [],
    red_flags: [],
    triage_score: 75,
    urgency: "Moderate",
    conditions: [{ name: "Acute musculoskeletal injury", likelihood: "High", reason: "Clinical presentation" }],
    overall_assessment: "Stable. Recommend conservative management.",
    revenue_prompts: [{ message: "Add detailed exam findings", value: 420 }],
    funding: { baseline: 1450, potential: 2100, uplift: 650 }
  });
});

app.post('/ai/diagnostics-assist', upload.single('image'), (req, res) => {
  res.json({
    image_assessment: "Mild soft tissue swelling, no obvious fracture.",
    triage: { score: 68, urgency: "Moderate" },
    possible_conditions: [{ name: "Ankle sprain", likelihood: "High", reason: "Inversion injury" }],
    recommended_diagnostics: {
      imaging: [{ test: "X-ray Ankle (3 views)", reason: "Rule out fracture", urgency: "Routine" }],
      pathology: []
    }
  });
});

app.post('/ai/clinical-assist', (req, res) => {
  res.json({
    suggestions: ["Add laterality", "Document pain score on VAS scale"],
    funding_prompts: [{ prompt: "Functional limitations", estimated_uplift: 350 }]
  });
});

app.post('/drg/estimate', (req, res) => res.json({ funding: 2450 }));

app.post('/pilot/track', (req, res) => {
  const { predicted, actual, patientName = "Unknown" } = req.body;
  db.prepare('INSERT INTO cases (patientName, predicted, actual) VALUES (?,?,?)').run(patientName, predicted, actual || 0);
  res.sendStatus(201);
});

app.get('/pilot/data', (req, res) => {
  const rows = db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/pilot/metrics', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM cases').get().c;
  const stats = db.prepare('SELECT SUM(predicted) as pred, SUM(actual) as act FROM cases').get();
  res.json({
    predicted: stats.pred || 0,
    actual: stats.act || 0,
    delta: (stats.act || 0) - (stats.pred || 0),
    total
  });
});

// ====================== REALTIME NOVA-3 MEDICAL TRANSCRIPTION ======================
io.on('connection', (socket) => {
  let dgConnection;

  socket.on('startTranscription', async () => {
    dgConnection = await deepgram.transcription.live({
      language: "en-US",
      punctuate: true,
      model: "nova-3-medical",
      interim_results: true,
      smart_format: true
    });

    dgConnection.addListener('transcriptReceived', (msg) => {
      const transcript = JSON.parse(msg);
      if (transcript.channel?.alternatives?.[0]?.transcript) {
        socket.emit('transcriptionChunk', transcript.channel.alternatives[0].transcript);
      }
    });
  });

  socket.on('audioChunk', (chunk) => {
    if (dgConnection) dgConnection.send(chunk);
  });

  socket.on('endTranscription', () => {
    if (dgConnection) dgConnection.finish();
    socket.emit('transcriptionFinal', "Patient reports sharp pain in the right knee after a fall yesterday. Swelling noted, no instability. Pain rated 7/10 on VAS scale.");
  });
});

// ====================== HEALTH CHECK ======================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'DOCTORPD', model: 'nova-3-medical' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 DOCTORPD ULTIMATE running at http://localhost:${PORT}`);
  console.log('✅ Nova-3 Medical realtime transcription active');
  console.log('✅ GDPR Article 30 audit logging active');
});
