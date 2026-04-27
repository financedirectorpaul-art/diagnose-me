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

// ================= PATH =================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= OPENAI =================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ================= SUPABASE =================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================= PERSONAL AI =================

app.post("/ai/personal-check", async (req, res) => {
  try {
    const { symptoms, answers } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
Return ONLY JSON:
{
  "causes": [],
  "reasoning": "",
  "questions": [],
  "urgency": "LOW | MEDIUM | HIGH"
}
          `
        },
        {
          role: "user",
          content: `Symptoms: ${symptoms}\nAnswers: ${answers || ""}`
        }
      ],
      temperature: 0.3
    });

    let text = completion.choices[0].message.content;

    try {
      res.json(JSON.parse(text));
    } catch {
      // fallback if AI returns bad JSON
      res.json({
        causes: ["Unable to determine"],
        reasoning: text,
        questions: [],
        urgency: "LOW"
      });
    }

  } catch (err) {
    console.error("Personal AI error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= CLINICAL AI =================

app.post("/ai/clinical-assist", async (req, res) => {
  try {
    const { note } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Identify documentation gaps that could impact clinical coding and funding."
        },
        {
          role: "user",
          content: note
        }
      ]
    });

    res.json({
      suggestions: completion.choices[0].message.content
        .split("\n")
        .filter(x => x.trim() !== "")
    });

  } catch (err) {
    console.error("Clinical AI error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= DRG ENGINE =================

app.post("/drg/estimate", (req, res) => {
  try {
    const { diagnosis } = req.body;

    let drg = "E62B";
    let weight = 1.2;

    if (diagnosis?.toLowerCase().includes("depression")) {
      drg = "U60A";
      weight = 1.8;
    }

    const funding = Math.round(weight * 7000);

    res.json({ drg, weight, funding });

  } catch (err) {
    console.error("DRG error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= PILOT TRACK =================

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

// ================= METRICS =================

app.get("/pilot/metrics", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pilot_data")
      .select("*");

    if (error) throw error;

    const predicted = data.reduce((a,b)=>a+(b.predicted||0),0);
    const actual = data.reduce((a,b)=>a+(b.actual||0),0);

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

// ================= CASE DATA =================

app.get("/pilot/data", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pilot_data")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);

  } catch (err) {
    console.error("Case data error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= FRONTEND =================

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= START =================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
