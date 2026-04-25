import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ================= OPENAI =================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ================= HEALTH CHECK =================

app.get("/", (req, res) => {
  res.send("Diagnose Me backend running");
});

// ================= PERSONAL AI TOOL =================

app.post("/ai/personal-check", async (req, res) => {
  try {
    const { symptoms } = req.body;

    if (!symptoms) {
      return res.status(400).json({ error: "Symptoms required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are a cautious clinical assistant.

DO NOT provide a diagnosis.

Return:
1. Possible causes
2. Clinical reasoning
3. Follow-up questions
4. Urgency level (LOW, MEDIUM, HIGH)

Be clear, structured, and safe.
          `
        },
        {
          role: "user",
          content: symptoms
        }
      ],
      temperature: 0.4
    });

    res.json({
      output: completion.choices[0].message.content
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Clinical AI failed",
      details: err.message
    });
  }
});

// ================= PILOT TRACKING =================

let pilotData = [];

app.post("/pilot/track", (req, res) => {
  const body = req.body;

  const record = {
    id: Date.now(),
    episodeId: body.episodeId,
    patientId: body.patientId,
    predictedFunding: body.predictedFunding || 0,
    actualFunding: body.actualFunding || 0,
    createdAt: new Date()
  };

  pilotData.push(record);

  res.json({ success: true });
});

// ================= PILOT METRICS =================

app.get("/pilot/metrics", (req, res) => {
  const totalEpisodes = pilotData.length;

  const predicted = pilotData.reduce(
    (a, b) => a + (b.predictedFunding || 0),
    0
  );

  const actual = pilotData.reduce(
    (a, b) => a + (b.actualFunding || 0),
    0
  );

  const delta = actual - predicted;

  const avgDelta =
    totalEpisodes > 0 ? Math.round(delta / totalEpisodes) : 0;

  res.json({
    totalEpisodes,
    predicted,
    actual,
    delta,
    avgDelta,
    completionRate: totalEpisodes ? 100 : 0
  });
});

// ================= START SERVER =================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
