import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================================================
// FUNDING / REVENUE LOGIC
// =====================================================

function estimateFunding(text = "") {
  const t = String(text).toLowerCase();
  let weight = 1.2;

  if (t.includes("depression") || t.includes("mental health")) weight = 1.8;
  if (t.includes("respiratory")) weight = 2.2;
  if (t.includes("failure")) weight = 2.5;
  if (t.includes("sepsis")) weight = 2.8;
  if (t.includes("trauma") || t.includes("fracture")) weight = 1.9;
  if (t.includes("infection") || t.includes("cellulitis")) weight = 1.7;
  if (t.includes("stroke") || t.includes("neurological")) weight = 2.6;
  if (t.includes("chest pain") || t.includes("cardiac")) weight = 2.4;

  return Math.round(weight * 7000);
}

function generateRevenuePrompts(text = "") {
  const t = String(text).toLowerCase();
  const prompts = [];

  if (!t.includes("severity")) {
    prompts.push({
      message: "Document severity of illness",
      value: 1500
    });
  }

  if (t.includes("shortness of breath") || t.includes("sob") || t.includes("respiratory")) {
    prompts.push({
      message: "Clarify respiratory failure / oxygen requirement if clinically present",
      value: 2000
    });
  }

  if (t.includes("infection") || t.includes("fever") || t.includes("tachycardia")) {
    prompts.push({
      message: "Assess and document sepsis criteria if clinically present",
      value: 3000
    });
  }

  if (!t.includes("comorbid") && !t.includes("diabetes") && !t.includes("copd")) {
    prompts.push({
      message: "Document active comorbidities affecting care",
      value: 1200
    });
  }

  return prompts;
}

// =====================================================
// CLINICAL CHAT
// =====================================================

