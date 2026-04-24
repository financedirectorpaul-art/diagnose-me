import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function safeFallback(message = "Unable to analyse safely.") {
  return {
    causes: [
      {
        name: "Unclear presentation",
        confidence: 55,
        reason: "The information provided is insufficient for a confident triage suggestion."
      }
    ],
    nextStep: message + " Seek GP/pharmacist advice if symptoms persist, worsen, or concern you.",
    urgency: "MEDIUM",
    confidence: 55,
    redFlags: [
      "Severe pain",
      "Difficulty breathing",
      "Chest pain",
      "Stroke symptoms",
      "Rapid worsening",
      "Fever or feeling very unwell"
    ],
    treatment: [
      "Monitor symptoms closely",
      "Avoid activities that worsen symptoms",
      "Seek professional medical advice if unsure"
    ]
  };
}

function emergencyOverride(input) {
  const text = `${input.text || ""} ${input.imageHint || ""}`.toLowerCase();
  const redFlags = [
    "chest pain",
    "can't breathe",
    "cannot breathe",
    "difficulty breathing",
    "stroke",
    "face drooping",
    "slurred speech",
    "unconscious",
    "collapse",
    "severe bleeding",
    "blue lips",
    "anaphylaxis"
  ];

  if (redFlags.some(flag => text.includes(flag))) {
    return {
      causes: [
        {
          name: "Potential emergency condition",
          confidence: 99,
          reason: "The symptoms include a red flag that can represent a life-threatening condition."
        }
      ],
      nextStep: "Call 000 immediately or seek emergency care now.",
      urgency: "EMERGENCY",
      confidence: 99,
      redFlags: redFlags,
      treatment: [
        "Call 000 now",
        "Do not drive yourself if seriously unwell",
        "Stay with another person if possible"
      ]
    };
  }

  return null;
}

app.post("/analyze", async (req, res) => {
  try {
    const input = req.body || {};

    const override = emergencyOverride(input);
    if (override) return res.json(override);

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json(safeFallback("OpenAI API key is not configured."));
    }

    const userText = `
User module: ${input.mode || "unknown"}
Symptoms / concern: ${input.text || "Not provided"}
Image context note: ${input.imageHint || "Not provided"}
Duration: ${input.duration || "Not provided"}
Severity: ${input.severity || "Not provided"}
Mechanism / cause: ${input.mechanism || "Not provided"}
Higher-risk situation: ${input.ageRisk || "Not provided"}
Follow-up answer: ${input.followUp || "Not provided"}
Location: ${input.location || "Not provided"}
`.trim();

    const content = [
      {
        type: "input_text",
        text: `You are a conservative AI health triage assistant with broad GP-level reasoning and specialist-informed knowledge.

IMPORTANT:
- You do not provide a diagnosis.
- You provide ranked possibilities, urgency and next steps.
- Be useful and specific. Do not simply say "not enough information" unless genuinely unavoidable.
- Always include clear red flags and safe basic care.
- Escalate aggressively if serious risk appears.
- Use Australian context where relevant, including 000 for emergencies and Healthdirect for health advice.
- Keep language plain English.

Return ONLY valid JSON in this exact structure:
{
  "causes": [
    {"name": "string", "confidence": 0, "reason": "string"},
    {"name": "string", "confidence": 0, "reason": "string"},
    {"name": "string", "confidence": 0, "reason": "string"}
  ],
  "nextStep": "specific actionable next step",
  "urgency": "LOW | MEDIUM | HIGH | EMERGENCY",
  "confidence": 0,
  "redFlags": ["string"],
  "treatment": ["string"],
  "imageFindings": ["string"]
}

User input:
${userText}`
      }
    ];

    if (input.imageBase64) {
      const mime = input.imageMimeType || "image/jpeg";
      const base64 = input.imageBase64.includes(",")
        ? input.imageBase64.split(",")[1]
        : input.imageBase64;

      content.push({
        type: "input_image",
        image_url: `data:${mime};base64,${base64}`
      });
    }

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content
        }
      ],
      temperature: 0.2
    });

    const text = response.output_text || "";
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.error("JSON parse failed:", text);
      return res.json(safeFallback("The AI response could not be safely parsed."));
    }

    if (!parsed.nextStep || !parsed.causes || !Array.isArray(parsed.causes)) {
      return res.json(safeFallback("The AI response was incomplete."));
    }

    return res.json(parsed);
  } catch (err) {
    console.error(err);
    return res.status(500).json(safeFallback("Clinical AI connection failed."));
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Diagnose Me running on port ${port}`);
});
