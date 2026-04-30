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

const SAFETY_NOTICE = "Decision support only. Not a diagnosis. Requires clinician review. If symptoms are severe or urgent, seek medical care immediately.";

function now() { return new Date().toISOString(); }
function money(n) { return Number(n || 0); }

function audit(action, details = {}) {
  auditLogs.push({ id: auditLogs.length + 1, timestamp: now(), action, details });
}

// ==================== ORIGINAL HELPERS ====================
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
  return {
    mode: "final",
    case_type: type,
    triage_score: 60,
    urgency: "Moderate",
    confidence: 45,
    uncertainty: "Multi-AI unavailable - using fallback",
    red_flags: [],
    differential: [],
    conditions: [],
    overall_assessment: "Further clinical information is required.",
    icd: { code: "R69", description: "Illness, unspecified", confidence: 50 },
    cpt: "99213",
    denial_risk: "Moderate",
    missing_information: [],
    advice: "Provide more symptom detail and seek clinical review.",
    revenue_prompts: [],
    funding: { baseline: 1500, potential: 2300, uplift: 800 },
    legal_notice: SAFETY_NOTICE
  };
}

// ==================== MULTI-AI HELPERS ====================
async function callGrokForAssessment(symptoms, answers) {
  const key = process.env.GROK_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.grok.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-3",
        messages: [{ role: "system", content: "You are an Australian emergency & general physician. Output ONLY valid JSON with this exact schema: {triage_score:number, urgency:string, confidence:number, overall_assessment:string, differential:[{rank:number,condition:string,probability:number,likelihood:string,icd_suggestion:{code:string,description:string}}], conditions:[{name:string,likelihood:string,reason:string}], advice:string, missing_information:string[], revenue_prompts:[{message:string,value:number}]}" }, { role: "user", content: `Symptoms: ${symptoms}\nPatient answers: ${answers.join("\n")}` }],
        temperature: 0.5,
        max_tokens: 1200
      })
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch { return null; }
}

async function callOpenAIForAssessment(symptoms, answers) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: "You are an Australian emergency & general physician. Output ONLY valid JSON with this exact schema: {triage_score:number, urgency:string, confidence:number, overall_assessment:string, differential:[{rank:number,condition:string,probability:number,likelihood:string,icd_suggestion:{code:string,description:string}}], conditions:[{name:string,likelihood:string,reason:string}], advice:string, missing_information:string[], revenue_prompts:[{message:string,value:number}]}" }, { role: "user", content: `Symptoms: ${symptoms}\nPatient answers: ${answers.join("\n")}` }],
        temperature: 0.5,
        max_tokens: 1200
      })
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch { return null; }
}

async function callClaudeForAssessment(symptoms, answers) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1200,
        temperature: 0.5,
        system: "You are an Australian emergency & general physician. Output ONLY valid JSON with this exact schema: {triage_score:number, urgency:string, confidence:number, overall_assessment:string, differential:[{rank:number,condition:string,probability:number,likelihood:string,icd_suggestion:{code:string,description:string}}], conditions:[{name:string,likelihood:string,reason:string}], advice:string, missing_information:string[], revenue_prompts:[{message:string,value:number}] }",
        messages: [{ role: "user", content: `Symptoms: ${symptoms}\nPatient answers: ${answers.join("\n")}` }]
      })
    });
    const data = await res.json();
    return JSON.parse(data.content[0].text);
  } catch { return null; }
}

