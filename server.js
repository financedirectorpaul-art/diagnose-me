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
let conversations = {};
let cases = [];
let overrides = [];
let auditLogs = [];

const SAFETY_NOTICE = "Decision support only. Not a diagnosis. Requires clinician review. If symptoms are severe or urgent, seek medical care immediately.";

function now() { return new Date().toISOString(); }
function money(n) { return Number(n || 0); }

// ====================== AUTH ======================
app.post("/auth/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({error: "Email and password required"});
  if (users[email]) return res.status(400).json({error: "User already exists"});
  users[email] = {password, patients: []};
  res.json({success: true});
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!users[email] || users[email].password !== password) {
    return res.status(401).json({error: "Invalid email or password"});
  }
  res.json({success: true});
});

// ====================== PATIENTS ======================
app.get("/patients", (req, res) => {
  const email = req.query.email;
  if (!users[email]) return res.json([]);
  res.json(users[email].patients);
});

app.post("/patients", (req, res) => {
  const { email, name, age, gender } = req.body;
  if (!users[email]) return res.status(401).json({error: "Not logged in"});
  const patient = { id: Date.now().toString(), name, age, gender, createdAt: new Date().toISOString() };
  users[email].patients.push(patient);
  res.json(patient);
});

// ====================== CLINICAL HELPERS ======================
function classify(text = "") {
  const t = text.toLowerCase();
  if (/(sore throat|throat pain|throat hurts|tonsillitis|pharyngitis|swollen tonsils|difficulty swallowing)/.test(t)) return "respiratory";
  if (/(cough|runny nose|stuffy nose|sinus|cold|flu|viral|post nasal drip)/.test(t)) return "respiratory";
  if (/(chest pain|chest pressure|heart attack|cardiac|palpitations|crushing chest)/.test(t)) return "cardiac";
  if (/(stroke|slurred|facial droop|one sided weakness|weak arm|weak leg|seizure|confusion)/.test(t)) return "neurological";
  if (/(can't breathe|cannot breathe|blue lips|shortness of breath|sob|wheeze|pneumonia|low oxygen|hypoxia)/.test(t)) return "respiratory";
  if (/(sepsis|infection|fever|chills|cellulitis|pus|red hot|wound infection)/.test(t)) return "infection";
  if (/(fracture|broken bone|broken|fall|injury|trauma|twisted|sprain|deformed|open wound|cannot weight bear|can't weight bear|broken arm|broken leg)/.test(t)) return "trauma";
  if (/(knee|ankle|hip|shoulder|elbow|wrist|joint|muscle|ache|stiff|swelling|locked|strain|sprain|back pain|neck pain)/.test(t)) return "musculoskeletal";
  if (/(depressed|anxious|panic|suicidal|kill myself|mental health|self harm)/.test(t)) return "mental_health";
  if (/(stomach cramps|stomach pain|abdominal pain|cramps|belly ache|nausea|vomit)/.test(t)) return "general";
  if (/(headache|head pain|migraine|dizzy|dizziness|vertigo|lightheaded)/.test(t)) return "general";
  return "general";
}

function questionsFor(type) {
  const sets = {
    respiratory: ["Is there shortness of breath at rest or only with activity?", "Is there fever, chills, productive cough, or chest pain?", "What is the oxygen saturation, if known?", "How long have the symptoms been present?", "Any asthma, COPD, heart disease, smoking history, or immunosuppression?"],
    cardiac: ["When did the chest discomfort start?", "Does it radiate to the arm, jaw, back, neck, or shoulder?", "Is there shortness of breath, sweating, nausea, dizziness, or faintness?", "Is it worse with exertion or relieved by rest?", "Any history of heart disease, diabetes, hypertension, high cholesterol, or smoking?"],
    neurological: ["When did the symptoms start, and were they sudden?", "Is there facial droop, slurred speech, weakness, numbness, confusion, or vision change?", "Is one side of the body affected?", "Any seizure, severe headache, loss of consciousness, or neck stiffness?", "Are symptoms improving, worsening, or unchanged?"],
    infection: ["Is there fever, chills, sweats, or feeling very unwell?", "How long have the symptoms been present?", "Is there redness, warmth, swelling, pus, rash, or worsening pain?", "Any confusion, faintness, shortness of breath, fast heart rate, or low blood pressure?", "Any diabetes, immune suppression, wound, recent surgery, or recent hospital stay?"],
    trauma: ["How did the injury happen?", "Can the patient bear weight or use the affected limb?", "Is there deformity, abnormal angling, severe swelling, or bruising?", "Any numbness, tingling, weakness, coldness, colour change, or reduced movement?", "Is there an open wound, bleeding, or bone visible?"],
    musculoskeletal: ["When did the pain start?", "Was there an injury, twist, fall, sudden movement, or overuse?", "Is there swelling, redness, warmth, locking, stiffness, or instability?", "Can the joint move fully, and can weight be borne?", "How severe is the pain from 0 to 10, and what makes it better or worse?"],
    mental_health: ["How long has the patient felt this way?", "Are there thoughts of self-harm or harming someone else?", "Is the patient sleeping, eating, and functioning normally?", "Any hallucinations, panic attacks, substance use, or recent major stress?", "Is there someone safe with the patient now?"],
    general: ["When did symptoms start?", "How severe are symptoms from 0 to 10?", "What makes symptoms better or worse?", "Any fever, chest pain, shortness of breath, weakness, vomiting, rash, swelling, or severe pain?", "Has this happened before, and are there relevant medical conditions?"]
  };
  return sets[type] || sets.general;
}

function emergencyTrigger(text = "") {
  const t = text.toLowerCase();
  const triggers = ["chest pain","can't breathe","cannot breathe","blue lips","stroke","facial droop","slurred speech","unconscious","severe bleeding","open fracture","bone visible","blue foot","cold foot","suicidal","kill myself"];
  return triggers.find(x => t.includes(x));
}

function buildAssessment(symptoms, answers) {
  const combined = `${symptoms || ""} ${answers.join(" ")}`;
  const type = classify(combined);
  const red = emergencyTrigger(combined);
  if (red) {
    return { mode: "final", triage_score: 100, urgency: "EMERGENCY", overall_assessment: `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}. Seek urgent medical care immediately.`, legal_notice: SAFETY_NOTICE };
  }
  return { mode: "final", triage_score: 55, urgency: "Moderate", overall_assessment: `I have reviewed your symptoms (${type}). Common causes include dehydration, viral illness, stress, or gastrointestinal upset.`, legal_notice: SAFETY_NOTICE };
}

// ====================== GUIDED TRIAGE (full multi-question flow) ======================
app.post("/ai/personal-check", async (req, res) => {
  let { symptoms = "", answers = [], questionIndex = 0 } = req.body;
  const combined = `${symptoms} ${answers.join(" ")}`;
  const type = classify(combined);
  const red = emergencyTrigger(combined);

  if (red) {
    return res.json({ mode: "final", triage_score: 100, urgency: "EMERGENCY", overall_assessment: `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}. Seek urgent medical care immediately.`, legal_notice: SAFETY_NOTICE });
  }

  const qs = questionsFor(type);

  if (questionIndex < qs.length) {
    return res.json({
      mode: "question",
      question: qs[questionIndex],
      questionIndex: questionIndex,
      totalQuestions: qs.length,
      urgency: "Pending",
      triage_score: 0,
      legal_notice: SAFETY_NOTICE
    });
  }

  // All questions answered → final assessment
  const final = buildAssessment(symptoms, answers);
  res.json(final);
});

// ====================== FREE CHAT (conversational with follow-ups) ======================
app.post("/ai/ask-doctor", async (req, res) => {
  const { question = "", context = {} } = req.body;
  const symptoms = context.symptoms || question || "";
  const assessment = buildAssessment(symptoms, context.answers || []);
  const response = `${assessment.overall_assessment}\n\nCan you tell me more? When did it start and how severe is it (0-10)?\n\n${SAFETY_NOTICE}`;
  res.json({ response });
});

// ====================== OTHER ROUTES (kept for full functionality) ======================
app.post("/ai/diagnostics-assist", (req, res) => res.json({ image_assessment: "Assessment received", safety_note: SAFETY_NOTICE }));
app.post("/ai/clinical-assist", (req, res) => res.json({ suggestions: ["Add more detail"], legal_notice: SAFETY_NOTICE }));
app.post("/drg/estimate", (req, res) => res.json({ funding: 2450 }));
app.post("/pilot/track", (req, res) => res.status(201).json({ success: true }));
app.get("/pilot/data", (req, res) => res.json([]));
app.get("/pilot/metrics", (req, res) => res.json({ predicted: 0, actual: 0, delta: 0, total: 0 }));
app.post("/clinical/override", (req, res) => res.json({ success: true }));
app.get("/audit/data", (req, res) => res.json([]));
app.get("/gdpr/processing-activities", (req, res) => res.json([]));
app.get("/gdpr/export", (req, res) => res.json({ controller: "DOCTORPD", records: [] }));
app.get("/health", (req, res) => res.json({ status: "healthy", legal_notice: SAFETY_NOTICE }));

app.get("*", (req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ DOCTORPD running on port ${PORT}`));
