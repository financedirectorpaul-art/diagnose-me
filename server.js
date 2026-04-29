import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// ================= IN-MEMORY STORAGE =================

let cases = [];
let auditLogs = [];

// ================= USERS =================

const users = {
  "clinician@doctorpd.com": { password: "clinician123", role: "clinician" },
  "patient@doctorpd.com": { password: "patient123", role: "patient" }
};

// ================= GDPR LOGGING =================

function logGDPR(email, action, patientName, lawfulBasis, purpose, dataCategories, details) {
  auditLogs.push({
    timestamp: new Date().toISOString(),
    clinician_email: email,
    action,
    patient_name: patientName,
    lawful_basis: lawfulBasis,
    purpose,
    data_categories: dataCategories,
    recipients: "System",
    international_transfer: "None",
    details
  });
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
  res.json(auditLogs);
});

app.get('/gdpr/export', (req, res) => {
  res.json({ controller: "DOCTORPD", records: auditLogs });
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
        name: "Musculoskeletal issue",
        likelihood: "High",
        reason: "Symptoms suggest a non-critical musculoskeletal condition"
      }
    ],
    overall_assessment: "Stable. Continue monitoring and conservative management.",
    revenue_prompts: [
      { message: "Add detailed examination findings", value: 420 }
    ],
    funding: { baseline: 1450, potential: 2100, uplift: 650 }
  });
});

// ================= DIAGNOSTICS =================

app.post('/ai/diagnostics-assist', (req, res) => {
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
        reason: "Common presentation based on description"
      }
    ],
    recommended_diagnostics: {
      imaging: [
        {
          test: "X-ray",
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
    suggestions: ["Add laterality", "Document pain score"],
    funding_prompts: [
      { prompt: "Functional limitation", estimated_uplift: 350 }
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

  cases.push({
    id: cases.length + 1,
    patientName,
    predicted,
    actual: actual || 0,
    created_at: new Date().toISOString()
  });

  res.sendStatus(201);
});

app.get('/pilot/data', (req, res) => {
  res.json(cases);
});

app.get('/pilot/metrics', (req, res) => {
  const predicted = cases.reduce((a, b) => a + Number(b.predicted || 0), 0);
  const actual = cases.reduce((a, b) => a + Number(b.actual || 0), 0);

  res.json({
    predicted,
    actual,
    delta: actual - predicted,
    total: cases.length
  });
});

// ================= HEALTH =================

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'DOCTORPD'
  });
});

// ================= SERVER =================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
