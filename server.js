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

// ================= CLINICAL AI =================

app.post('/ai/personal-check', (req, res) => {
  const input = (req.body.symptoms || "").toLowerCase();

  let response = {
    follow_up_questions: [],
    red_flags: [],
    triage_score: 50,
    urgency: "Moderate",
    conditions: [],
    overall_assessment: "",
    icd: {},
    cpt: "99213",
    denial_risk: "Low",
    revenue_prompts: [],
    funding: { baseline: 1500, potential: 2200, uplift: 700 }
  };

  // ================= PNEUMONIA =================
  if (input.includes("pneumonia")) {
    response = {
      ...response,
      triage_score: 85,
      urgency: "High",
      conditions: [
        {
          name: "Pneumonia",
          likelihood: "High",
          reason: "Direct symptom input"
        }
      ],
      overall_assessment:
        "Likely pneumonia. Requires clinical confirmation, chest imaging, and assessment of oxygenation.",
      icd: {
        code: "J18.9",
        description: "Pneumonia, unspecified organism",
        confidence: 90
      },
      cpt: "99223",
      denial_risk: "Moderate",
      follow_up_questions: [
        "Is there shortness of breath?",
        "Any fever or chills?",
        "Oxygen saturation?",
        "Any chest pain?",
        "Duration of symptoms?"
      ],
      revenue_prompts: [
        { message: "Document oxygen requirement", value: 1800 },
        { message: "Clarify severity (hypoxia/sepsis)", value: 2500 }
      ],
      funding: { baseline: 4000, potential: 6500, uplift: 2500 }
    };
  }

  // ================= FRACTURE =================
  else if (input.includes("fracture") || input.includes("broken")) {
    response = {
      ...response,
      triage_score: 90,
      urgency: "High",
      conditions: [
        { name: "Fracture", likelihood: "High", reason: "Trauma input" }
      ],
      overall_assessment:
        "Suspected fracture. Requires urgent imaging and immobilisation.",
      icd: {
        code: "S82.90",
        description: "Fracture of lower limb",
        confidence: 85
      },
      cpt: "99223",
      denial_risk: "Low",
      follow_up_questions: [
        "Can the patient bear weight?",
        "Is there deformity?",
        "Any numbness or tingling?"
      ]
    };
  }

  // ================= DEFAULT =================
  else {
    response = {
      ...response,
      triage_score: 60,
      urgency: "Moderate",
      conditions: [
        { name: "General condition", likelihood: "Moderate", reason: "Limited input" }
      ],
      overall_assessment:
        "Further clinical information required.",
      icd: {
        code: "R69",
        description: "Illness, unspecified",
        confidence: 50
      }
    };
  }

  res.json(response);
});

// ================= DIAGNOSTICS =================

app.post('/ai/diagnostics-assist', (req, res) => {
  const { description } = req.body;

  res.json({
    image_assessment: description || "No description provided",
    triage: { score: 68, urgency: "Moderate" },
    possible_conditions: [
      { name: "Soft tissue injury", likelihood: "High", reason: "Likely cause" }
    ],
    recommended_diagnostics: {
      imaging: [
        { test: "X-ray", reason: "Rule out fracture", urgency: "Routine" }
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