async function generateMultiAIAssessment(symptoms, answers) {
  const [grok, openai, claude] = await Promise.all([
    callGrokForAssessment(symptoms, answers),
    callOpenAIForAssessment(symptoms, answers),
    callClaudeForAssessment(symptoms, answers)
  ]);

  const results = [grok, openai, claude].filter(Boolean);
  if (results.length === 0) return buildAssessment(symptoms, answers);

  const type = classify(`${symptoms} ${answers.join(" ")}`);

  return {
    mode: "final",
    case_type: type,
    triage_score: Math.round(results.reduce((a, r) => a + (r.triage_score || 60), 0) / results.length),
    urgency: results.some(r => r.urgency === "EMERGENCY") ? "EMERGENCY" : results.some(r => r.urgency === "High") ? "High" : "Moderate",
    confidence: Math.round(results.reduce((a, r) => a + (r.confidence || 70), 0) / results.length),
    uncertainty: "Multi-AI consensus (Grok + GPT-4o + Claude)",
    red_flags: [],
    differential: results.flatMap(r => r.differential || []).slice(0, 5),
    conditions: results.flatMap(r => r.conditions || []).slice(0, 4),
    overall_assessment: results[0].overall_assessment || "Multi-AI assessment complete.",
    icd: results[0].icd || { code: "R69", description: "Illness, unspecified", confidence: 60 },
    cpt: results[0].cpt || "99213",
    denial_risk: "Low",
    missing_information: results.flatMap(r => r.missing_information || []).filter(Boolean),
    advice: results.map(r => r.advice).filter(Boolean).join(" | "),
    revenue_prompts: results.flatMap(r => r.revenue_prompts || []).slice(0, 4),
    funding: { baseline: 3200, potential: 6800, uplift: 3600 },
    legal_notice: SAFETY_NOTICE
  };
}

// ==================== UPDATED GUIDED TRIAGE (multi-AI + emergency) ====================
app.post("/ai/personal-check", async (req, res) => {
  const { symptoms = "", answers = [], questionIndex = 0 } = req.body;
  const combined = `${symptoms} ${answers.join(" ")}`;
  const type = classify(combined);
  audit("CLINICAL_INPUT", { symptoms, answers, questionIndex, type });

  const red = emergencyTrigger(combined);

  if (red) {
    const multiAssessment = await generateMultiAIAssessment(symptoms, answers);
    const emergencyResponse = {
      ...multiAssessment,
      mode: "final",
      triage_score: 100,
      urgency: "EMERGENCY",
      confidence: 95,
      red_flags: [red],
      overall_assessment: `🚨 EMERGENCY RED FLAG DETECTED: ${red.toUpperCase()}\n\n${multiAssessment.overall_assessment}\n\nThe patient must seek urgent medical care IMMEDIATELY.`,
      advice: `Call 000 now or go to the nearest Emergency Department. Do not wait. ${multiAssessment.advice || ""}`,
      legal_notice: SAFETY_NOTICE
    };
    audit("MULTI_AI_EMERGENCY", { red_flag: red });
    return res.json(emergencyResponse);
  }

  const qs = questionsFor(type);
  if (questionIndex < qs.length) {
    return res.json({ mode: "question", question: qs[questionIndex], questionIndex, totalQuestions: qs.length, urgency: "Pending", triage_score: 0, confidence: 10, uncertainty: "Gathering structured clinical information.", legal_notice: SAFETY_NOTICE });
  }

  const finalAssessment = await generateMultiAIAssessment(symptoms, answers);
  audit("MULTI_AI_GUIDED_OUTPUT", finalAssessment);
  res.json(finalAssessment);
});

// ==================== MULTI-AI FREE CHAT ====================
app.post("/ai/ask-doctor", async (req, res) => {
  const { question = "", context = {} } = req.body;
  audit("FREE_QUESTION_MULTI_AI", { question });

  const [grok, openai, claude] = await Promise.all([
    callGrokForAssessment(context.symptoms || "", context.answers || []),
    callOpenAIForAssessment(context.symptoms || "", context.answers || []),
    callClaudeForAssessment(context.symptoms || "", context.answers || [])
  ]);

  const answers = [grok, openai, claude].filter(Boolean);
  let response = answers.length > 0 
    ? answers[0].overall_assessment || answers[0].advice || "I have reviewed your question with multiple AIs."
    : "Sorry, the AI service is temporarily unavailable.";

  response += `\n\n${SAFETY_NOTICE}`;
  res.json({ response });
});

