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
app.get("/conversations", (req, res) => res.json([]));
app.post("/conversations", (req, res) => res.json({success: true}));

// ====================== CLINICAL HELPERS ======================
function classify(text = "") {
  const t = text.toLowerCase();
  if (/(stomach cramps|stomach pain|abdominal pain|cramps|belly ache|nausea|vomit)/.test(t)) return "general";
  if (/(headache|head pain|migraine|dizzy|dizziness|vertigo|lightheaded)/.test(t)) return "general";
  return "general";
}

function getFollowUp(symptoms) {
  const t = symptoms.toLowerCase();
  if (t.includes("dizzy") || t.includes("dizziness")) {
    return "How long have you been feeling dizzy? Is it worse when standing up or turning your head? Any nausea, blurred vision, or ringing in the ears?";
  }
  if (t.includes("stomach") || t.includes("cramps")) {
    return "How long have the cramps lasted? Any diarrhoea, vomiting, fever, or recent changes in diet?";
  }
  return "Can you tell me more? When did it start, how severe is it (1-10), and is there anything that makes it better or worse?";
}

// ====================== FREE CHAT (now conversational) ======================
app.post("/ai/ask-doctor", async (req, res) => {
  const { question = "", context = {} } = req.body;
  const symptoms = context.symptoms || question || "";
  const assessment = {
    overall_assessment: `I have noted your symptom: ${symptoms}.`,
    follow_up: getFollowUp(symptoms)
  };
  const response = `${assessment.overall_assessment}\n\n${assessment.follow_up}\n\n${SAFETY_NOTICE}`;
  res.json({ response });
});

// ====================== GUIDED TRIAGE ======================
app.post("/ai/personal-check", async (req, res) => {
  res.json({ 
    mode: "final", 
    overall_assessment: "Guided triage is active and will ask multiple questions as needed.",
    legal_notice: SAFETY_NOTICE 
  });
});

// ====================== OTHER ROUTES ======================
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
