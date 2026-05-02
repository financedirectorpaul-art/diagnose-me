import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT || 10000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SAFETY_NOTICE =
  "Decision support only. Not a diagnosis. Requires clinician review. If symptoms are severe, worsening, or urgent, seek medical care immediately.";

const users = {};
const cases = [];
const overrides = [];
const auditLogs = [];
const rateBucket = new Map();

function now() {
  return new Date().toISOString();
}

function audit(action, details = {}) {
  auditLogs.push({
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    timestamp: now(),
    action,
    details
  });

  if (auditLogs.length > 1000) auditLogs.shift();
}

function money(n) {
  return Number(n || 0);
}

function simpleRateLimit(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const count = rateBucket.get(key) || 0;

  if (count > 80) {
    return res.status(429).json({
      error: "Too many requests. Please slow down.",
      legal_notice: SAFETY_NOTICE
    });
  }

  rateBucket.set(key, count + 1);
  if (rateBucket.size > 5000) rateBucket.clear();

  next();
}

app.use(simpleRateLimit);

function classify(text = "") {
  const t = String(text).toLowerCase();

  if (/(chest pain|chest pressure|heart attack|cardiac|palpitations|crushing chest|angina)/.test(t)) return "cardiac";
  if (/(stroke|slurred|facial droop|one sided weakness|weak arm|weak leg|seizure|confusion|vision loss)/.test(t)) return "neurological";
  if (/(can't breathe|cannot breathe|blue lips|shortness of breath|sob|wheeze|pneumonia|low oxygen|hypoxia|cough|flu|cold|sore throat|asthma|copd)/.test(t)) return "respiratory";
  if (/(sepsis|infection|fever|chills|cellulitis|pus|red hot|wound infection|abscess)/.test(t)) return "infection";
  if (/(fracture|broken bone|broken|fall|injury|trauma|twisted|twist|sprain|deformed|open wound|cannot weight bear|can't weight bear|hockey|sport)/.test(t)) return "trauma";
  if (/(knee|ankle|hip|shoulder|elbow|wrist|joint|muscle|ache|stiff|swelling|locked|strain|sprain|back pain|neck pain|arthritis|sore knee)/.test(t)) return "musculoskeletal";
  if (/(depressed|anxious|panic|suicidal|kill myself|mental health|self harm|self-harm)/.test(t)) return "mental_health";
  if (/(stomach|abdominal|belly|nausea|vomit|diarrhoea|diarrhea|constipation)/.test(t)) return "gastrointestinal";

  return "general";
}

function emergencyTrigger(text = "") {
  const t = String(text).toLowerCase();

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
    "kill myself",
    "worst headache",
    "neck stiffness",
    "new confusion"
  ];

  return triggers.find(x => t.includes(x));
}

function questionsFor(type) {
  const q = {
    cardiac: [
      "Does the discomfort spread to the arm, jaw, back, neck or shoulder?",
      "Is there shortness of breath, sweating, nausea, dizziness or faintness?",
      "Is it worse with exertion or relieved by rest?",
      "Any history of heart disease, diabetes, hypertension, high cholesterol or smoking?"
    ],
    respiratory: [
      "Are you short of breath at rest, or only with activity?",
      "Do you have fever, chills, productive cough, wheeze or chest pain?",
      "What is the oxygen saturation, if known?",
      "Any asthma, COPD, heart disease, smoking history or immune suppression?",
      "Are symptoms getting better, worse, or staying about the same?"
    ],
    musculoskeletal: [
      "Can you bear weight on it now?",
      "Were you able to continue playing or walking immediately after it happened?",
      "Did swelling appear straight away, later, or not at all?",
      "Is the knee locking, catching, or giving way?",
      "Can you fully bend and straighten it?"
    ],
    neurological: [
      "Did the symptoms start suddenly?",
      "Is there facial droop, slurred speech, weakness, numbness, confusion or vision change?",
      "Is one side of the body affected?",
      "Any seizure, severe headache, loss of consciousness or neck stiffness?",
      "Are symptoms improving, worsening or unchanged?"
    ],
    infection: [
      "Is there fever, chills, sweats or feeling very unwell?",
      "Is there redness, warmth, swelling, pus, rash or worsening pain?",
      "Any confusion, faintness, shortness of breath, fast heart rate or low blood pressure?",
      "Any diabetes, immune suppression, wound, recent surgery or recent hospital stay?",
      "Are symptoms spreading or worsening?"
    ],
    trauma: [
      "Can you bear weight on it now?",
      "Were you able to continue playing or walking immediately after it happened?",
      "Is there deformity, abnormal angling, severe swelling or bruising?",
      "Any numbness, tingling, weakness, coldness, colour change or reduced movement?",
      "Is there an open wound, bleeding or bone visible?"
    ],
    mental_health: [
      "Are there thoughts of self-harm or harming someone else?",
      "Is the patient sleeping, eating and functioning normally?",
      "Any hallucinations, panic attacks, substance use or recent major stress?",
      "Is there someone safe with the patient now?",
      "Has this been getting worse recently?"
    ],
    gastrointestinal: [
      "Where exactly is the pain located?",
      "Is there vomiting, diarrhoea, fever, blood in stool or severe pain?",
      "Can the patient keep fluids down?",
      "Any recent travel, new foods, medication changes or known medical conditions?",
      "Is the pain constant, cramping, burning or sharp?"
    ],
    general: [
      "What is the main symptom troubling you most right now?",
      "How severe are symptoms from 0 to 10?",
      "What makes symptoms better or worse?",
      "Any fever, chest pain, shortness of breath, weakness, vomiting, rash, swelling or severe pain?",
      "Has this happened before, and are there relevant medical conditions?"
    ]
  };

  return q[type] || q.general;
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

function cleanJsonText(text = "") {
  return String(text)
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

function isDuplicateQuestion(nextQuestion = "", askedQuestions = [], facts = {}) {
  const q = String(nextQuestion).toLowerCase();

  if (!q) return true;

  if (facts.mechanismKnown && /(how did|what happened|mechanism|specific injury|twist|fall|overuse)/.test(q)) return true;
  if (facts.onsetKnown && /(when did|how long|start|began|begin)/.test(q)) return true;
  if (facts.weightBearingKnown && /(bear weight|walk|walking)/.test(q)) return true;
  if (facts.swellingKnown && /(swelling|swollen)/.test(q)) return true;

  return askedQuestions.some(prev => {
    const p = String(prev).toLowerCase();
    if (p === q) return true;

    const groups = [
      ["when did", "how long", "start", "began", "onset"],
      ["how did", "what happened", "mechanism", "specific injury", "twist", "fall", "overuse"],
      ["bear weight", "walk", "walking"],
      ["swelling", "swollen"],
      ["locking", "catching", "giving way", "unstable"],
      ["bend", "straighten", "move fully"]
    ];

    return groups.some(group => group.some(word => p.includes(word)) && group.some(word => q.includes(word)));
  });
}

function chooseFallbackQuestion(type, askedQuestions = [], facts = {}) {
  const candidates = questionsFor(type);
  return candidates.find(q => !isDuplicateQuestion(q, askedQuestions, facts))
    || "What is the most concerning thing about it right now — pain, swelling, instability, inability to walk, numbness, or something else?";
}

function normaliseQuestion(question = "", type = "general", askedQuestions = [], facts = {}) {
  let q = String(question || "").trim();

  if (!q || isDuplicateQuestion(q, askedQuestions, facts)) {
    q = chooseFallbackQuestion(type, askedQuestions, facts);
  }

  if (facts.mechanismKnown && /(how did|what happened|mechanism|specific injury|twist|fall|overuse)/i.test(q)) {
    q = "Were you able to continue playing or walking immediately after it happened?";
  }

  if (facts.onsetKnown && /(when did|how long|start|began|begin|onset)/i.test(q)) {
    q = "Has it been getting better, worse, or staying about the same?";
  }

  if (facts.weightBearingKnown && /(bear weight|walk|walking)/i.test(q)) {
    q = "Is the knee locking, catching, or giving way?";
  }

  return q;
}

function fallbackAssessment(symptoms, answers = [], facts = {}) {
  const combined = `${symptoms || ""} ${answers.join(" ")}`;
  const type = classify(combined);
  const red = emergencyTrigger(combined);
  const icd = icdFor(type);

  if (red) {
    return {
      mode: "final",
      triage_score: 100,
      urgency: "EMERGENCY",
      confidence: 95,
      uncertainty: "Emergency red flag detected. Diagnosis still requires clinician review.",
      overall_assessment: `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}. Seek urgent medical care immediately.`,
      differential: [],
      conditions: [],
      icd,
      cpt: "99285",
      denial_risk: "Low if emergency documentation supports medical necessity",
      missing_information: [],
      funding: { baseline: 1200, potential: 2500, uplift: 1300 },
      revenue_prompts: [],
      advice: "Escalate immediately. Do not rely on this app for emergency decision-making.",
      legal_notice: SAFETY_NOTICE
    };
  }

  const score =
    type === "cardiac" || type === "neurological" ? 78 :
    type === "respiratory" || type === "infection" || type === "trauma" ? 66 :
    type === "musculoskeletal" ? 52 :
    45;

  const kneeMechanism = facts.mechanismKnown && /(knee|hockey|twist|twisted|sport)/i.test(combined);

  return {
    mode: "final",
    triage_score: score,
    urgency: score >= 75 ? "High" : score >= 60 ? "Moderate to High" : "Moderate",
    confidence: 62,
    uncertainty: "Moderate. This is symptom-based decision support and requires clinician review.",
    overall_assessment:
      kneeMechanism
        ? "The history suggests a twisting sports-related knee injury. Key possibilities include ligament sprain, meniscal injury, or less commonly fracture. Clinical review is required, especially if weight-bearing is difficult, swelling is significant, or the joint is locking or unstable."
        : `Based on the information provided, this appears most consistent with a ${type.replace("_", " ")} presentation. Clinical review is still required.`,
    differential: kneeMechanism
      ? [
          { rank: 1, condition: "Ligament sprain or tear", probability: 40, likelihood: "Possible", reasoning: "Twisting sports mechanism can stress knee ligaments.", icd_suggestion: { code: "S83.90", description: "Sprain of unspecified site of knee" } },
          { rank: 2, condition: "Meniscal injury", probability: 35, likelihood: "Possible", reasoning: "Twisting injuries can cause meniscal symptoms such as locking, catching or joint-line pain.", icd_suggestion: { code: "S83.20", description: "Tear of meniscus, current injury" } },
          { rank: 3, condition: "Fracture or bone injury", probability: 25, likelihood: "Possible", reasoning: "Needs consideration if unable to bear weight, severe bony tenderness or marked swelling.", icd_suggestion: { code: "S82.90", description: "Fracture of lower leg, unspecified" } }
        ]
      : [
          { rank: 1, condition: `${type.replace("_", " ")} condition`, probability: 55, likelihood: "Possible", reasoning: "The symptom wording and answers align with this category.", icd_suggestion: icd },
          { rank: 2, condition: "Non-specific acute illness or injury", probability: 25, likelihood: "Possible", reasoning: "More detail and examination findings are needed.", icd_suggestion: { code: "R69", description: "Illness, unspecified" } }
        ],
    conditions: [
      {
        name: kneeMechanism ? "Sports-related knee injury" : `${type.replace("_", " ")} presentation`,
        likelihood: "Possible",
        reason: kneeMechanism ? "Twisting mechanism at hockey." : "Suggested by symptom category."
      }
    ],
    icd: kneeMechanism ? { code: "S83.90", description: "Sprain of unspecified site of knee", confidence: 50 } : icd,
    cpt: score >= 70 ? "99284" : "99213",
    denial_risk: score >= 70 ? "Moderate" : "Low",
    missing_information: [
      "Ability to bear weight",
      "Swelling timing and severity",
      "Locking, catching or instability",
      "Bony tenderness",
      "Clinician examination findings"
    ],
    funding: {
      baseline: 1200,
      potential: score >= 70 ? 2200 : 1600,
      uplift: score >= 70 ? 1000 : 400
    },
    revenue_prompts: [
      { message: "Document mechanism of injury and immediate functional impact.", value: 250 },
      { message: "Record weight-bearing ability, swelling, instability and examination findings.", value: 300 }
    ],
    advice:
      "Arrange clinical review. Seek urgent care if unable to bear weight, there is severe swelling, deformity, numbness, coldness, colour change, severe pain, or the knee is locked.",
    legal_notice: SAFETY_NOTICE
  };
}

async function callClinicalAI(payload) {
  if (!openai) return null;

  const system = `
You are DOCTORPD acting as a senior consultant clinician.

You are a clinical decision-support AI, not a doctor. You must not present output as a diagnosis. Always require clinician review.

You use hypothesis-driven clinical reasoning.

Critical rules:
- Ask ONE best next discriminating question only.
- Never use numbered-question language.
- Never repeat or rephrase a previous question.
- Use the facts object. If facts.mechanismKnown is true, do NOT ask how the injury happened, whether there was a twist, fall, overuse, or specific injury.
- If facts.onsetKnown is true, do NOT ask when symptoms started or how long they have been present.
- If facts.weightBearingKnown is true, do NOT ask whether they can walk or bear weight.
- If facts.swellingKnown is true, do NOT ask whether swelling is present; ask a more advanced question if clinically useful.
- If the patient has said they twisted it at hockey, treat mechanism as known and move to weight-bearing, immediate function, swelling timing, locking/catching/giving way, or neurovascular symptoms.
- Prioritise dangerous conditions first.
- If emergency red flags are suggested, finalise with urgency EMERGENCY.
- Stop asking questions when preliminary assessment or escalation decision is sufficiently clear.
- Do not diagnose definitively.

Return ONLY valid JSON.

If asking another question:
{
  "mode": "question",
  "question": "single best next discriminating question",
  "reasoning": "why this question matters",
  "clinicalState": {
    "suspectedCategory": "string",
    "keyFindings": ["string"],
    "missingCritical": ["string"],
    "redFlagsChecked": ["string"],
    "hypotheses": [
      {"condition": "string", "probability": 0, "reasoning": "string"},
      {"condition": "string", "probability": 0, "reasoning": "string"},
      {"condition": "string", "probability": 0, "reasoning": "string"}
    ]
  },
  "legal_notice": "${SAFETY_NOTICE}"
}

If final:
{
  "mode": "final",
  "triage_score": 0,
  "urgency": "Low | Moderate | Moderate to High | High | EMERGENCY",
  "confidence": 0,
  "uncertainty": "string",
  "overall_assessment": "string",
  "differential": [
    {
      "rank": 1,
      "condition": "string",
      "probability": 0,
      "likelihood": "Unlikely | Possible | Likely",
      "reasoning": "string",
      "icd_suggestion": {
        "code": "string",
        "description": "string"
      }
    }
  ],
  "conditions": [
    {
      "name": "string",
      "likelihood": "string",
      "reason": "string"
    }
  ],
  "icd": {
    "code": "string",
    "description": "string",
    "confidence": 0
  },
  "cpt": "string",
  "denial_risk": "Low | Moderate | High",
  "missing_information": ["string"],
  "funding": {
    "baseline": 0,
    "potential": 0,
    "uplift": 0
  },
  "revenue_prompts": [
    {
      "message": "string",
      "value": 0
    }
  ],
  "clinicalState": {
    "suspectedCategory": "string",
    "keyFindings": ["string"],
    "missingCritical": ["string"],
    "redFlagsChecked": ["string"],
    "hypotheses": [
      {"condition": "string", "probability": 0, "reasoning": "string"}
    ]
  },
  "advice": "string",
  "legal_notice": "${SAFETY_NOTICE}"
}
`;

  const user = `
Patient:
${JSON.stringify(payload.patient || {}, null, 2)}

Initial complaint:
${payload.symptoms || ""}

Previous questions already asked:
${(payload.askedQuestions || []).map(q => `- ${q}`).join("\n") || "None"}

Previous answers:
${(payload.answers || []).map((a, i) => `${i + 1}. ${a}`).join("\n") || "None"}

Known facts:
${JSON.stringify(payload.facts || {}, null, 2)}

Current clinical state:
${JSON.stringify(payload.clinicalState || {}, null, 2)}

Latest user input:
${payload.currentText || ""}

Image supplied:
${payload.imageBase64 ? "Yes" : "No"}

Task:
Use senior-consultant hypothesis-driven reasoning. Do not ask for information already known in facts. Either ask one high-value discriminating question or provide final structured decision-support assessment.
`;

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content || "{}";
  return JSON.parse(cleanJsonText(raw));
}

async function callFreeChatAI(question, context = {}) {
  if (!openai) return null;

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.35,
    messages: [
      {
        role: "system",
        content:
          "You are DOCTORPD, a clinical decision-support assistant. Do not diagnose definitively. Be clear, safe and conversational. Escalate emergency red flags. Ask one useful follow-up question if needed."
      },
      {
        role: "user",
        content: `User question:\n${question}\n\nKnown context:\n${JSON.stringify(context || {}, null, 2)}`
      }
    ]
  });

  return completion.choices?.[0]?.message?.content || "";
}

// AUTH
app.post("/auth/register", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (users[email]) return res.status(400).json({ error: "User already exists" });

  users[email] = { password, patients: [], created_at: now() };
  audit("REGISTER", { email });

  res.json({ success: true });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;

  if (!users[email] || users[email].password !== password) {
    audit("LOGIN_FAILED", { email });
    return res.status(401).json({ error: "Invalid email or password" });
  }

  audit("LOGIN", { email });
  res.json({ success: true });
});

// PATIENTS
app.get("/patients", (req, res) => {
  const email = req.query.email;
  if (!users[email]) return res.json([]);
  res.json(users[email].patients);
});

app.post("/patients", (req, res) => {
  const { email, name, age, gender } = req.body;

  if (!users[email]) return res.status(401).json({ error: "Not logged in" });

  const patient = { id: Date.now().toString(), name, age, gender, createdAt: now() };
  users[email].patients.push(patient);
  audit("CREATE_PATIENT", { email, patient });

  res.json(patient);
});

// GUIDED AI TRIAGE
app.post("/ai/personal-check", async (req, res) => {
  try {
    let {
      symptoms = "",
      answers = [],
      askedQuestions = [],
      clinicalState = {},
      facts = {},
      currentText = "",
      imageBase64 = "",
      patient = {}
    } = req.body;

    if (!Array.isArray(answers)) answers = [];
    if (!Array.isArray(askedQuestions)) askedQuestions = [];

    const combined = `${symptoms} ${answers.join(" ")} ${currentText}`;
    const type = classify(combined);
    const red = emergencyTrigger(combined);

    if (red) {
      const emergency = fallbackAssessment(combined, answers, facts);
      emergency.urgency = "EMERGENCY";
      emergency.triage_score = 100;
      emergency.overall_assessment = `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}. Seek urgent medical care immediately.`;
      return res.json(emergency);
    }

    let ai = null;

    try {
      ai = await callClinicalAI({
        symptoms,
        answers,
        askedQuestions,
        clinicalState,
        facts,
        currentText,
        imageBase64,
        patient
      });
    } catch (err) {
      audit("AI_ERROR_GUIDED", { error: err.message });
    }

    if (!ai || !ai.mode) {
      const enoughInfo = answers.length >= 5 || combined.length > 260;

      if (!enoughInfo) {
        const next = chooseFallbackQuestion(type, askedQuestions, facts);
        return res.json({
          mode: "question",
          question: next,
          reasoning: "Fallback adaptive question selected because AI reasoning was unavailable.",
          clinicalState,
          legal_notice: SAFETY_NOTICE
        });
      }

      ai = fallbackAssessment(symptoms, answers, facts);
    }

    if (ai.mode === "question") {
      const nextQuestion = normaliseQuestion(ai.question, type, askedQuestions, facts);

      audit("GUIDED_TRIAGE_QUESTION", {
        symptoms,
        answersCount: answers.length,
        askedCount: askedQuestions.length,
        facts,
        question: nextQuestion
      });

      return res.json({
        mode: "question",
        question: nextQuestion,
        reasoning: ai.reasoning || "This question helps narrow the likely causes and assess risk.",
        clinicalState: ai.clinicalState || clinicalState,
        hypotheses: ai.clinicalState?.hypotheses || ai.hypotheses || clinicalState?.hypotheses || [],
        legal_notice: SAFETY_NOTICE
      });
    }

    ai.legal_notice = SAFETY_NOTICE;
    res.json(ai);
  } catch (err) {
    audit("GUIDED_TRIAGE_SERVER_ERROR", { error: err.message });

    res.status(500).json({
      mode: "error",
      error: "Unable to process guided triage",
      details: err.message,
      legal_notice: SAFETY_NOTICE
    });
  }
});

// FREE CHAT
app.post("/ai/ask-doctor", async (req, res) => {
  try {
    const { question = "", context = {}, imageBase64 = "" } = req.body;
    const combined = `${question} ${JSON.stringify(context || {})}`;
    const red = emergencyTrigger(combined);

    if (red) {
      return res.json({
        response:
          `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}.\n\n` +
          `Please seek urgent medical care immediately.\n\n${SAFETY_NOTICE}`
      });
    }

    let response = null;

    try {
      response = await callFreeChatAI(question, { ...context, imageSupplied: !!imageBase64 });
    } catch (err) {
      audit("AI_ERROR_FREE_CHAT", { error: err.message });
    }

    if (!response) {
      const type = classify(question);
      response =
        `This sounds ${type.replace("_", " ")}-related, but I would need more detail before giving useful decision support.\n\n` +
        `${chooseFallbackQuestion(type, [], {})}\n\n${SAFETY_NOTICE}`;
    }

    res.json({ response });
  } catch (err) {
    res.status(500).json({
      response:
        `Sorry, I could not process that safely. Please rephrase or seek clinical help if symptoms are concerning.\n\n${SAFETY_NOTICE}`
    });
  }
});

// DIAGNOSTICS
app.post("/ai/diagnostics-assist", async (req, res) => {
  const { description = "", imageBase64 = "" } = req.body;
  const type = classify(description);

  let aiText = null;

  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.25,
        messages: [
          {
            role: "system",
            content:
              "You are a clinical documentation and diagnostic support assistant. You do not diagnose. Provide cautious decision support, red flags, and recommended next steps."
          },
          {
            role: "user",
            content:
              `Description: ${description}\nImage supplied: ${imageBase64 ? "yes" : "no"}\nProvide a concise image/diagnostic decision-support summary.`
          }
        ]
      });

      aiText = completion.choices?.[0]?.message?.content || null;
    } catch (err) {
      audit("AI_ERROR_DIAGNOSTICS", { error: err.message });
    }
  }

  res.json({
    image_assessment:
      aiText ||
      (imageBase64
        ? "Image received. A clinician should review image quality, anatomical site, visible abnormality, and red flags."
        : "No image supplied. Assessment is based on the description only."),
    triage: {
      score: type === "trauma" ? 70 : 50,
      urgency: type === "trauma" ? "Moderate to High" : "Moderate"
    },
    possible_conditions: [
      { name: `${type.replace("_", " ")} condition`, reason: "Suggested by the description provided." }
    ],
    recommended_diagnostics: {
      imaging: [
        {
          test:
            type === "trauma"
              ? "X-ray if fracture, deformity, severe pain or inability to use limb"
              : "Clinician-directed imaging if indicated",
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

// DOCUMENTATION
app.post("/ai/clinical-assist", async (req, res) => {
  const { note = "" } = req.body;
  const type = classify(note);
  const icd = icdFor(type);

  let ai = null;

  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.25,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a clinical documentation integrity assistant. Return JSON only with suggestions, funding_prompts, icd_opportunities and audit_risks."
          },
          { role: "user", content: `Analyse this note for documentation gaps, coding opportunities and audit risks:\n${note}` }
        ]
      });

      ai = JSON.parse(cleanJsonText(completion.choices?.[0]?.message?.content || "{}"));
    } catch (err) {
      audit("AI_ERROR_CLINICAL_ASSIST", { error: err.message });
    }
  }

  res.json({
    suggestions: ai?.suggestions || [
      "Document presenting complaint, onset, duration and severity.",
      "Include relevant positives and negatives.",
      "Record observations, examination findings and escalation decisions.",
      "Document clinician review and plan."
    ],
    funding_prompts: ai?.funding_prompts || [
      { prompt: "Add objective observations and examination findings.", estimated_uplift: 300 },
      { prompt: "Document comorbidities and functional impact.", estimated_uplift: 250 }
    ],
    icd_opportunities: ai?.icd_opportunities || [
      {
        indicative_code: icd.code,
        description: icd.description,
        documentation_needed: "Confirm diagnosis clinically and document supporting findings."
      }
    ],
    audit_risks: ai?.audit_risks || [
      "Diagnosis unsupported by examination findings.",
      "Missing severity, duration or relevant negative findings.",
      "No clear clinician review statement."
    ],
    legal_notice: SAFETY_NOTICE
  });
});