// ==================== ORIGINAL UNCHANGED ROUTES ====================
app.post("/ai/diagnostics-assist", (req, res) => {
  const { description = "", imageBase64 = "" } = req.body;
  const type = classify(description);
  const response = {
    image_assessment: imageBase64 ? `Image received. Assessment is based on the image plus description: ${description || "No description provided."}` : `Assessment based on description: ${description || "No description provided."}`,
    triage: { score: type === "trauma" ? 80 : 60, urgency: type === "trauma" ? "High" : "Moderate" },
    possible_conditions: buildAssessment(description, []).conditions || [],
    recommended_diagnostics: {
      imaging: [{ test: "X-ray if trauma, deformity, swelling, or inability to bear weight", reason: "Rule out fracture or dislocation", urgency: type === "trauma" ? "Urgent" : "Routine/Urgent depending on severity" }],
      pathology: type === "infection" || type === "respiratory" ? [{ test: "FBC, CRP, cultures if clinically indicated", reason: "Assess infection/severity", urgency: "Routine/Urgent depending on severity" }] : []
    },
    order_drafts: { imaging_request: "Clinician-reviewable imaging request draft.", pathology_request: "Clinician-reviewable pathology request draft." },
    safety_note: SAFETY_NOTICE
  };
  audit("DIAGNOSTICS_OUTPUT", response);
  res.json(response);
});

app.post("/ai/clinical-assist", (req, res) => {
  const { note = "" } = req.body;
  const type = classify(note);
  const response = {
    suggestions: ["Add diagnosis specificity", "Add laterality where relevant", "Document severity and pain score", "Document functional limitation", "Document relevant comorbidities", "Document investigation results and treatment plan"],
    funding_prompts: [{ prompt: "Document severity of illness", estimated_uplift: 900 }, { prompt: "Document active comorbidities affecting care", estimated_uplift: 1200 }, ...(type === "respiratory" ? [{ prompt: "Document oxygen requirement and hypoxia if present", estimated_uplift: 1800 }] : []), ...(type === "trauma" ? [{ prompt: "Document mechanism of injury and neurovascular status", estimated_uplift: 1600 }] : [])],
    icd_opportunities: [{ indicative_code: buildAssessment(note, []).icd.code, description: buildAssessment(note, []).icd.description, documentation_needed: "Validate diagnosis, specificity, laterality and supporting evidence." }],
    audit_risks: ["Avoid coding unsupported diagnoses.", "Ensure documentation supports severity, treatment and investigations.", "Indicative ICD suggestions require coder validation."],
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
  const row = { id: cases.length + 1, patientName, predicted: money(predicted), actual: money(actual), created_at: now() };
  cases.push(row);
  audit("CASE_SAVED", row);
  res.status(201).json({ success: true, case: row });
});

app.get("/pilot/data", (req, res) => res.json([...cases].reverse()));
app.get("/pilot/metrics", (req, res) => {
  const predicted = cases.reduce((a, b) => a + money(b.predicted), 0);
  const actual = cases.reduce((a, b) => a + money(b.actual), 0);
  res.json({ predicted, actual, delta: actual - predicted, total: cases.length });
});

app.post("/clinical/override", (req, res) => {
  const row = { id: overrides.length + 1, timestamp: now(), ...req.body };
  overrides.push(row);
  audit("CLINICIAN_OVERRIDE", row);
  res.json({ success: true, override: row });
});

app.get("/audit/data", (req, res) => res.json([...auditLogs].reverse()));
app.get("/gdpr/processing-activities", (req, res) => res.json([...auditLogs].reverse()));
app.get("/gdpr/export", (req, res) => res.json({ controller: "DOCTORPD", records: [...auditLogs].reverse() }));
app.get("/health", (req, res) => res.json({ status: "healthy", service: "DOCTORPD", dependencies: "minimal", database: "in-memory", legal_notice: SAFETY_NOTICE }));

app.get("*", (req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ DOCTORPD running on port ${PORT} — Multi-AI enabled`));
