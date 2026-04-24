import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// Fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// MAIN ENDPOINT
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "No symptoms provided"
      });
    }

    const prompt = `
You are an experienced GP-level medical assistant.

Provide:
1. Top 3 likely causes (ranked)
2. Confidence for each
3. Clear reasoning
4. What to do next
5. Red flags
6. Basic treatment advice

Be clear and practical. Avoid vague responses.

Return ONLY JSON in this format:
{
  "causes": [
    {"name": "", "confidence": 0, "reason": ""},
    {"name": "", "confidence": 0, "reason": ""},
    {"name": "", "confidence": 0, "reason": ""}
  ],
  "nextStep": "",
  "urgency": "LOW | MEDIUM | HIGH | EMERGENCY",
  "confidence": 0,
  "redFlags": [],
  "treatment": []
}

Symptoms:
${text}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a clinical AI assistant." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3
    });

    const content = response.choices?.[0]?.message?.content || "{}";

    console.log("AI RESPONSE:", content);

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error("JSON parse error:", content);
      return res.status(500).json({
        error: "Invalid AI response format",
        raw: content
      });
    }

    res.json(parsed);

  } catch (error) {
    console.error("Backend error:", error);

    res.status(500).json({
      error: "Clinical AI failed",
      details: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
