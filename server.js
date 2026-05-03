import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;

const SAFETY_NOTICE = "Decision support only. Not a diagnosis.";

/* =========================
   🔍 DEBUG HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({
    status: "running",
    ai_enabled: !!openai,
    model: MODEL
  });
});

/* =========================
   🧠 AI CALL (FIXED)
========================= */
async function callAI(payload) {
  if (!openai) {
    console.error("❌ OpenAI not configured");
    return null;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a senior consultant clinician.

Rules:
- Ask ONE question only
- NEVER repeat questions
- Use provided facts to avoid duplication
- Be clinically logical

Return JSON only:
{
  "mode": "question",
  "question": "text",
  "reasoning": "text",
  "hypotheses": [
    {"condition":"string","probability":0}
  ]
}
`
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content;

    console.log("🧠 AI RAW:", raw);

    return JSON.parse(raw);

  } catch (err) {
    console.error("🔥 AI ERROR:", err.message);
    return null;
  }
}

/* =========================
   🧠 FACT CHECK
========================= */
function isMechanismKnown(facts) {
  return facts?.mechanismKnown;
}

/* =========================
   🎯 MAIN ENDPOINT
========================= */
app.post("/ai/personal-check", async (req, res) => {

  const { symptoms, answers, askedQuestions, facts, currentText } = req.body;

  console.log("📥 REQUEST:", { symptoms, answers, facts });

  const ai = await callAI(req.body);

  if (!ai || !ai.question) {
    console.log("⚠️ Using fallback");

    return res.json({
      mode: "question",
      question: isMechanismKnown(facts)
        ? "Were you able to continue playing after the injury?"
        : "Can you describe how it happened?",
      reasoning: "Fallback used due to AI failure",
      legal_notice: SAFETY_NOTICE
    });
  }

  return res.json({
    ...ai,
    legal_notice: SAFETY_NOTICE
  });
});

/* =========================
   🚀 START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`✅ Running on port ${PORT}`);
});
