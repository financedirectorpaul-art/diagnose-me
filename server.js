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

// ====================== CONVERSATIONS ======================
app.get("/conversations", (req, res) => {
  const patientId = req.query.patientId;
  res.json(conversations[patientId] || []);
});

app.post("/conversations", (req, res) => {
  const { patientId, message, role } = req.body;
  if (!conversations[patientId]) conversations[patientId] = [];
  conversations[patientId].push({role, message, timestamp: new Date().toISOString()});
  res.json({success: true});
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

function buildAssessment(symptoms, answers) {
  const combined = `${symptoms || ""} ${answers.join(" ")}`;
  const type = classify(combined);
  if (type === "general") {
    return {
      mode: "final",
      case_type: "general",
      triage_score: 55,
      urgency: "Moderate",
      confidence: 60,
      overall_assessment: `Your reported symptom "${symptoms}" has been noted. Common causes can include dehydration, viral illness, stress, or migraine (for dizziness/headache) or gastrointestinal upset (for stomach cramps). Further details would help refine this.`,
      advice: "Monitor symptoms and seek medical review if they worsen or persist. Call 000 if severe.",
      legal_notice: SAFETY_NOTICE
    };
  }
  // Other types use the existing logic
  return { mode: "final", case_type: type, triage_score: 60, urgency: "Moderate", confidence: 50, overall_assessment: `I have noted your symptoms. This appears to be a ${type} presentation.`, legal_notice: SAFETY_NOTICE };
}

// ====================== FREE CHAT (very robust) ======================
app.post("/ai/ask-doctor", async (req, res) => {
  const { question = "", context = {} } = req.body;
  const symptoms = context.symptoms || question || "";
  const assessment = buildAssessment(symptoms, context.answers || []);
  const response = assessment.overall_assessment || `I have noted your symptom: ${question}. Please tell me more details if needed.`;
  res.json({ response });
});

// ====================== GUIDED TRIAGE (kept for compatibility) ======================
app.post("/ai/personal-check", async (req, res) => {
  const { symptoms = "", answers = [] } = req.body;
  const assessment = buildAssessment(symptoms, answers);
  res.json(assessment);
});

// ====================== OTHER ROUTES ======================
app.post("/ai/diagnostics-assist", (req, res) => res.json({ image_assessment: "Assessment based on description", safety_note: SAFETY_NOTICE }));
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
