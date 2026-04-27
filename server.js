import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

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

// ================= IN-MEMORY STORE =================

let pilotData = [];

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

    // Safe parse fallback
    try {
      res.json(JSON.parse(text));
    } catch {
      res.json({
        causes: ["Unable to determine"],
        reasoning: text,
        questions: [],
        urgency: "LOW"
      });
    }

  } catch (err) {
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
        .filter(x => x)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= DRG ENGINE =================

app.post("/drg/estimate", (req, res) => {
  const { diagnosis } = req.body;

  let drg = "E62B";
  let weight = 1.2;

  if (diagnosis?.toLowerCase().includes("depression")) {
    drg = "U60A";
    weight = 1.8;
  }

  const funding = Math.round(weight * 7000);

  res.json({ drg, weight, funding });
});

// ================= PILOT TRACK =================

app.post("/pilot/track", (req, res) => {
  pilotData.push(req.body);
  res.json({ success: true });
});

// ================= METRICS =================

app.get("/pilot/metrics", (req, res) => {
  const predicted = pilotData.reduce((a,b)=>a+(b.predicted||0),0);
  const actual = pilotData.reduce((a,b)=>a+(b.actual||0),0);

  res.json({
    predicted,
    actual,
    delta: actual - predicted,
    total: pilotData.length
  });
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