app.post("/ai/personal-check", async (req, res) => {
  try {
    const { symptoms, answers } = req.body;
    const combined = `${symptoms || ""} ${(answers || []).join(" ")}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are a cautious clinical triage assistant.

Return ONLY valid JSON:
{
  "conditions": [
    { "name": "", "likelihood": "low | moderate | high", "reason": "" }
  ],
  "overall_assessment": "",
  "follow_up_questions": [],
  "triage_score": 0,
  "urgency": "LOW | MEDIUM | HIGH | EMERGENCY",
  "red_flags": [],
  "advice": ""
}

Rules:
- Do not diagnose definitively.
- Include at least two possible conditions where appropriate.
- Include red flags if present.
- Ask clinically useful follow-up questions.
- EMERGENCY means potentially life-threatening symptoms requiring urgent care.
`
        },
        { role: "user", content: combined }
      ],
      temperature: 0.3
    });

    let parsed;

    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      parsed = {
        conditions: [],
        overall_assessment: completion.choices[0].message.content,
        follow_up_questions: [],
        triage_score: 30,
        urgency: "LOW",
        red_flags: [],
        advice: "Monitor symptoms and seek medical care if symptoms worsen or concern you."
      };
    }

    const base = estimateFunding(combined);
    const prompts = generateRevenuePrompts(combined);
    const uplift = prompts.reduce((a, p) => a + p.value, 0);

    parsed.funding = {
      baseline: base,
      potential: base + uplift,
      uplift
    };

    parsed.revenue_prompts = prompts;

    res.json(parsed);
  } catch (err) {
    console.error("Personal AI error:", err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// DOCUMENTATION ASSISTANT
// =====================================================

app.post("/ai/clinical-assist", async (req, res) => {
  try {
    const { note } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are a clinical documentation improvement specialist.

Return ONLY valid JSON:
{
  "suggestions": [],
  "diagnosis_opportunities": [],
  "funding_prompts": [
    { "prompt": "", "estimated_uplift": 0 }
  ],
  "audit_risks": []
}

Rules:
- Do not suggest unsupported upcoding.
- Suggestions must be documentation clarification opportunities only.
- Focus on severity, comorbidities, complications, interventions, risk, phase of care, and functional impairment.
`
        },
        { role: "user", content: note || "" }
      ],
      temperature: 0.2
    });

    let parsed;

    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      const text = completion.choices[0].message.content;
      parsed = {
        suggestions: text.split("\n").filter(x => x.trim() !== ""),
        diagnosis_opportunities: [],
        funding_prompts: [],
        audit_risks: []
      };
    }

    const base = estimateFunding(note || "");
    const fundingPromptUplift = (parsed.funding_prompts || [])
      .reduce((a, p) => a + Number(p.estimated_uplift || 0), 0);

    res.json({
      ...parsed,
      revenue: {
        base,
        potential: base + fundingPromptUplift,
        uplift: fundingPromptUplift
      }
    });
  } catch (err) {
    console.error("Clinical assist error:", err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// IMAGE + DIAGNOSTICS + ORDER DRAFTS
// =====================================================

app.post("/ai/diagnostics-assist", async (req, res) => {
  try {
    const { description, imageBase64, mimeType } = req.body;

    const content = [
      {
        type: "text",
        text: `
You are a cautious clinical triage and diagnostic pathway assistant.

Analyse the supplied clinical description and image if present.

Return ONLY valid JSON:
{
  "image_assessment": "",
  "possible_conditions": [
    { "name": "", "likelihood": "low | moderate | high", "reason": "" }
  ],
  "red_flags": [],
  "triage": {
    "score": 0,
    "urgency": "LOW | MEDIUM | HIGH | EMERGENCY",
    "recommended_care_level": ""
  },
  "recommended_diagnostics": {
    "imaging": [
      { "test": "", "reason": "", "urgency": "routine | urgent | emergency", "clinician_authorisation_required": true }
    ],
    "pathology": [
      { "test": "", "reason": "", "urgency": "routine | urgent | emergency", "clinician_authorisation_required": true }
    ]
  },
  "order_drafts": {
    "pathology_request": "",
    "imaging_request": ""
  },
  "patient_advice": "",
  "safety_note": "This is decision support only and does not replace clinician assessment."
}

Rules:
- Do not provide a definitive diagnosis from an image.
- If image quality is poor, say so.
- Do not autonomously order pathology or imaging.
- Generate clinician-reviewable diagnostic request drafts only.
- Escalate chest pain, stroke symptoms, severe infection, necrosis, severe trauma, uncontrolled bleeding, or severe shortness of breath.
`
      },
      {
        type: "text",
        text: `Clinical description: ${description || "No description provided"}`
      }
    ];

    if (imageBase64 && mimeType) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${imageBase64}`
        }
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content }],
      temperature: 0.2
    });

    let parsed;

    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      parsed = {
        image_assessment: completion.choices[0].message.content,
        possible_conditions: [],
        red_flags: [],
        triage: {
          score: 30,
          urgency: "LOW",
          recommended_care_level: "Clinician review if symptoms persist or worsen"
        },
        recommended_diagnostics: {
          imaging: [],
          pathology: []
        },
        order_drafts: {
          pathology_request: "",
          imaging_request: ""
        },
        patient_advice: "Seek medical care if symptoms worsen or concern you.",
        safety_note: "This is decision support only and does not replace clinician assessment."
      };
    }

    res.json(parsed);
  } catch (err) {
    console.error("Diagnostics assist error:", err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// DRG / FUNDING ESTIMATOR
// =====================================================

app.post("/drg/estimate", (req, res) => {
  try {
    const { diagnosis } = req.body;
    res.json({ funding: estimateFunding(diagnosis || "") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// DATABASE
// =====================================================

app.post("/pilot/track", async (req, res) => {
  try {
    const { predicted, actual } = req.body;

    const { error } = await supabase
      .from("pilot_data")
      .insert([{ predicted, actual }]);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Pilot track error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/pilot/data", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pilot_data")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("Pilot data error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/pilot/metrics", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pilot_data")
      .select("*");

    if (error) throw error;

    const predicted = data.reduce((a, b) => a + Number(b.predicted || 0), 0);
    const actual = data.reduce((a, b) => a + Number(b.actual || 0), 0);

    res.json({
      predicted,
      actual,
      delta: actual - predicted,
      total: data.length
    });
  } catch (err) {
    console.error("Metrics error:", err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// FRONTEND
// =====================================================

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
