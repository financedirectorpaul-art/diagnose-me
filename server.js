import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

let cases = [];
let auditLogs = [];
let overrides = [];

const SAFETY_NOTICE =
  "Decision support only. Not a diagnosis. Requires clinician review. If symptoms are severe or urgent, seek medical care immediately.";

function now() {
  return new Date().toISOString();
}

function money(n) {
  return Number(n || 0);
}

function audit(action, details = {}) {
  auditLogs.push({
    id: auditLogs.length + 1,
    timestamp: now(),
    action,
    details
  });
}

function classify(text = "") {
  const t = text.toLowerCase();

  if (/(chest pain|chest pressure|heart attack|cardiac|palpitations|crushing chest)/.test(t)) return "cardiac";
  if (/(stroke|slurred|facial droop|one sided weakness|weak arm|weak leg|seizure|confusion)/.test(t)) return "neurological";
  if (/(can't breathe|cannot breathe|blue lips|shortness of breath|sob|wheeze|pneumonia|cough|respiratory|low oxygen|hypoxia)/.test(t)) return "respiratory";
  if (/(sepsis|infection|fever|chills|cellulitis|pus|red hot|wound infection)/.test(t)) return "infection";
  if (/(fracture|broken|fall|injury|trauma|twisted|sprain|deformed|open wound|cannot weight bear|can't weight bear)/.test(t)) return "trauma";
  if (/(knee|ankle|hip|shoulder|elbow|wrist|joint|muscle|sore|pain|ache|stiff|swelling|locked)/.test(t)) return "musculoskeletal";
  if (/(depressed|anxious|panic|suicidal|kill myself|mental health|self harm)/.test(t)) return "mental_health";

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

function buildAssessment(symptoms, answers) {
  const combined = `${symptoms || ""} ${answers.join(" ")}`;
  const type = classify(combined);
  const red = emergencyTrigger(combined);

  if (red) {
    return {
      mode: "final",
      case_type: type,
      triage_score: 100,
      urgency: "EMERGENCY",
      confidence: 95,
      uncertainty: "High confidence because a critical red flag was detected.",
      red_flags: [red],
      conditions: [],
      differential: [],
      overall_assessment: "Emergency red flag detected. The patient should seek urgent medical care immediately.",
      icd: { code: "R68.89", description: "Other general symptoms and signs", confidence: 70 },
      cpt: "Emergency evaluation required",
      denial_risk: "N/A",
      missing_information: [],
      advice: "Seek emergency care immediately. If in Australia, call 000 now.",
      revenue_prompts: [],
      funding: { baseline: 0, potential: 0, uplift: 0 },
      legal_notice: SAFETY_NOTICE
    };
  }

  if (type === "respiratory") {
    return {
      mode: "final",
      case_type: "respiratory",
      triage_score: 85,
      urgency: "High",
      confidence: 82,
      uncertainty: "Confidence depends on oxygen saturation, respiratory rate, temperature, examination and chest imaging.",
      red_flags: [],
      differential: [
        {
          rank: 1,
          condition: "Pneumonia",
          probability: 55,
          likelihood: "high",
          icd_suggestion: { code: "J18.9", description: "Pneumonia, unspecified organism", coding_note: "Indicative only. Confirm organism/severity if known." }
        },
        {
          rank: 2,
          condition: "Acute bronchitis or viral lower respiratory infection",
          probability: 25,
          likelihood: "moderate",
          icd_suggestion: { code: "J20.9", description: "Acute bronchitis, unspecified", coding_note: "Use only if clinically supported." }
        },
        {
          rank: 3,
          condition: "Asthma/COPD exacerbation or other respiratory cause",
          probability: 20,
          likelihood: "moderate",
          icd_suggestion: { code: "R06.0", description: "Dyspnoea", coding_note: "Clarify underlying diagnosis." }
        }
      ],
      conditions: [
        { name: "Pneumonia", likelihood: "High", reason: "Respiratory symptoms and pneumonia-like presentation." },
        { name: "Acute bronchitis or viral respiratory infection", likelihood: "Moderate", reason: "Can present similarly and requires clinical confirmation." }
      ],
      overall_assessment: "Pneumonia or significant lower respiratory infection should be considered. Clinical confirmation should include vital signs, oxygen saturation, respiratory examination and chest imaging where appropriate.",
      icd: { code: "J18.9", description: "Pneumonia, unspecified organism", confidence: 90 },
      cpt: "99223",
      denial_risk: "Moderate",
      missing_information: ["Oxygen saturation", "Respiratory rate", "Temperature", "Chest X-ray result", "Comorbidities"],
      advice: "Assess oxygenation, respiratory effort and systemic features. Escalate urgently if severe breathlessness, hypoxia, confusion, chest pain or deterioration occurs.",
      revenue_prompts: [
        { message: "Document oxygen saturation and oxygen requirement", value: 1800 },
        { message: "Clarify severity, hypoxia or sepsis if clinically present", value: 2500 },
        { message: "Document chest imaging findings", value: 900 }
      ],
      funding: { baseline: 4000, potential: 7200, uplift: 3200 },
      legal_notice: SAFETY_NOTICE
    };
  }

  if (type === "trauma") {
    return {
      mode: "final",
      case_type: "trauma",
      triage_score: 90,
      urgency: "High",
      confidence: 82,
      uncertainty: "Fracture type, laterality, neurovascular status and imaging findings are required.",
      red_flags: [],
      differential: [
        {
          rank: 1,
          condition: "Fracture or suspected fracture",
          probability: 50,
          likelihood: "high",
          icd_suggestion: { code: "T14.2", description: "Fracture of unspecified body region", coding_note: "Replace with site-specific code after imaging." }
        },
        {
          rank: 2,
          condition: "Soft tissue injury",
          probability: 35,
          likelihood: "moderate",
          icd_suggestion: { code: "T14.9", description: "Injury, unspecified", coding_note: "Clarify site and tissue involved." }
        },
        {
          rank: 3,
          condition: "Dislocation or significant joint injury",
          probability: 15,
          likelihood: "moderate",
          icd_suggestion: { code: "T14.3", description: "Dislocation, sprain and strain of unspecified body region", coding_note: "Clarify site and imaging findings." }
        }
      ],
      conditions: [
        { name: "Fracture or suspected fracture", likelihood: "High", reason: "Trauma or broken/fracture-related presentation." },
        { name: "Soft tissue injury", likelihood: "Moderate", reason: "Trauma may also involve ligament, tendon or muscular injury." }
      ],
      overall_assessment: "Suspected fracture or significant traumatic injury. Assess neurovascular status, immobilise if appropriate and arrange imaging.",
      icd: { code: "T14.2", description: "Fracture of unspecified body region", confidence: 80 },
      cpt: "99223",
      denial_risk: "Low",
      missing_information: ["Mechanism of injury", "Laterality", "Neurovascular status", "Imaging result", "Open or closed injury"],
      advice: "Avoid weight-bearing if lower limb injury is suspected. Seek urgent assessment if deformity, open wound, severe pain, numbness, blue/cold limb or inability to use the limb is present.",
      revenue_prompts: [
        { message: "Document mechanism of injury", value: 900 },
        { message: "Document neurovascular status", value: 1200 },
        { message: "Document imaging findings and injury type", value: 1800 }
      ],
      funding: { baseline: 3500, potential: 6200, uplift: 2700 },
      legal_notice: SAFETY_NOTICE
    };
  }

  if (type === "musculoskeletal") {
    return {
      mode: "final",
      case_type: "musculoskeletal",
      triage_score: 45,
      urgency: "Low to Moderate",
      confidence: 76,
      uncertainty: "Confidence depends on trauma history, swelling, range of motion, laterality, pain score and functional limitation.",
      red_flags: [],
      differential: [
        {
          rank: 1,
          condition: "Musculoskeletal joint pain",
          probability: 50,
          likelihood: "high",
          icd_suggestion: { code: "M25.569", description: "Pain in knee, unspecified", coding_note: "Specify laterality if known." }
        },
        {
          rank: 2,
          condition: "Soft tissue injury",
          probability: 30,
          likelihood: "moderate",
          icd_suggestion: { code: "S83.9", description: "Sprain and strain of unspecified parts of knee", coding_note: "Use only if injury is supported." }
        },
        {
          rank: 3,
          condition: "Degenerative joint disease",
          probability: 20,
          likelihood: "low",
          icd_suggestion: { code: "M17.9", description: "Gonarthrosis, unspecified", coding_note: "Use only if clinically supported." }
        }
      ],
      conditions: [
        { name: "Musculoskeletal joint pain", likelihood: "High", reason: "Localised sore knee/joint pain presentation." },
        { name: "Soft tissue injury", likelihood: "Moderate", reason: "Possible if related to strain, twisting or overuse." },
        { name: "Degenerative joint disease", likelihood: "Low", reason: "Possible if chronic, recurrent or age-related." }
      ],
      overall_assessment: "Likely musculoskeletal knee or joint pain. Further assessment should clarify onset, injury mechanism, swelling, range of motion, weight-bearing ability and severity.",
      icd: { code: "M25.569", description: "Pain in knee, unspecified", confidence: 80 },
      cpt: "99213",
      denial_risk: "Low",
      missing_information: ["Laterality", "Pain score", "Swelling", "Range of motion", "Ability to bear weight", "Functional impact"],
      advice: "Consider clinical review if pain is severe, persistent, worsening, associated with swelling, locking, instability, fever, inability to bear weight, or trauma.",
      revenue_prompts: [
        { message: "Document laterality", value: 300 },
        { message: "Document pain score and functional limitation", value: 600 },
        { message: "Document range of motion and weight-bearing status", value: 700 }
      ],
      funding: { baseline: 1400, potential: 3000, uplift: 1600 },
      legal_notice: SAFETY_NOTICE
    };
  }

  return {
    mode: "final",
    case_type: "general",
    triage_score: 60,
    urgency: "Moderate",
    confidence: 45,
    uncertainty: "Insufficient clinical detail to provide a specific assessment.",
    red_flags: [],
    differential: [
      {
        rank: 1,
        condition: "General clinical presentation",
        probability: 100,
        likelihood: "moderate",
        icd_suggestion: { code: "R69", description: "Illness, unspecified", coding_note: "More specific diagnosis required." }
      }
    ],
    conditions: [
      { name: "General clinical presentation", likelihood: "Moderate", reason: "Limited information provided." }
    ],
    overall_assessment: "Further clinical information is required to refine the assessment.",
    icd: { code: "R69", description: "Illness, unspecified", confidence: 50 },
    cpt: "99213",
    denial_risk: "Moderate",
    missing_information: ["Duration", "Severity", "Associated symptoms", "Relevant history", "Examination findings"],
    advice: "Provide more symptom detail and seek clinical review if symptoms are severe, worsening or concerning.",
    revenue_prompts: [
      { message: "Document symptom duration and severity", value: 500 },
      { message: "Document relevant comorbidities", value: 700 }
    ],
    funding: { baseline: 1500, potential: 2300, uplift: 800 },
    legal_notice: SAFETY_NOTICE
  };
}

app.post("/ai/personal-check", (req, res) => {
  const { symptoms = "", answers = [], questionIndex = 0 } = req.body;
  const combined = `${symptoms} ${answers.join(" ")}`;
  const type = classify(combined);
  const qs = questionsFor(type);

  audit("CLINICAL_INPUT", { symptoms, answers, questionIndex, type });

  const red = emergencyTrigger(combined);
  if (red) {
    const emergency = buildAssessment(symptoms, answers);
    audit("EMERGENCY_INTERRUPT", emergency);
    return res.json(emergency);
  }

  if (questionIndex < qs.length) {
    return res.json({
      mode: "question",
      question: qs[questionIndex],
      questionIndex,
      totalQuestions: qs.length,
      urgency: "Pending",
      triage_score: 0,
      confidence: 10,
      uncertainty: "Gathering structured clinical information.",
      legal_notice: SAFETY_NOTICE
    });
  }

  const response = buildAssessment(symptoms, answers);
  audit("CLINICAL_OUTPUT", response);
  res.json(response);
});

app.post("/ai/diagnostics-assist", (req, res) => {
  const { description = "", imageBase64 = "" } = req.body;
  const type = classify(description);

  const response = {
    image_assessment: imageBase64
      ? `Image received. Assessment is based on the image plus description: ${description || "No description provided."}`
      : `Assessment based on description: ${description || "No description provided."}`,
    triage: { score: type === "trauma" ? 80 : 60, urgency: type === "trauma" ? "High" : "Moderate" },
    possible_conditions: buildAssessment(description, []).conditions || [],
    recommended_diagnostics: {
      imaging: [
        { test: "X-ray if trauma, deformity, swelling, or inability to bear weight", reason: "Rule out fracture or dislocation", urgency: type === "trauma" ? "Urgent" : "Routine/Urgent depending on severity" }
      ],
      pathology: type === "infection" || type === "respiratory"
        ? [{ test: "FBC, CRP, cultures if clinically indicated", reason: "Assess infection/severity", urgency: "Routine/Urgent depending on severity" }]
        : []
    },
    order_drafts: {
      imaging_request: "Clinician-reviewable imaging request draft. Please review, modify and authorise before use.",
      pathology_request: "Clinician-reviewable pathology request draft. Please review, modify and authorise before use."
    },
    safety_note: SAFETY_NOTICE
  };

  audit("DIAGNOSTICS_OUTPUT", response);
  res.json(response);
});

app.post("/ai/clinical-assist", (req, res) => {
  const { note = "" } = req.body;
  const type = classify(note);

  const response = {
    suggestions: [
      "Add diagnosis specificity",
      "Add laterality where relevant",
      "Document severity and pain score",
      "Document functional limitation",
      "Document relevant comorbidities",
      "Document investigation results and treatment plan"
    ],
    funding_prompts: [
      { prompt: "Document severity of illness", estimated_uplift: 900 },
      { prompt: "Document active comorbidities affecting care", estimated_uplift: 1200 },
      ...(type === "respiratory" ? [{ prompt: "Document oxygen requirement and hypoxia if present", estimated_uplift: 1800 }] : []),
      ...(type === "trauma" ? [{ prompt: "Document mechanism of injury and neurovascular status", estimated_uplift: 1600 }] : [])
    ],
    icd_opportunities: [
      { indicative_code: buildAssessment(note, []).icd.code, description: buildAssessment(note, []).icd.description, documentation_needed: "Validate diagnosis, specificity, laterality and supporting evidence." }
    ],
    audit_risks: [
      "Avoid coding unsupported diagnoses.",
      "Ensure documentation supports severity, treatment and investigations.",
      "Indicative ICD suggestions require coder validation."
    ],
    revenue: { base: 1500, potential: 4300, uplift: 2800 },
    legal_notice: SAFETY_NOTICE
  };

  audit("DOCUMENTATION_REVIEW", { note, response });
  res.json(response);
});

app.post("/drg/estimate", (req, res) => {
  const diagnosis = String(req.body.diagnosis || "").toLowerCase();

  let funding = 2450;
  if (diagnosis.includes("pneumonia")) funding = 5000;
  if (diagnosis.includes("respiratory")) funding = 4800;
  if (diagnosis.includes("sepsis")) funding = 8500;
  if (diagnosis.includes("fracture") || diagnosis.includes("broken")) funding = 6200;
  if (diagnosis.includes("knee") || diagnosis.includes("pain")) funding = 2400;

  res.json({ funding });
});

app.post("/pilot/track", (req, res) => {
  const { predicted, actual, patientName = "Unknown" } = req.body;

  const row = {
    id: cases.length + 1,
    patientName,
    predicted: money(predicted),
    actual: money(actual),
    created_at: now()
  };

  cases.push(row);
  audit("CASE_SAVED", row);

  res.status(201).json({ success: true, case: row });
});

app.get("/pilot/data", (req, res) => {
  res.json([...cases].reverse());
});

app.get("/pilot/metrics", (req, res) => {
  const predicted = cases.reduce((a, b) => a + money(b.predicted), 0);
  const actual = cases.reduce((a, b) => a + money(b.actual), 0);

  res.json({
    predicted,
    actual,
    delta: actual - predicted,
    total: cases.length
  });
});

app.post("/clinical/override", (req, res) => {
  const row = {
    id: overrides.length + 1,
    timestamp: now(),
    ...req.body
  };

  overrides.push(row);
  audit("CLINICIAN_OVERRIDE", row);

  res.json({ success: true, override: row });
});

app.get("/audit/data", (req, res) => {
  res.json([...auditLogs].reverse());
});

app.get("/gdpr/processing-activities", (req, res) => {
  res.json([...auditLogs].reverse());
});

app.get("/gdpr/export", (req, res) => {
  res.json({ controller: "DOCTORPD", records: [...auditLogs].reverse() });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "DOCTORPD",
    dependencies: "minimal",
    database: "in-memory",
    legal_notice: SAFETY_NOTICE
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`DOCTORPD running on port ${PORT}`);
});