// FUNDING / CASES / AUDIT
app.post("/drg/estimate", (req, res) => {
  const { diagnosis = "" } = req.body;
  const type = classify(diagnosis);

  const base =
    type === "cardiac" || type === "neurological" ? 3200 :
    type === "trauma" ? 2400 :
    type === "infection" || type === "respiratory" ? 2100 :
    1600;

  res.json({
    diagnosis,
    type,
    funding: base,
    baseline: Math.round(base * 0.75),
    potential: base,
    uplift: Math.round(base * 0.25),
    documentation_needed: [
      "Principal diagnosis clearly supported",
      "Comorbidities documented",
      "Severity and complexity documented",
      "Investigations and treatment plan recorded"
    ],
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
  audit("PILOT_TRACK", row);

  res.status(201).json({ success: true, case: row });
});

app.get("/pilot/data", (req, res) => res.json(cases));

app.get("/pilot/metrics", (req, res) => {
  const predicted = cases.reduce((s, c) => s + money(c.predicted), 0);
  const actual = cases.reduce((s, c) => s + money(c.actual), 0);

  res.json({ predicted, actual, delta: actual - predicted, total: cases.length });
});

app.post("/clinical/override", (req, res) => {
  const override = { id: Date.now().toString(), timestamp: now(), ...req.body };
  overrides.push(override);
  audit("CLINICIAN_OVERRIDE", override);
  res.json({ success: true, override });
});

app.get("/audit/data", (req, res) => res.json(auditLogs));

app.get("/gdpr/processing-activities", (req, res) => {
  res.json([
    {
      activity: "Clinical decision support",
      data_categories: ["User-entered patient details", "Symptoms", "AI outputs", "Audit logs"],
      lawful_basis: "Prototype / demonstration use only",
      retention: "In-memory only in this prototype",
      safeguards: ["No database persistence in this version", "Audit logging", "Safety notices"]
    }
  ]);
});

app.get("/gdpr/export", (req, res) => {
  res.json({ controller: "DOCTORPD", exported_at: now(), users, cases, overrides, auditLogs });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    time: now(),
    ai_enabled: !!openai,
    model: MODEL,
    legal_notice: SAFETY_NOTICE
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ DOCTORPD running on port ${PORT}`);
});
