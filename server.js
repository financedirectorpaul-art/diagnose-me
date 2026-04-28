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
app.use(express.json({ limit: "20mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================= FUNDING =================

function estimateFunding(text = "") {
  const t = text.toLowerCase();
  let weight = 1.2;

  if (t.includes("respiratory")) weight = 2.2;
  if (t.includes("failure")) weight = 2.5;
  if (t.includes("sepsis")) weight = 2.8;
  if (t.includes("depression")) weight = 1.8;

  return Math.round(weight * 7000);
}

function generatePrompts(text = "") {
  const t = text.toLowerCase();
  const prompts = [];

  if (!t.includes("severity")) {
    prompts.push({ message: "Add severity of illness → +$1500", value: 1500 });
  }
  if (t.includes("shortness of breath")) {
    prompts.push({ message: "Consider respiratory failure → +$2000", value: 2000 });
  }
  if (t.includes("infection")) {
    prompts.push({ message: "Assess for sepsis → +$3000", value: 3000 });
  }

  return prompts;
}

// ================= CLINICAL CHAT =================

app.post("/ai/personal-check", async (req, res) => {
  try {
    const { symptoms, answers } = req.body;
    const combined = `${symptoms} ${(answers || []).join(" ")}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
Return JSON:
{
  "conditions": [],
  "overall_assessment": "",
  "follow_up_questions": [],
  "triage_score": 0,
  "urgency": "",
  "red_flags": [],
  "advice": ""
}
`
        },
        { role: "user", content: combined }
      ]
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
        advice: "Monitor symptoms"
      };
    }

    const base = estimateFunding(combined);
    const prompts = generatePrompts(combined);
    const uplift = prompts.reduce((a, p) => a + p.value, 0);

    parsed.funding = {
      baseline: base,
      potential: base + uplift,
      uplift
    };

    parsed.revenue_prompts = prompts;

    res.json(parsed);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= IMAGE + DIAGNOSTICS =================

app.post("/ai/diagnostics-assist", async (req, res) => {
  try {
    const { description, imageBase64, mimeType } = req.body;

    const content = [
      { type: "text", text: `Clinical description: ${description}` }
    ];

    if (imageBase64) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${imageBase64}` }
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content }]
    });

    res.json({
      image_assessment: completion.choices[0].message.content,
      recommended_diagnostics: {
        imaging: [{ test: "X-ray", reason: "rule out fracture", urgency: "routine" }],
        pathology: [{ test: "FBC", reason: "infection markers", urgency: "routine" }]
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= DRG =================

app.post("/drg/estimate", (req, res) => {
  const { diagnosis } = req.body;
  res.json({ funding: estimateFunding(diagnosis) });
});

// ================= DATABASE =================

app.post("/pilot/track", async (req, res) => {
  const { predicted, actual } = req.body;
  await supabase.from("pilot_data").insert([{ predicted, actual }]);
  res.json({ success: true });
});

app.get("/pilot/data", async (req, res) => {
  const { data } = await supabase.from("pilot_data").select("*");
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

// ================= STATIC =================

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(process.env.PORT || 10000);
