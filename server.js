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

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================= PERSONAL AI (RESTORED PROPERLY) =================

app.post("/ai/personal-check", async (req, res) => {
  try {
    const { symptoms } = req.body;

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

Do NOT diagnose definitively.
Be clear and clinically realistic.
          `
        },
        {
          role: "user",
          content: symptoms
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

// ================= DRG =================

app.post("/drg/estimate", (req, res) => {
  const { diagnosis } = req.body;

  let weight = diagnosis?.includes("depression") ? 1.8 : 1.2;
  let funding = Math.round(weight * 7000);

  res.json({ funding });
});

// ================= PILOT =================

app.post("/pilot/track", async (req, res) => {
  const { predicted, actual } = req.body;

  await supabase.from("pilot_data").insert([{ predicted, actual }]);

  res.json({ success: true });
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

app.get("/pilot/data", async (req, res) => {
  const { data } = await supabase
    .from("pilot_data")
    .select("*")
    .order("created_at", { ascending: false });

  res.json(data);
});

// ================= FRONTEND =================

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
