import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

let users = {};
let cases = [];
let overrides = [];
let auditLogs = [];

const SAFETY_NOTICE =
  "Decision support only. Not a diagnosis. Requires clinician review. If symptoms are severe or urgent, seek medical care immediately.";

function now() {
  return new Date().toISOString();
}

function money(n) {
  return Number(n || 0);
}

function classify(text = "") {
  const t = text.toLowerCase();

  if (/(sore throat|throat pain|throat hurts|tonsillitis|pharyngitis|swollen tonsils|difficulty swallowing)/.test(t)) return "respiratory";
  if (/(cough|runny nose|stuffy nose|sinus|cold|flu|viral|post nasal drip)/.test(t)) return "respiratory";
  if (/(chest pain|chest pressure|heart attack|cardiac|palpitations|crushing chest)/.test(t)) return "cardiac";
  if (/(stroke|slurred|facial droop|one sided weakness|weak arm|weak leg|seizure|confusion)/.test(t)) return "neurological";
  if (/(can't breathe|cannot breathe|blue lips|shortness of breath|sob|wheeze|pneumonia|low oxygen|hypoxia)/.test(t)) return "respiratory";
  if (/(sepsis|infection|fever|chills|cellulitis|pus|red hot|wound infection)/.test(t)) return "infection";
  if (/(fracture|broken bone|broken|fall|injury|trauma|twisted|sprain|deformed|open wound|cannot weight bear|can't weight bear|broken arm|broken leg)/.test(t)) return "trauma";
  if (/(knee|ankle|hip|shoulder|elbow|wrist|joint|muscle|ache|stiff|swelling|locked|strain|sprain|back pain|neck pain|arthritis)/.test(t)) return "musculoskeletal";
  if (/(depressed|anxious|panic|suicidal|kill myself|mental health|self harm)/.test(t)) return "mental_health";
  if (/(stomach cramps|stomach pain|abdominal pain|cramps|belly ache|nausea|vomit|diarrhoea|diarrhea)/.test(t)) return "gastrointestinal";
  if (/(headache|head pain|migraine|dizzy|dizziness|vertigo|lightheaded)/.test(t)) return "general";

  return "general";
}

function questionsFor(type) {
  const sets = {
    respiratory: [
      "Is there shortness of breath at rest or only with activity?",
      "Is there fever, chills, productive cough, or chest pain?",
      "What is the oxygen saturation, if known?",
      "How long have the symptoms been present?",
      "Any asthma, COPD, heart disease, smoking history, or immunosuppression?"
    ],
    cardiac: [
      "When did the chest discomfort start?",
      "Does it radiate to the arm, jaw, back, neck, or shoulder?",
      "Is there shortness of breath, sweating, nausea, dizziness, or faintness?",
      "Is it worse with exertion or relieved by rest?",
      "Any history of heart disease, diabetes, hypertension, high cholesterol, or smoking?"
    ],
    neurological: [
      "When did the symptoms start, and were they sudden?",
      "Is there facial droop, slurred speech, weakness, numbness, confusion, or vision change?",
      "Is one side of the body affected?",
      "Any seizure, severe headache, loss of consciousness, or neck stiffness?",
      "Are symptoms improving, worsening, or unchanged?"
    ],
    infection: [
      "Is there fever, chills, sweats, or feeling very unwell?",
      "How long have the symptoms been present?",
      "Is there redness, warmth, swelling, pus, rash, or worsening pain?",
      "Any confusion, faintness, shortness of breath, fast heart rate, or low blood pressure?",
      "Any diabetes, immune suppression, wound, recent surgery, or recent hospital stay?"
    ],
    trauma: [
      "How did the injury happen?",
      "Can the patient bear weight or use the affected limb?",
      "Is there deformity, abnormal angling, severe swelling, or bruising?",
      "Any numbness, tingling, weakness, coldness, colour change, or reduced movement?",
      "Is there an open wound, bleeding, or bone visible?"
    ],
    musculoskeletal: [
      "When did the pain start?",
      "Was there an injury, twist, fall, sudden movement, or overuse?",
      "Is there swelling, redness, warmth, locking, stiffness, or instability?",
      "Can the joint move fully, and can weight be borne?",
      "How severe is the pain from 0 to 10, and what makes it better or worse?"
    ],
    mental_health: [
      "How long has the patient felt this way?",
      "Are there thoughts of self-harm or harming someone else?",
      "Is the patient sleeping, eating, and functioning normally?",
      "Any hallucinations, panic attacks, substance use, or recent major stress?",
      "Is there someone safe with the patient now?"
    ],
    gastrointestinal: [
      "When did the abdominal symptoms start?",
      "Is there vomiting, diarrhoea, fever, blood in stool, or severe pain?",
      "Where exactly is the pain located?",
      "Can the patient keep fluids down?",
      "Any recent travel, new foods, medication changes, or known medical conditions?"
    ],
    general: [
      "When did symptoms start?",
      "How severe are symptoms from 0 to 10?",
      "What makes symptoms better or worse?",
      "Any fever, chest pain, shortness of breath, weakness, vomiting, rash, swelling, or severe pain?",
      "Has this happened before, and are there relevant medical conditions?"
    ]
  };

  return sets[type] || sets.general;
}

function emergencyTrigger(text = "") {
  const t = text.toLowerCase();
  const triggers = [
    "chest pain",
    "crushing chest",
    "can't breathe",
    "cannot breathe",
    "blue lips",
    "stroke",
    "facial droop",
    "slurred speech",
    "unconscious",
    "severe bleeding",
    "open fracture",
    "bone visible",
    "blue foot",
    "cold foot",
    "suicidal",
    "kill myself"
  ];

  return triggers.find(x => t.includes(x));
}

function icdFor(type) {
  const map = {
    respiratory: { code: "R06.02", description: "Shortness of breath / respiratory symptom", confidence: 60 },
    cardiac: { code: "R07.9", description: "Chest pain, unspecified", confidence: 55 },
    neurological: { code: "R29.818", description: "Other symptoms involving nervous system", confidence: 50 },
    infection: { code: "B99.9", description: "Unspecified infectious disease", confidence: 45 },
    trauma: { code: "T14.90", description: "Injury, unspecified", confidence: 50 },
    musculoskeletal: { code: "M25.50", description: "Pain in unspecified joint", confidence: 55 },
    mental_health: { code: "F41.9", description: "Anxiety disorder, unspecified", confidence: 45 },
    gastrointestinal: { code: "R10.9", description: "Unspecified abdominal pain", confidence: 55 },
    general: { code: "R69", description: "Illness, unspecified", confidence: 40 }
  };

  return map[type] || map.general;
}

function buildAssessment(symptoms, answers = []) {
  const combined = `${symptoms || ""} ${answers.join(" ")}`;
  const type = classify(combined);
  const red = emergencyTrigger(combined);

  if (red) {
    return {
      mode: "final",
      triage_score: 100,
      urgency: "EMERGENCY",
      confidence: 95,
      uncertainty: "Low for escalation need; diagnosis still requires clinician review.",
      overall_assessment: `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}. Seek urgent medical care immediately.`,
      differential: [],
      conditions: [],
      icd: icdFor(type),
      cpt: "99285",
      denial_risk: "Low if emergency documentation supports medical necessity",
      missing_information: [],
      funding: { baseline: 1200, potential: 2500, uplift: 1300 },
      advice: "Escalate immediately. Do not rely on this app for emergency decision-making.",
      legal_notice: SAFETY_NOTICE
    };
  }

  let score = 45;
  let urgency = "Low to Moderate";

  if (type === "cardiac" || type === "neurological") {
    score = 75;
    urgency = "High";
  } else if (type === "respiratory" || type === "infection" || type === "trauma") {
    score = 65;
    urgency = "Moderate to High";
  } else if (type === "musculoskeletal") {
    score = 55;
    urgency = "Moderate";
  }

  const icd = icdFor(type);

  return {
    mode: "final",
    triage_score: score,
    urgency,
    confidence: 68,
    uncertainty: "Moderate. This is symptom-based decision support and needs clinician review.",
    overall_assessment: `Based on the information provided, this appears most consistent with a ${type.replace("_", " ")} presentation. There are no automatic emergency red flags detected in the information entered, but clinical review is still required.`,
    differential: [
      {
        rank: 1,
        condition: `${type.replace("_", " ")} condition`,
        probability: 55,
        likelihood: "Possible",
        icd_suggestion: icd
      },
      {
        rank: 2,
        condition: "Non-specific acute illness or injury",
        probability: 30,
        likelihood: "Possible",
        icd_suggestion: { code: "R69", description: "Illness, unspecified" }
      }
    ],
    conditions: [
      {
        name: `${type.replace("_", " ")} presentation`,
        likelihood: "Possible",
        reason: "The symptom wording and answers align with this category."
      }
    ],
    icd,
    cpt: score >= 70 ? "99284" : "99213",
    denial_risk: score >= 70 ? "Moderate" : "Low",
    missing_information: [
      "Vital signs",
      "Relevant past medical history",
      "Medication and allergy history",
      "Clinician examination findings"
    ],
    funding: {
      baseline: 1200,
      potential: score >= 70 ? 2200 : 1600,
      uplift: score >= 70 ? 1000 : 400
    },
    revenue_prompts: [
      {
        message: "Document symptom duration, severity, relevant negatives and examination findings.",
        value: 250
      },
      {
        message: "Record comorbidities, medications, observations and escalation decisions.",
        value: 300
      }
    ],
    advice:
      "Arrange appropriate clinical review. Escalate urgently if symptoms worsen, severe pain develops, breathing becomes difficult, neurological symptoms occur, or the patient appears significantly unwell.",
    legal_notice: SAFETY_NOTICE
  };
}

// ================= AUTH =================

app.post("/auth/register", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  if (users[email]) {
    return res.status(400).json({ error: "User already exists" });
  }

  users[email] = { password, patients: [] };

  auditLogs.push({
    timestamp: now(),
    action: "REGISTER",
    details: { email }
  });

  res.json({ success: true });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;

  if (!users[email] || users[email].password !== password) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  auditLogs.push({
    timestamp: now(),
    action: "LOGIN",
    details: { email }
  });

  res.json({ success: true });
});

// ================= PATIENTS =================

app.get("/patients", (req, res) => {
  const email = req.query.email;

  if (!users[email]) return res.json([]);

  res.json(users[email].patients);
});

app.post("/patients", (req, res) => {
  const { email, name, age, gender } = req.body;

  if (!users[email]) {
    return res.status(401).json({ error: "Not logged in" });
  }

  const patient = {
    id: Date.now().toString(),
    name,
    age,
    gender,
    createdAt: now()
  };

  users[email].patients.push(patient);

  auditLogs.push({
    timestamp: now(),
    action: "CREATE_PATIENT",
    details: { email, patient }
  });

  res.json(patient);
});

// ================= GUIDED TRIAGE =================

app.post("/ai/personal-check", async (req, res) => {
  try {
    let { symptoms = "", answers = [], questionIndex = 0 } = req.body;

    if (!Array.isArray(answers)) answers = [];

    const combined = `${symptoms} ${answers.join(" ")}`;
    const type = classify(combined);
    const red = emergencyTrigger(combined);

    if (red) {
      const emergency = buildAssessment(symptoms, answers);
      auditLogs.push({
        timestamp: now(),
        action: "GUIDED_TRIAGE_EMERGENCY",
        details: { symptoms, answers, emergency }
      });
      return res.json(emergency);
    }

    const qs = questionsFor(type);

    if (questionIndex < qs.length) {
      return res.json({
        mode: "question",
        question: qs[questionIndex],
        questionIndex,
        totalQuestions: qs.length,
        urgency: "Pending",
        triage_score: 0,
        legal_notice: SAFETY_NOTICE
      });
    }

    const final = buildAssessment(symptoms, answers);

    auditLogs.push({
      timestamp: now(),
      action: "GUIDED_TRIAGE_FINAL",
      details: { symptoms, answers, final }
    });

    res.json(final);
  } catch (err) {
    res.status(500).json({
      mode: "error",
      error: "Unable to process guided triage",
      details: err.message,
      legal_notice: SAFETY_NOTICE
    });
  }
});

// ================= FREE CHAT =================

app.post("/ai/ask-doctor", async (req, res) => {
  try {
    const { question = "", context = {} } = req.body;

    const priorSymptoms = context?.symptoms || "";
    const priorAnswers = Array.isArray(context?.answers) ? context.answers.join(" ") : "";

    const combined = `${priorSymptoms} ${priorAnswers} ${question}`;
    const type = classify(combined);
    const red = emergencyTrigger(combined);

    if (red) {
      return res.json({
        response: `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}.\n\nPlease seek urgent medical care immediately.\n\n${SAFETY_NOTICE}`
      });
    }

    let response = "";

    if (/cure|treatment|treat|what can i do|help/i.test(question)) {
      response =
        `This sounds ${type.replace("_", " ")}-related.\n\n` +
        `General treatment depends on the cause, severity, duration, age, medical history and examination findings. A clinician would usually confirm the diagnosis, assess red flags, and then consider options such as self-care, medication, imaging, pathology, physiotherapy, referral, or urgent escalation depending on the presentation.\n\n` +
        `To narrow this down: ${questionsFor(type)[0]}\n\n${SAFETY_NOTICE}`;
    } else {
      response =
        `Based on what you've said, this sounds ${type.replace("_", " ")}-related.\n\n` +
        `${questionsFor(type)[0]}\n\n${SAFETY_NOTICE}`;
    }

    auditLogs.push({
      timestamp: now(),
      action: "FREE_CHAT",
      details: { question, type }
    });

    res.json({ response });
  } catch (err) {
    res.status(500).json({
      response: `Sorry, I could not process that question safely.\n\n${SAFETY_NOTICE}`,
      error: err.message
    });
  }
});

// ================= DIAGNOSTICS =================

app.post("/ai/diagnostics-assist", (req, res) => {
  const { description = "", imageBase64 = "" } = req.body;

  const type = classify(description);

  res.json({
    image_assessment: imageBase64
      ? "Image received. A clinician should review image quality, anatomical site, visible abnormality, and red flags."
      : "No image supplied. Assessment is based on the description only.",
    triage: {
      score: type === "trauma" ? 70 : 50,
      urgency: type === "trauma" ? "Moderate to High" : "Moderate"
    },
    possible_conditions: [
      {
        name: `${type.replace("_", " ")} condition`,
        reason: "Suggested by the description provided."
      }
    ],
    recommended_diagnostics: {
      imaging: [
        {
          test: type === "trauma" ? "X-ray if fracture, deformity, severe pain or inability to use limb" : "Clinician-directed imaging if indicated",
          reason: "To confirm or exclude structural pathology where clinically appropriate."
        }
      ],
      pathology: [
        {
          test: "Clinician-directed blood tests if systemic symptoms are present",
          reason: "To assess infection, inflammation or other systemic causes if relevant."
        }
      ]
    },
    safety_note: SAFETY_NOTICE
  });
});

// ================= DOCUMENTATION ASSISTANT =================

app.post("/ai/clinical-assist", (req, res) => {
  const { note = "" } = req.body;
  const type = classify(note);

  res.json({
    suggestions: [
      "Document presenting complaint, onset, duration and severity.",
      "Include relevant positives and negatives.",
      "Record observations, examination findings and escalation decisions.",
      "Document clinician review and plan."
    ],
    funding_prompts: [
      {
        prompt: "Add objective observations and examination findings.",
        estimated_uplift: 300
      },
      {
        prompt: "Document comorbidities and functional impact.",
        estimated_uplift: 250
      }
    ],
    icd_opportunities: [
      {
        indicative_code: icdFor(type).code,
        description: icdFor(type).description,
        documentation_needed: "Confirm diagnosis clinically and document supporting findings."
      }
    ],
    audit_risks: [
      "Diagnosis unsupported by examination findings.",
      "Missing severity, duration or relevant negative findings.",
      "No clear clinician review statement."
    ],
    legal_notice: SAFETY_NOTICE
  });
});

// ================= FUNDING / PILOT =================

app.post("/drg/estimate", (req, res) => {
  const { diagnosis = "" } = req.body;
  const type = classify(diagnosis);

  const base = type === "cardiac" || type === "neurological" ? 3200 : type === "trauma" ? 2400 : 1600;

  res.json({
    diagnosis,
    type,
    funding: base,
    assumptions: [
      "Indicative only.",
      "Final funding depends on coded episode, documentation, classification and local rules."
    ]
  });
});

app.post("/pilot/track", (req, res) => {
  const row = {
    id: Date.now().toString(),
    patientName: req.body.patientName || "Demo patient",
    predicted: money(req.body.predicted),
    actual: money(req.body.actual),
    created_at: now()
  };

  cases.push(row);

  auditLogs.push({
    timestamp: now(),
    action: "PILOT_TRACK",
    details: row
  });

  res.status(201).json({ success: true, case: row });
});

app.get("/pilot/data", (req, res) => {
  res.json(cases);
});

app.get("/pilot/metrics", (req, res) => {
  const predicted = cases.reduce((s, c) => s + money(c.predicted), 0);
  const actual = cases.reduce((s, c) => s + money(c.actual), 0);

  res.json({
    predicted,
    actual,
    delta: actual - predicted,
    total: cases.length
  });
});

// ================= OVERRIDE / AUDIT / GDPR =================

app.post("/clinical/override", (req, res) => {
  const override = {
    id: Date.now().toString(),
    timestamp: now(),
    ...req.body
  };

  overrides.push(override);

  auditLogs.push({
    timestamp: now(),
    action: "CLINICIAN_OVERRIDE",
    details: override
  });

  res.json({ success: true, override });
});

app.get("/audit/data", (req, res) => {
  res.json(auditLogs);
});

app.get("/gdpr/processing-activities", (req, res) => {
  res.json([
    {
      activity: "Clinical decision support",
      lawful_basis: "User-entered demonstration data",
      retention: "In-memory only in this prototype"
    }
  ]);
});

app.get("/gdpr/export", (req, res) => {
  res.json({
    controller: "DOCTORPD",
    exported_at: now(),
    users,
    cases,
    overrides,
    auditLogs
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    time: now(),
    legal_notice: SAFETY_NOTICE
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`✅ DOCTORPD running on port ${PORT}`);
});
