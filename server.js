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

// ================= PATH SETUP =================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= OPENAI =================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ================= API =================

// Personal AI tool
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

DO NOT diagnose.

Return:
1. Possible causes
2. Clinical reasoning
3. Follow-up questions
4. Urgency level (LOW, MEDIUM, HIGH)
          `
        },
        {
          role: "user",
          content: symptoms
        }
      ]
    });

    res.json({
      output: completion.choices[0].message.content
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================= FRONTEND =================

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Catch-all (THIS is the key fix)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= START =================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
