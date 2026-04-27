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
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================= PERSONAL AI (FULLY FIXED) =================

app.post("/ai/personal-check", async (req, res) => {
  try {
    const { symptoms, answers } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are a cautious clinical assistant.

Return ONLY JSON:

{
  "conditions": [
    {
      "name": "",
      "likelihood": "low | moderate | high",
      "reason": ""
    }
  ],
  "overall_assessment": "",
  "follow_up_questions": [],
  "urgency": "LOW | MEDIUM | HIGH"
}

Rules:
- Always include at least 2 conditions
- Always include follow-up questions unless confident
- Do NOT include markdown
`
        },
        {
          role: "user",
          content: `
Symptoms: ${symptoms}
Answers so far: ${answers || ""}
`
        }
      ],
      temperature: 0.4
    });

    let text = completion.choices[0].message.content;

    try {
      res.json(JSON.parse(text));
    } catch {
      res.json({
        conditions: [],
        overall_assessment: text,
        follow_up_questions: [],
        urgency: "LOW"
      });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================= CLINICAL ASSISTANT =================

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

Identify:
- missing diagnoses
- missing severity
- missing comorbidities
- anything impacting DRG funding

Return bullet points only.
`
        },
        { role: "user", content: note }
      ]
    });

    const text = completion.choices[0].message.content;

    res.json({
      suggestions: text.split("\n").filter(x => x.trim() !== "")
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= DRG =================

app.post("/drg/estimate", (req, res) => {
  const { diagnosis } = req.body;

  let weight = diagnosis?.toLowerCase().includes("depression") ? 1.8 : 1.2;
  let funding = Math.round(weight * 7000);

  res.json({ funding });
});

// ================= DATABASE =================

app.post("/pilot/track", async (req, res) => {
  const { predicted, actual } = req.body;

  await supabase.from("pilot_data").insert([{ predicted, actual }]);

  res.json({ success: true });
});

app.get("/pilot/data", async (req, res) => {
  const { data } = await supabase
    .from("pilot_data")
    .select("*")
    .order("created_at", { ascending: false });

  res.json(data);
});

app.get("/pilot/metrics", async (req, res) => {
  const { data } = await supabase.from("pilot_data").select("*");

  const predicted = data.reduce((a,b)=>a+b.predicted,0);
  const actual = data.reduce((a,b)=>a+b.actual,0);

  res.json({
    predicted,
    actual,
    delta: actual - predicted,
    total: data.length
  });
});

// ================= FRONTEND =================

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
