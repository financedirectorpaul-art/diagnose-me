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
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const SAFETY_NOTICE =
  "Decision support only. Not a diagnosis. Requires clinician review. If symptoms are severe, worsening, or urgent, seek medical care immediately.";

const users = {};
const cases = [];
const overrides = [];
const auditLogs = [];
const rateBucket = new Map();

function now() {
  return new Date().toISOString();
}

function audit(action, details = {}) {
  auditLogs.push({
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    timestamp: now(),
    action,
    details
  });

  if (auditLogs.length > 1000) auditLogs.shift();
}

function money(n) {
  return Number(n || 0);
}

function simpleRateLimit(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const count = rateBucket.get(key) || 0;

  if (count > 80) {
    return res.status(429).json({
      error: "Too many requests. Please slow down.",
      legal_notice: SAFETY_NOTICE
    });
  }

  rateBucket.set(key, count + 1);

  if (rateBucket.size > 5000) rateBucket.clear();

  next();
}

app.use(simpleRateLimit);

function classify(text = "") {
  const t = String(text).toLowerCase();

  if (/(diabetes|type 2|type two|prediabetes|blood sugar|glucose|hba1c|insulin resistance)/.test(t)) return "diabetes";
  if (/(chest pain|chest pressure|heart attack|cardiac|palpitations|crushing chest|angina|heart|tight chest)/.test(t)) return "cardiac";
  if (/(stroke|slurred|facial droop|one sided weakness|weak arm|weak leg|seizure|confusion|vision loss|headache|migraine|dizzy|vertigo|numb|tingling|weakness|blackout|vision)/.test(t)) return "neurological";
  if (/(can't breathe|cannot breathe|blue lips|shortness of breath|sob|wheeze|pneumonia|low oxygen|hypoxia|cough|flu|cold|sore throat|asthma|copd|breathing)/.test(t)) return "respiratory";
  if (/(sepsis|infection|fever|chills|cellulitis|pus|red hot|wound infection|abscess|sweats|very unwell|virus|fatigue)/.test(t)) return "infection";
  if (/(fracture|broken bone|broken|fall|injury|trauma|twisted|twist|sprain|deformed|open wound|cannot weight bear|can't weight bear|hockey|sport)/.test(t)) return "trauma";
  if (/(neck|back|spine|shoulder|knee|ankle|hip|wrist|elbow|joint|muscle|ache|stiff|spasm|tight|sore|swelling|locked|strain|sprain|arthritis)/.test(t)) return "musculoskeletal";
  if (/(depressed|anxious|panic|suicidal|kill myself|mental health|self harm|self-harm)/.test(t)) return "mental_health";
  if (/(stomach|abdominal|belly|nausea|vomit|diarrhoea|diarrhea|constipation)/.test(t)) return "gastrointestinal";
  if (/(urine|wee|burning when urinating|uti|kidney|flank)/.test(t)) return "urinary";
  if (/(rash|skin|itchy|lump|mole|lesion|spot|wound)/.test(t)) return "skin";

  return "general";
}

function detectIntent(text = "") {
  const t = String(text).toLowerCase();

  if (/(chest pain|can't breathe|cannot breathe|stroke|unconscious|severe bleeding|suicidal|kill myself|blue lips|facial droop|slurred speech)/.test(t)) {
    return "emergency";
  }

  if (/(prevent|avoid|reduce risk|best way|what should i do to prevent|how do i prevent|lifestyle|diet|exercise|screening)/.test(t)) {
    return "advice";
  }

  if (/(what is|explain|why does|how does|tell me about|difference between)/.test(t)) {
    return "education";
  }

  if (/(pain|hurt|sore|swelling|fever|injury|twisted|cough|vomit|rash|symptom|dizzy|bleeding|unwell|neck|back|knee|chest|headache)/.test(t)) {
    return "triage";
  }

  return "advice";
}

function emergencyTrigger(text = "") {
  const t = String(text).toLowerCase();

  const triggers = [
    "chest pain",
    "crushing chest",
    "can't breathe",
    "cannot breathe",
    "blue lips",
    "stroke",
    "facial droop",
    "slurred speech",
    "unconscious",
    "severe bleeding",
    "open fracture",
    "bone visible",
    "blue foot",
    "cold foot",
    "suicidal",
    "kill myself",
    "worst headache",
    "neck stiffness",
    "new confusion",
    "saddle numbness",
    "can't control bladder",
    "can't control bowel"
  ];

  return triggers.find(x => t.includes(x));
}

function questionsFor(type) {
  const q = {
    cardiac: [
      "Does the discomfort spread to the arm, jaw, back, neck or shoulder?",
      "Is there shortness of breath, sweating, nausea, dizziness or faintness?",
      "Is it worse with exertion or relieved by rest?",
      "Any history of heart disease, diabetes, hypertension, high cholesterol or smoking?"
    ],
    respiratory: [
      "Are you short of breath at rest, or only with activity?",
      "Do you have fever, chills, productive cough, wheeze or chest pain?",
      "What is the oxygen saturation, if known?",
      "Any asthma, COPD, heart disease, smoking history or immune suppression?",
      "Are symptoms getting better, worse, or staying about the same?"
    ],
    musculoskeletal: [
      "Did this start after a specific movement or injury, or did it come on gradually?",
      "Can you bear weight or use the affected area normally?",
      "Is there swelling, redness, warmth, locking, stiffness or instability?",
      "Do you have numbness, tingling, weakness, severe headache, fever, unexplained weight loss, or bladder or bowel symptoms?",
      "What makes the pain better or worse?"
    ],
    neurological: [
      "Did the symptoms start suddenly?",
      "Is there facial droop, slurred speech, weakness, numbness, confusion or vision change?",
      "Is one side of the body affected?",
      "Any seizure, severe headache, loss of consciousness or neck stiffness?",
      "Are symptoms improving, worsening or unchanged?"
    ],
    infection: [
      "Is there fever, chills, sweats or feeling very unwell?",
      "Is there redness, warmth, swelling, pus, rash or worsening pain?",
      "Any confusion, faintness, shortness of breath, fast heart rate or low blood pressure?",
      "Any diabetes, immune suppression, wound, recent surgery or recent hospital stay?",
      "Are symptoms spreading or worsening?"
    ],
    trauma: [
      "Can you bear weight or use the affected area now?",
      "Were you able to continue activity immediately after it happened?",
      "Is there deformity, abnormal angling, severe swelling or bruising?",
      "Any numbness, tingling, weakness, coldness, colour change or reduced movement?",
      "Is there an open wound, bleeding or bone visible?"
    ],
    mental_health: [
      "Are there thoughts of self-harm or harming someone else?",
      "Is the patient sleeping, eating and functioning normally?",
      "Any hallucinations, panic attacks, substance use or recent major stress?",
      "Is there someone safe with the patient now?",
      "Has this been getting worse recently?"
    ],
    gastrointestinal: [
      "Where exactly is the pain located?",
      "Is there vomiting, diarrhoea, fever, blood in stool or severe pain?",
      "Can the patient keep fluids down?",
      "Any recent travel, new foods, medication changes or known medical conditions?",
      "Is the pain constant, cramping, burning or sharp?"
    ],
    urinary: [
      "Is there burning when passing urine, needing to go more often, fever, or flank pain?",
      "Is there blood in the urine?",
      "Any pregnancy, kidney disease, diabetes, or immune suppression?",
      "Are there back or flank pains with fever or chills?",
      "How long has this been happening?"
    ],
    skin: [
      "Is the area painful, itchy, spreading, hot, swollen, blistering, bleeding or producing pus?",
      "Did it appear suddenly or gradually?",
      "Any fever, feeling unwell, or rapidly spreading redness?",
      "Any new medicines, foods, bites, chemicals, or contact exposures?",
      "Where on the body is it and how large is it?"
    ],
    general: [
      "What is the main symptom troubling you most right now?",
      "How severe are symptoms from 0 to 10?",
      "What makes symptoms better or worse?",
      "Any fever, chest pain, shortness of breath, weakness, vomiting, rash, swelling or severe pain?",
      "Has this happened before, and are there relevant medical conditions?"
    ]
  };

  return q[type] || q.general;
}

function icdFor(type) {
  const map = {
    diabetes: { code: "Z71.89", description: "Other specified counselling", confidence: 60 },
    respiratory: { code: "R06.02", description: "Shortness of breath / respiratory symptom", confidence: 60 },
    cardiac: { code: "R07.9", description: "Chest pain, unspecified", confidence: 55 },
    neurological: { code: "R29.818", description: "Other symptoms involving nervous system", confidence: 50 },
    infection: { code: "B99.9", description: "Unspecified infectious disease", confidence: 45 },
    trauma: { code: "T14.90", description: "Injury, unspecified", confidence: 50 },
    musculoskeletal: { code: "M25.50", description: "Pain in unspecified joint", confidence: 55 },
    mental_health: { code: "F41.9", description: "Anxiety disorder, unspecified", confidence: 45 },
    gastrointestinal: { code: "R10.9", description: "Unspecified abdominal pain", confidence: 55 },
    urinary: { code: "R30.0", description: "Dysuria", confidence: 45 },
    skin: { code: "R21", description: "Rash and other nonspecific skin eruption", confidence: 45 },
    general: { code: "R69", description: "Illness, unspecified", confidence: 40 }
  };

  return map[type] || map.general;
}

function cleanJsonText(text = "") {
  return String(text)
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

function detectGuidelinePathway(text = "", facts = {}, patient = {}) {
  const t = String(text).toLowerCase();

  if (/(diabetes|type 2|type two|prediabetes|blood sugar|glucose|hba1c|insulin resistance)/.test(t)) {
    return "diabetes_prevention";
  }

  if (/(neck|back|spine|spinal|sciatica)/.test(t)) {
    return "spinal_red_flags";
  }

  if (/(sepsis|fever|infection|confusion|very unwell|chills|low blood pressure|fast heart rate|short of breath|mottled|blue|not passing urine)/.test(t)) {
    return "sepsis_screen";
  }

  if (/(stroke|slurred|facial droop|face droop|one sided weakness|weak arm|weak leg|sudden weakness|vision loss)/.test(t)) {
    return "stroke_screen";
  }

  if (/(chest pain|chest pressure|crushing chest|angina|heart attack)/.test(t)) {
    return "chest_pain";
  }

  if (/(knee|twist|twisted|hockey|sport|sports|fall|trauma|injury)/.test(t)) {
    return "ottawa_knee";
  }

  if (/(shortness of breath|can't breathe|cannot breathe|wheeze|asthma|copd)/.test(t)) {
    return "breathing_red_flags";
  }

  if (/(headache|migraine|worst headache|thunderclap|neck stiffness)/.test(t)) {
    return "headache_red_flags";
  }

  if (/(abdominal pain|stomach pain|belly pain|severe stomach|blood in stool|black stool)/.test(t)) {
    return "abdominal_red_flags";
  }

  if (/(rash|skin|itchy|cellulitis|red hot|blister|mole|lesion)/.test(t)) {
    return "skin_red_flags";
  }

  if (/(urine|uti|burning when urinating|kidney|flank pain)/.test(t)) {
    return "urinary_red_flags";
  }

  if (/(anxious|depressed|panic|self harm|suicidal|kill myself)/.test(t)) {
    return "mental_health_safety";
  }

  return null;
}

function applyGuidelinePathway({ pathway, text = "", facts = {}, patient = {}, answers = [], intent = "triage", clinicalState = {} }) {
  const t = String(`${text} ${answers.join(" ")}`).toLowerCase();

  if (pathway === "diabetes_prevention" && intent !== "triage") {
    return {
      mode: "final",
      triage_score: 20,
      urgency: "Low",
      confidence: 88,
      overall_assessment:
        "This is a general prevention question rather than a symptom-based triage case. The best-supported way to reduce type 2 diabetes risk is to assess personal risk, maintain a healthy weight, stay physically active, and follow a sustainable high-fibre, lower-GI eating pattern.",
      differential: [],
      icd: {
        code: "Z71.89",
        description: "Other specified counselling",
        confidence: 60
      },
      missing_information: [
        "Age",
        "Body mass index or waist circumference",
        "Family history of diabetes",
        "History of gestational diabetes",
        "Blood pressure",
        "HbA1c or fasting glucose if high risk"
      ],
      advice:
        "Aim for at least 150 minutes per week of moderate physical activity, include resistance training if possible, reduce sugary drinks and highly refined carbohydrates, choose high-fibre foods, work toward a healthy waist and weight, avoid smoking, and consider a GP check for diabetes risk assessment and HbA1c or fasting glucose if you have risk factors.",
      revenue_prompts: [],
      funding: { baseline: 0, potential: 0, uplift: 0 },
      legal_notice: SAFETY_NOTICE
    };
  }

  if (pathway === "spinal_red_flags") {
    const redFlags = [
      "trauma",
      "fall",
      "accident",
      "fever",
      "weight loss",
      "night pain",
      "history of cancer",
      "cancer",
      "steroid use",
      "immunosuppressed",
      "iv drug use",
      "incontinence",
      "can't control bladder",
      "cannot control bladder",
      "can't control bowel",
      "cannot control bowel",
      "saddle numbness",
      "saddle anaesthesia",
      "weakness in legs",
      "progressive weakness",
      "numbness in both legs",
      "unsteady walking"
    ];

    const hasRedFlag = redFlags.some(flag => t.includes(flag));

    if (hasRedFlag) {
      return {
        mode: "final",
        triage_score: 90,
        urgency: "High",
        confidence: 85,
        overall_assessment:
          "Red flag features have been reported with neck, back or spinal symptoms. This may indicate a serious underlying condition such as spinal cord involvement, cauda equina syndrome, infection, fracture or malignancy. Urgent medical assessment is recommended.",
        differential: [
          {
            rank: 1,
            condition: "Spinal cord or nerve compression",
            probability: 35,
            likelihood: "Possible",
            reasoning: "Neurological or bladder, bowel, gait or weakness features are spinal red flags.",
            icd_suggestion: { code: "G95.9", description: "Disease of spinal cord, unspecified" }
          },
          {
            rank: 2,
            condition: "Spinal infection",
            probability: 25,
            likelihood: "Possible",
            reasoning: "Fever, immune suppression or intravenous drug use increases concern.",
            icd_suggestion: { code: "M46.2", description: "Osteomyelitis of vertebra" }
          },
          {
            rank: 3,
            condition: "Fracture or malignancy-related spinal pain",
            probability: 25,
            likelihood: "Possible",
            reasoning: "Trauma, steroid use, cancer history, unexplained weight loss or night pain increase risk.",
            icd_suggestion: { code: "M54.9", description: "Dorsalgia, unspecified" }
          }
        ],
        icd: { code: "M54.9", description: "Dorsalgia, unspecified", confidence: 50 },
        missing_information: [
          "Detailed neurological examination",
          "Bladder and bowel function",
          "Saddle sensation",
          "Fever and infection risk",
          "Cancer history",
          "Trauma or osteoporosis risk"
        ],
        advice:
          "Seek urgent medical assessment. Do not delay if there is weakness, numbness, bladder or bowel change, saddle numbness, fever, severe worsening pain, unexplained weight loss, night pain, or recent trauma.",
        funding: { baseline: 1200, potential: 2500, uplift: 1300 },
        revenue_prompts: [
          { message: "Document spinal red flags, neurological symptoms, bladder and bowel function, and trauma or cancer history.", value: 300 }
        ],
        legal_notice: SAFETY_NOTICE
      };
    }

    if (/(neck)/.test(t) && !facts.mechanismKnown && answers.length === 0) {
      return {
        mode: "question",
        question: "Did this start after a specific movement or injury, or did it come on gradually?",
        reasoning: "This helps distinguish mechanical neck strain from other causes and guides the next red flag screen.",
        clinicalState: {
          suspectedCategory: "neck pain",
          keyFindings: ["Neck pain reported"],
          missingCritical: ["Mechanism of onset", "Neurological symptoms", "Red flags"],
          redFlagsChecked: [],
          hypotheses: [
            { condition: "Muscle strain", probability: 50, reasoning: "Common cause of acute neck pain." },
            { condition: "Facet joint irritation", probability: 30, reasoning: "Often movement or posture related." },
            { condition: "Disc or nerve-related pain", probability: 20, reasoning: "Requires neurological screening." }
          ]
        },
        legal_notice: SAFETY_NOTICE
      };
    }

    if (/(neck|back|spine)/.test(t) && !facts.neurovascularKnown && answers.length <= 2) {
      return {
        mode: "question",
        question: "Do you have any numbness, tingling, weakness in your arms or legs, problems walking, severe headache, fever, unexplained weight loss, or bladder or bowel changes?",
        reasoning: "This screens for spinal red flags including nerve involvement, infection, malignancy, fracture risk and cord compression.",
        clinicalState: {
          suspectedCategory: "spinal pain",
          keyFindings: clinicalState.keyFindings || [],
          missingCritical: ["Neurological symptoms", "Systemic red flags", "Bladder and bowel symptoms"],
          redFlagsChecked: [],
          hypotheses: [
            { condition: "Mechanical spinal pain", probability: 65, reasoning: "Most neck and back pain is mechanical when red flags are absent." },
            { condition: "Disc or nerve-related pain", probability: 20, reasoning: "Needs screening for numbness, tingling or weakness." },
            { condition: "Serious spinal pathology", probability: 15, reasoning: "Low probability but high consequence; red flags must be checked." }
          ]
        },
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  if (pathway === "ottawa_knee") {
    const age = Number(patient.age || 0);

    const criteria = {
      age55: age >= 55,
      fibularHeadTenderness: /fibular head|outside of knee|outer knee bony tenderness/.test(t),
      isolatedPatellaTenderness: /patella|kneecap|knee cap/.test(t) && /tender|painful|sore/.test(t),
      cannotFlex90: /can't bend|cannot bend|cant bend|less than 90|won't bend/.test(t),
      cannotWeightBear: /can't walk|cannot walk|cant walk|unable to walk|can't bear weight|cannot bear weight|unable to bear weight|four steps/.test(t)
    };

    const positive = Object.values(criteria).some(Boolean);

    if (positive) {
      return {
        mode: "final",
        triage_score: 75,
        urgency: "Moderate to High",
        confidence: 82,
        overall_assessment:
          "This knee injury triggers an Ottawa Knee Rule criterion, so an x-ray should be considered to assess for fracture. This does not mean there is definitely a fracture, but it raises the need for clinical review and imaging.",
        differential: [
          {
            rank: 1,
            condition: "Fracture or bony injury",
            probability: 35,
            likelihood: "Possible",
            reasoning: "Ottawa Knee Rule positive.",
            icd_suggestion: { code: "S82.90", description: "Fracture of lower leg, unspecified" }
          },
          {
            rank: 2,
            condition: "Ligament injury",
            probability: 35,
            likelihood: "Possible",
            reasoning: "Twisting sports mechanism.",
            icd_suggestion: { code: "S83.90", description: "Sprain of unspecified site of knee" }
          },
          {
            rank: 3,
            condition: "Meniscal injury",
            probability: 30,
            likelihood: "Possible",
            reasoning: "Twisting injury can involve meniscus, especially with locking or catching.",
            icd_suggestion: { code: "S83.20", description: "Tear of meniscus, current injury" }
          }
        ],
        icd: { code: "S89.90", description: "Unspecified injury of lower leg", confidence: 55 },
        missing_information: [
          "Exact bony tenderness site",
          "Ability to take four steps",
          "Range of motion",
          "Neurovascular status",
          "Clinician examination"
        ],
        advice:
          "Arrange clinical review and consider x-ray. Seek urgent care if there is deformity, inability to walk, severe swelling, numbness, coldness, colour change, or severe worsening pain.",
        funding: { baseline: 1200, potential: 2200, uplift: 1000 },
        revenue_prompts: [
          { message: "Document Ottawa Knee Rule criteria and weight-bearing ability.", value: 250 }
        ],
        legal_notice: SAFETY_NOTICE
      };
    }

    if (!facts.weightBearingKnown) {
      return {
        mode: "question",
        question: "Can you bear weight and take four steps on it now?",
        reasoning: "This applies the Ottawa Knee Rule and helps decide whether x-ray assessment is needed.",
        clinicalState: {
          suspectedCategory: "knee injury",
          keyFindings: facts.mechanismKnown ? ["Mechanism described"] : [],
          missingCritical: ["Weight-bearing", "Flexion to 90 degrees", "Bony tenderness"],
          redFlagsChecked: [],
          hypotheses: [
            { condition: "Ligament sprain or tear", probability: 40, reasoning: "Sports twisting mechanism." },
            { condition: "Meniscal injury", probability: 35, reasoning: "Twisting mechanism." },
            { condition: "Fracture or bony injury", probability: 25, reasoning: "Needs Ottawa Knee Rule screening." }
          ]
        },
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  if (pathway === "sepsis_screen") {
    const highRisk =
      /(confusion|mottled|blue|cyanosis|not passing urine|severe breathlessness|very drowsy|collapse|low blood pressure)/.test(t);

    if (highRisk) {
      return {
        mode: "final",
        triage_score: 95,
        urgency: "EMERGENCY",
        confidence: 85,
        overall_assessment:
          "Possible sepsis red flags are present. This needs urgent medical assessment now.",
        differential: [
          {
            rank: 1,
            condition: "Possible sepsis",
            probability: 70,
            likelihood: "Possible",
            reasoning: "Infection symptoms with high-risk features.",
            icd_suggestion: { code: "A41.9", description: "Sepsis, unspecified organism" }
          }
        ],
        advice:
          "Seek urgent emergency medical care now. Do not wait for online advice if the person is confused, very drowsy, breathless, mottled or blue, collapsing, or not passing urine.",
        missing_information: ["Temperature", "Heart rate", "Respiratory rate", "Blood pressure", "Oxygen saturation"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }

    return {
      mode: "question",
      question: "Is the person confused, very drowsy, severely breathless, mottled or blue, collapsing, or passing very little urine?",
      reasoning: "This screens for high-risk sepsis features that require urgent escalation.",
      clinicalState: {
        suspectedCategory: "possible infection or sepsis",
        keyFindings: [],
        missingCritical: ["Mental state", "Breathing", "Circulation", "Urine output"],
        redFlagsChecked: [],
        hypotheses: [
          { condition: "Uncomplicated infection", probability: 55, reasoning: "Infection symptoms without confirmed high-risk features yet." },
          { condition: "Possible sepsis", probability: 30, reasoning: "Needs red-flag screening." },
          { condition: "Viral illness", probability: 15, reasoning: "Common alternative depending on symptoms." }
        ]
      },
      legal_notice: SAFETY_NOTICE
    };
  }

  if (pathway === "stroke_screen") {
    return {
      mode: "final",
      triage_score: 95,
      urgency: "EMERGENCY",
      confidence: 85,
      overall_assessment:
        "Possible stroke symptoms have been described. Sudden facial droop, arm weakness, speech problems, confusion or vision loss require emergency assessment immediately.",
      differential: [
        {
          rank: 1,
          condition: "Possible stroke or transient ischemic attack",
          probability: 70,
          likelihood: "Possible",
          reasoning: "Sudden focal neurological symptoms are high-risk.",
          icd_suggestion: { code: "I64", description: "Stroke, not specified as haemorrhage or infarction" }
        }
      ],
      advice: "Call emergency services immediately. Do not drive yourself.",
      missing_information: ["Exact time symptoms started", "FAST symptoms", "Blood glucose", "Blood pressure"],
      funding: { baseline: 0, potential: 0, uplift: 0 },
      revenue_prompts: [],
      legal_notice: SAFETY_NOTICE
    };
  }

  if (pathway === "chest_pain") {
    return {
      mode: "final",
      triage_score: 90,
      urgency: "EMERGENCY",
      confidence: 80,
      overall_assessment:
        "Chest pain or pressure can be cardiac until proven otherwise, especially if it is heavy, crushing, exertional, associated with breathlessness, sweating, nausea, dizziness, or radiation to the arm, jaw, neck, back or shoulder.",
      differential: [
        {
          rank: 1,
          condition: "Acute coronary syndrome",
          probability: 45,
          likelihood: "Possible",
          reasoning: "Chest pain pattern requires urgent exclusion.",
          icd_suggestion: { code: "I24.9", description: "Acute ischaemic heart disease, unspecified" }
        },
        {
          rank: 2,
          condition: "Pulmonary embolism or respiratory cause",
          probability: 25,
          likelihood: "Possible",
          reasoning: "Breathlessness or pleuritic pain may point away from cardiac causes.",
          icd_suggestion: { code: "R07.9", description: "Chest pain, unspecified" }
        }
      ],
      advice: "Seek urgent emergency assessment now for chest pain or pressure. Do not ignore or self-manage potentially cardiac chest pain.",
      missing_information: ["Onset", "Radiation", "Breathlessness", "Sweating", "Nausea", "Cardiac risk factors"],
      funding: { baseline: 0, potential: 0, uplift: 0 },
      revenue_prompts: [],
      legal_notice: SAFETY_NOTICE
    };
  }

  if (pathway === "breathing_red_flags") {
    const severe = /(can't breathe|cannot breathe|blue lips|severe breathlessness|struggling to breathe|unable to speak)/.test(t);

    if (severe) {
      return {
        mode: "final",
        triage_score: 95,
        urgency: "EMERGENCY",
        confidence: 85,
        overall_assessment: "Severe breathing difficulty is an emergency symptom.",
        differential: [
          {
            rank: 1,
            condition: "Severe respiratory distress",
            probability: 70,
            likelihood: "Possible",
            reasoning: "Reported severe breathlessness or cyanosis.",
            icd_suggestion: { code: "R06.03", description: "Acute respiratory distress" }
          }
        ],
        advice: "Seek emergency medical care immediately.",
        missing_information: ["Oxygen saturation", "Respiratory rate", "Chest pain", "Wheeze", "Fever"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }

    return {
      mode: "question",
      question: "Are you short of breath at rest, struggling to speak in full sentences, or are your lips or fingers blue?",
      reasoning: "This screens for severe respiratory distress requiring urgent care.",
      clinicalState: {
        suspectedCategory: "breathing symptoms",
        keyFindings: [],
        missingCritical: ["Severity at rest", "Ability to speak", "Cyanosis", "Oxygen saturation"],
        redFlagsChecked: [],
        hypotheses: [
          { condition: "Viral respiratory illness", probability: 35, reasoning: "Common cause." },
          { condition: "Asthma or airway flare", probability: 30, reasoning: "Wheeze or breathlessness pattern." },
          { condition: "Pneumonia or serious respiratory illness", probability: 25, reasoning: "Needs fever and severity assessment." }
        ]
      },
      legal_notice: SAFETY_NOTICE
    };
  }

  if (pathway === "headache_red_flags") {
    const severe = /(worst headache|thunderclap|sudden severe|neck stiffness|confusion|weakness|vision loss|fever)/.test(t);

    if (severe) {
      return {
        mode: "final",
        triage_score: 90,
        urgency: "EMERGENCY",
        confidence: 80,
        overall_assessment:
          "Headache red flags have been reported. Sudden severe headache, neck stiffness, fever, confusion, weakness or vision loss requires urgent medical assessment.",
        differential: [
          {
            rank: 1,
            condition: "Serious headache cause requiring urgent exclusion",
            probability: 60,
            likelihood: "Possible",
            reasoning: "Red flag headache features.",
            icd_suggestion: { code: "R51.9", description: "Headache, unspecified" }
          }
        ],
        advice: "Seek urgent medical care now.",
        missing_information: ["Onset speed", "Neurological symptoms", "Fever", "Neck stiffness", "Trauma"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  if (pathway === "abdominal_red_flags") {
    const severe = /(severe pain|rigid abdomen|black stool|blood in stool|vomiting blood|fainting|pregnant|right lower abdomen|chest pain)/.test(t);

    if (severe) {
      return {
        mode: "final",
        triage_score: 85,
        urgency: "High",
        confidence: 75,
        overall_assessment:
          "Abdominal red flags have been reported. Severe abdominal pain, blood, black stool, pregnancy, fainting, or rigid abdomen needs urgent clinical assessment.",
        differential: [
          {
            rank: 1,
            condition: "Serious abdominal condition requiring urgent exclusion",
            probability: 55,
            likelihood: "Possible",
            reasoning: "Red flag abdominal features.",
            icd_suggestion: { code: "R10.0", description: "Acute abdomen" }
          }
        ],
        advice: "Seek urgent medical assessment, especially if pain is severe, persistent, associated with fever, fainting, blood, pregnancy or worsening symptoms.",
        missing_information: ["Pain location", "Fever", "Vomiting", "Bowel changes", "Pregnancy status", "Blood in stool"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  if (pathway === "skin_red_flags") {
    const severe = /(rapidly spreading|red streak|fever|very painful|black skin|purple rash|blistering|face swelling|trouble breathing)/.test(t);

    if (severe) {
      return {
        mode: "final",
        triage_score: 80,
        urgency: "High",
        confidence: 75,
        overall_assessment:
          "Skin red flags have been reported. Rapidly spreading redness, fever, severe pain, purple rash, black skin, blistering, facial swelling or breathing difficulty needs urgent clinical assessment.",
        differential: [
          {
            rank: 1,
            condition: "Serious skin infection or allergic reaction",
            probability: 55,
            likelihood: "Possible",
            reasoning: "Red flag skin features.",
            icd_suggestion: { code: "L03.90", description: "Cellulitis, unspecified" }
          }
        ],
        advice: "Seek urgent medical assessment if redness is spreading quickly, there is fever, severe pain, purple or black skin change, blistering, facial swelling, or breathing difficulty.",
        missing_information: ["Spread rate", "Fever", "Pain severity", "Exposure history", "Medication history"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  if (pathway === "urinary_red_flags") {
    const severe = /(fever|flank pain|kidney pain|pregnant|vomiting|confusion|blood in urine|male)/.test(t);

    if (severe) {
      return {
        mode: "final",
        triage_score: 75,
        urgency: "Moderate to High",
        confidence: 75,
        overall_assessment:
          "Urinary symptoms with fever, flank pain, vomiting, pregnancy, confusion, blood in urine, or male urinary infection features need prompt clinical assessment.",
        differential: [
          {
            rank: 1,
            condition: "Urinary tract infection or kidney infection",
            probability: 60,
            likelihood: "Possible",
            reasoning: "Urinary symptoms with possible complication features.",
            icd_suggestion: { code: "N39.0", description: "Urinary tract infection, site not specified" }
          }
        ],
        advice: "Arrange prompt medical review, especially with fever, flank pain, vomiting, pregnancy, confusion, blood in urine, or worsening symptoms.",
        missing_information: ["Fever", "Flank pain", "Pregnancy status", "Urine blood", "Vomiting", "Past kidney disease"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  if (pathway === "mental_health_safety") {
    const danger = /(suicidal|kill myself|self harm|hurt myself|hurt someone|not safe)/.test(t);

    if (danger) {
      return {
        mode: "final",
        triage_score: 95,
        urgency: "EMERGENCY",
        confidence: 85,
        overall_assessment:
          "There may be immediate safety concerns. This needs urgent support now.",
        differential: [
          {
            rank: 1,
            condition: "Acute mental health safety risk",
            probability: 70,
            likelihood: "Possible",
            reasoning: "Self-harm or harm-related language.",
            icd_suggestion: { code: "R45.851", description: "Suicidal ideations" }
          }
        ],
        advice: "If there is immediate danger, call emergency services now. If possible, stay with a trusted person and remove access to means of harm.",
        missing_information: ["Immediate safety", "Plan or intent", "Supports present", "Substance use", "Previous attempts"],
        funding: { baseline: 0, potential: 0, uplift: 0 },
        revenue_prompts: [],
        legal_notice: SAFETY_NOTICE
      };
    }
  }

  return null;
}

function isDuplicateQuestion(nextQuestion = "", askedQuestions = [], facts = {}) {
  const q = String(nextQuestion).toLowerCase();

  if (!q) return true;

  if (facts.mechanismKnown && /(how did|what happened|mechanism|specific injury|twist|fall|overuse|happened)/.test(q)) return true;
  if (facts.onsetKnown && /(when did|how long|start|began|begin|onset)/.test(q)) return true;
  if (facts.weightBearingKnown && /(bear weight|walk|walking|continue playing)/.test(q)) return true;
  if (facts.swellingKnown && /(swelling|swollen)/.test(q)) return true;
  if (facts.lockingKnown && /(locking|catching|giving way|unstable|buckling)/.test(q)) return true;

  return askedQuestions.some(prev => {
    const p = String(prev).toLowerCase();

    if (p === q) return true;

    const groups = [
      ["when did", "how long", "start", "began", "onset"],
      ["how did", "what happened", "mechanism", "specific injury", "twist", "fall", "overuse", "happened"],
      ["bear weight", "walk", "walking", "continue playing"],
      ["swelling", "swollen"],
      ["locking", "catching", "giving way", "unstable", "buckling"],
      ["bend", "straighten", "move fully"]
    ];

    return groups.some(group =>
      group.some(word => p.includes(word)) && group.some(word => q.includes(word))
    );
  });
}

function chooseFallbackQuestion(type, askedQuestions = [], facts = {}) {
  const candidates = questionsFor(type);
  return candidates.find(q => !isDuplicateQuestion(q, askedQuestions, facts))
    || "What is the most concerning thing about it right now — pain, swelling, instability, inability to walk, numbness, or something else?";
}

function normaliseQuestion(question = "", type = "general", askedQuestions = [], facts = {}) {
  let q = String(question || "").trim();

  if (!q || isDuplicateQuestion(q, askedQuestions, facts)) {
    q = chooseFallbackQuestion(type, askedQuestions, facts);
  }

  if (facts.mechanismKnown && /(how did|what happened|mechanism|specific injury|twist|fall|overuse|happened)/i.test(q)) {
    q = "Were you able to continue activity or use the affected area immediately after it happened?";
  }

  if (facts.onsetKnown && /(when did|how long|start|began|begin|onset)/i.test(q)) {
    q = "Has it been getting better, worse, or staying about the same?";
  }

  if (facts.weightBearingKnown && /(bear weight|walk|walking|continue playing)/i.test(q)) {
    q = "Is there locking, catching, giving way, numbness, tingling, or weakness?";
  }

  if (facts.swellingKnown && /(swelling|swollen)/i.test(q)) {
    q = "Can you fully move the affected area?";
  }

  return q;
}

function fallbackAssessment(symptoms, answers = [], facts = {}) {
  const combined = `${symptoms || ""} ${answers.join(" ")}`;
  const type = classify(combined);
  const red = emergencyTrigger(combined);
  const icd = icdFor(type);

  if (red) {
    return {
      mode: "final",
      triage_score: 100,
      urgency: "EMERGENCY",
      confidence: 95,
      uncertainty: "Emergency red flag detected. Diagnosis still requires clinician review.",
      overall_assessment: `Emergency red flag detected: ${red.toUpperCase()}. Seek urgent medical care immediately.`,
      differential: [],
      conditions: [],
      icd,
      cpt: "99285",
      denial_risk: "Low if emergency documentation supports medical necessity",
      missing_information: [],
      funding: { baseline: 1200, potential: 2500, uplift: 1300 },
      revenue_prompts: [],
      advice: "Escalate immediately. Do not rely on this app for emergency decision-making.",
      legal_notice: SAFETY_NOTICE
    };
  }

  const score =
    type === "cardiac" || type === "neurological" ? 78 :
    type === "respiratory" || type === "infection" || type === "trauma" ? 66 :
    type === "musculoskeletal" ? 52 :
    45;

  return {
    mode: "final",
    triage_score: score,
    urgency: score >= 75 ? "High" : score >= 60 ? "Moderate to High" : "Moderate",
    confidence: 62,
    uncertainty: "Moderate. This is symptom-based decision support and requires clinician review.",
    overall_assessment:
      `Based on the information provided, this appears most consistent with a ${type.replace("_", " ")} presentation. Clinical review is still required.`,
    differential: [
      {
        rank: 1,
        condition: `${type.replace("_", " ")} condition`,
        probability: 55,
        likelihood: "Possible",
        reasoning: "The symptom wording and answers align with this category.",
        icd_suggestion: icd
      }
    ],
    conditions: [
      {
        name: `${type.replace("_", " ")} presentation`,
        likelihood: "Possible",
        reason: "Suggested by symptom category."
      }
    ],
    icd,
    cpt: score >= 70 ? "99284" : "99213",
    denial_risk: score >= 70 ? "Moderate" : "Low",
    missing_information: [
      "Vital signs",
      "Relevant past medical history",
      "Medication and allergy history",
      "Clinician examination findings"
    ],
    funding: {
      baseline: 1200,
      potential: score >= 70 ? 2200 : 1600,
      uplift: score >= 70 ? 1000 : 400
    },
    revenue_prompts: [
      { message: "Document symptom duration, severity, relevant negatives and examination findings.", value: 250 },
      { message: "Record comorbidities, medications, observations and escalation decisions.", value: 300 }
    ],
    advice:
      "Arrange appropriate clinical review. Escalate urgently if symptoms worsen, severe pain develops, breathing becomes difficult, neurological symptoms occur, or the patient appears significantly unwell.",
    legal_notice: SAFETY_NOTICE
  };
}

async function callClinicalAI(payload) {
  if (!openai) {
    console.error("OPENAI_API_KEY is missing in Render environment variables.");
    return null;
  }

  const system = `
You are DOCTORPD acting as a senior consultant clinician.

You are clinical decision-support only, not a doctor. You must not present output as a diagnosis. Always require clinician review.

Use hypothesis-driven clinical reasoning.

Rules:
- Ask ONE best next discriminating question only.
- Never use numbered-question language.
- Never repeat or rephrase a previous question.
- Use the facts object to avoid duplication.
- If facts.mechanismKnown is true, do NOT ask how the injury happened, whether there was a twist, fall, overuse, or specific injury.
- If facts.onsetKnown is true, do NOT ask when symptoms started or how long they have been present.
- If facts.weightBearingKnown is true, do NOT ask whether they can walk, bear weight, or continue playing.
- If facts.swellingKnown is true, do NOT ask whether swelling is present.
- If facts.lockingKnown is true, do NOT ask whether it locks, catches or gives way.
- Prioritise dangerous conditions first.
- If emergency red flags are suggested, finalise with urgency EMERGENCY.
- Stop asking questions when preliminary assessment or escalation decision is sufficiently clear.
- Do not diagnose definitively.

Return ONLY valid JSON.

If asking another question:
{
  "mode": "question",
  "question": "single best next discriminating question",
  "reasoning": "why this question matters",
  "clinicalState": {
    "suspectedCategory": "string",
    "keyFindings": ["string"],
    "missingCritical": ["string"],
    "redFlagsChecked": ["string"],
    "hypotheses": [
      {"condition": "string", "probability": 0, "reasoning": "string"},
      {"condition": "string", "probability": 0, "reasoning": "string"},
      {"condition": "string", "probability": 0, "reasoning": "string"}
    ]
  },
  "legal_notice": "${SAFETY_NOTICE}"
}

If final:
{
  "mode": "final",
  "triage_score": 0,
  "urgency": "Low | Moderate | Moderate to High | High | EMERGENCY",
  "confidence": 0,
  "uncertainty": "string",
  "overall_assessment": "string",
  "differential": [
    {
      "rank": 1,
      "condition": "string",
      "probability": 0,
      "likelihood": "Unlikely | Possible | Likely",
      "reasoning": "string",
      "icd_suggestion": {
        "code": "string",
        "description": "string"
      }
    }
  ],
  "conditions": [
    {
      "name": "string",
      "likelihood": "string",
      "reason": "string"
    }
  ],
  "icd": {
    "code": "string",
    "description": "string",
    "confidence": 0
  },
  "cpt": "string",
  "denial_risk": "Low | Moderate | High",
  "missing_information": ["string"],
  "funding": {
    "baseline": 0,
    "potential": 0,
    "uplift": 0
  },
  "revenue_prompts": [
    {
      "message": "string",
      "value": 0
    }
  ],
  "clinicalState": {
    "suspectedCategory": "string",
    "keyFindings": ["string"],
    "missingCritical": ["string"],
    "redFlagsChecked": ["string"],
    "hypotheses": [
      {"condition": "string", "probability": 0, "reasoning": "string"}
    ]
  },
  "advice": "string",
  "legal_notice": "${SAFETY_NOTICE}"
}
`;

  const user = `
Patient:
${JSON.stringify(payload.patient || {}, null, 2)}

Initial complaint:
${payload.symptoms || ""}

Previous questions already asked:
${(payload.askedQuestions || []).map(q => `- ${q}`).join("\n") || "None"}

Previous answers:
${(payload.answers || []).map((a, i) => `${i + 1}. ${a}`).join("\n") || "None"}

Known facts:
${JSON.stringify(payload.facts || {}, null, 2)}

Current clinical state:
${JSON.stringify(payload.clinicalState || {}, null, 2)}

Latest user input:
${payload.currentText || ""}

Image supplied:
${payload.imageBase64 ? "Yes" : "No"}

Task:
Use senior-consultant hypothesis-driven reasoning. Do not ask for information already known in facts. Either ask one high-value discriminating question or provide final structured decision-support assessment.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    console.log("AI RAW RESPONSE:", raw);
    return JSON.parse(cleanJsonText(raw));
  } catch (err) {
    console.error("AI ERROR:", err?.message || err);
    return null;
  }
}

async function callFreeChatAI(question, context = {}, intent = "advice") {
  if (!openai) {
    console.error("OPENAI_API_KEY is missing in Render environment variables.");
    return null;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content: `
You are DOCTORPD acting like a senior general practitioner.

Intent: ${intent}

Behaviour:
- triage: ask structured clinical questions.
- advice: give practical prevention, lifestyle and next-step advice.
- education: explain clearly in plain English.
- emergency: escalate immediately.

Rules:
- Never ask symptom-triage questions for advice or education questions.
- Do not diagnose definitively.
- Be clear, safe, useful and concise.
- Offer personalisation where useful.
- Include safety advice where appropriate.
`
        },
        {
          role: "user",
          content: `User question:\n${question}\n\nKnown context:\n${JSON.stringify(context || {}, null, 2)}`
        }
      ]
    });

    return completion.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.error("FREE CHAT AI ERROR:", err?.message || err);
    return null;
  }
}

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    time: now(),
    ai_enabled: !!openai,
    model: MODEL,
    has_openai_key: !!process.env.OPENAI_API_KEY,
    legal_notice: SAFETY_NOTICE
  });
});

app.post("/auth/register", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (users[email]) return res.status(400).json({ error: "User already exists" });

  users[email] = { password, patients: [], created_at: now() };
  audit("REGISTER", { email });

  res.json({ success: true });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;

  if (!users[email] || users[email].password !== password) {
    audit("LOGIN_FAILED", { email });
    return res.status(401).json({ error: "Invalid email or password" });
  }

  audit("LOGIN", { email });
  res.json({ success: true });
});

app.get("/patients", (req, res) => {
  const email = req.query.email;
  if (!users[email]) return res.json([]);
  res.json(users[email].patients);
});

app.post("/patients", (req, res) => {
  const { email, name, age, gender } = req.body;

  if (!users[email]) return res.status(401).json({ error: "Not logged in" });

  const patient = { id: Date.now().toString(), name, age, gender, createdAt: now() };
  users[email].patients.push(patient);
  audit("CREATE_PATIENT", { email, patient });

  res.json(patient);
});

app.post("/ai/personal-check", async (req, res) => {
  try {
    let {
      symptoms = "",
      answers = [],
      askedQuestions = [],
      clinicalState = {},
      facts = {},
      currentText = "",
      imageBase64 = "",
      patient = {},
      intent = "triage"
    } = req.body;

    if (!Array.isArray(answers)) answers = [];
    if (!Array.isArray(askedQuestions)) askedQuestions = [];

    const combined = `${symptoms} ${answers.join(" ")} ${currentText}`;
    const type = classify(combined);
    const red = emergencyTrigger(combined);

    if (red) {
      const emergency = fallbackAssessment(combined, answers, facts);
      emergency.urgency = "EMERGENCY";
      emergency.triage_score = 100;
      emergency.overall_assessment = `Emergency red flag detected: ${red.toUpperCase()}. Seek urgent medical care immediately.`;
      return res.json(emergency);
    }

    const pathway = detectGuidelinePathway(combined, facts, patient);
    const guidelineResult = applyGuidelinePathway({
      pathway,
      text: combined,
      facts,
      patient,
      answers,
      intent,
      clinicalState
    });

    if (guidelineResult) return res.json(guidelineResult);

    let ai = await callClinicalAI({
      symptoms,
      answers,
      askedQuestions,
      clinicalState,
      facts,
      currentText,
      imageBase64,
      patient
    });

    if (!ai || !ai.mode) {
      const enoughInfo = answers.length >= 5 || combined.length > 260;

      if (!enoughInfo) {
        const next = chooseFallbackQuestion(type, askedQuestions, facts);
        return res.json({
          mode: "question",
          question: next,
          reasoning: "This question helps narrow the likely causes and assess risk.",
          clinicalState,
          hypotheses: clinicalState?.hypotheses || [],
          legal_notice: SAFETY_NOTICE
        });
      }

      ai = fallbackAssessment(symptoms, answers, facts);
    }

    if (ai.mode === "question") {
      const nextQuestion = normaliseQuestion(ai.question, type, askedQuestions, facts);

      audit("GUIDED_TRIAGE_QUESTION", {
        symptoms,
        answersCount: answers.length,
        askedCount: askedQuestions.length,
        facts,
        question: nextQuestion
      });

      return res.json({
        mode: "question",
        question: nextQuestion,
        reasoning: ai.reasoning || "This question helps narrow the likely causes and assess risk.",
        clinicalState: ai.clinicalState || clinicalState,
        hypotheses: ai.clinicalState?.hypotheses || ai.hypotheses || clinicalState?.hypotheses || [],
        legal_notice: SAFETY_NOTICE
      });
    }

    ai.legal_notice = SAFETY_NOTICE;
    return res.json(ai);
  } catch (err) {
    audit("GUIDED_TRIAGE_SERVER_ERROR", { error: err.message });

    return res.status(500).json({
      mode: "error",
      error: "Unable to process guided triage",
      details: err.message,
      legal_notice: SAFETY_NOTICE
    });
  }
});

app.post("/ai/ask-doctor", async (req, res) => {
  try {
    const { question = "", context = {}, imageBase64 = "", intent = detectIntent(question) } = req.body;
    const combined = `${question} ${JSON.stringify(context || {})}`;
    const red = emergencyTrigger(combined);

    if (red) {
      return res.json({
        response:
          `Emergency red flag detected: ${red.toUpperCase()}.\n\n` +
          `Please seek urgent medical care immediately.\n\n${SAFETY_NOTICE}`
      });
    }

    const pathway = detectGuidelinePathway(question, context?.facts || {}, context?.patient || {});
    const guidelineResult = applyGuidelinePathway({
      pathway,
      text: question,
      facts: context?.facts || {},
      patient: context?.patient || {},
      answers: context?.answers || [],
      intent,
      clinicalState: context?.clinicalState || {}
    });

    if (guidelineResult && guidelineResult.mode === "final") {
      return res.json({
        response:
          `${guidelineResult.overall_assessment}\n\n` +
          `${guidelineResult.advice}\n\n` +
          `${guidelineResult.legal_notice}`
      });
    }

    let response = await callFreeChatAI(question, { ...context, imageSupplied: !!imageBase64 }, intent);

    if (!response) {
      if (intent === "advice" || intent === "education") {
        response =
          `Here is general information that may help:\n\n` +
          `For prevention and lifestyle questions, the most useful next step is to understand your personal risk factors, then tailor practical actions around diet, exercise, sleep, smoking, alcohol, weight, family history and relevant screening.\n\n` +
          `Would you like personalised guidance based on your age, weight, activity level and family history?\n\n${SAFETY_NOTICE}`;
      } else {
        const type = classify(question);
        response =
          `This sounds ${type.replace("_", " ")}-related, but I would need more detail before giving useful decision support.\n\n` +
          `${chooseFallbackQuestion(type, [], {})}\n\n${SAFETY_NOTICE}`;
      }
    }

    return res.json({ response });
  } catch (err) {
    return res.status(500).json({
      response:
        `Sorry, I could not process that safely. Please rephrase or seek clinical help if symptoms are concerning.\n\n${SAFETY_NOTICE}`
    });
  }
});

app.post("/ai/diagnostics-assist", async (req, res) => {
  const { description = "", imageBase64 = "" } = req.body;
  const type = classify(description);

  let aiText = null;

  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.25,
        messages: [
          {
            role: "system",
            content:
              "You are a clinical documentation and diagnostic support assistant. You do not diagnose. Provide cautious decision support, red flags, and recommended next steps."
          },
          {
            role: "user",
            content:
              `Description: ${description}\nImage supplied: ${imageBase64 ? "yes" : "no"}\nProvide a concise image/diagnostic decision-support summary.`
          }
        ]
      });

      aiText = completion.choices?.[0]?.message?.content || null;
    } catch (err) {
      audit("AI_ERROR_DIAGNOSTICS", { error: err.message });
    }
  }

  res.json({
    image_assessment:
      aiText ||
      (imageBase64
        ? "Image received. A clinician should review image quality, anatomical site, visible abnormality, and red flags."
        : "No image supplied. Assessment is based on the description only."),
    triage: {
      score: type === "trauma" ? 70 : 50,
      urgency: type === "trauma" ? "Moderate to High" : "Moderate"
    },
    possible_conditions: [
      { name: `${type.replace("_", " ")} condition`, reason: "Suggested by the description provided." }
    ],
    recommended_diagnostics: {
      imaging: [
        {
          test:
            type === "trauma"
              ? "X-ray if fracture, deformity, severe pain or inability to use limb"
              : "Clinician-directed imaging if indicated",
          reason: "To confirm or exclude structural pathology where clinically appropriate."
        }
      ],
      pathology: [
        {
          test: "Clinician-directed blood tests if systemic symptoms are present",
          reason: "To assess infection, inflammation or other systemic causes if relevant."
        }
      ]
    },
    safety_note: SAFETY_NOTICE
  });
});

app.post("/ai/clinical-assist", async (req, res) => {
  const { note = "" } = req.body;
  const type = classify(note);
  const icd = icdFor(type);

  let ai = null;

  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.25,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a clinical documentation integrity assistant. Return JSON only with suggestions, funding_prompts, icd_opportunities and audit_risks."
          },
          {
            role: "user",
            content: `Analyse this note for documentation gaps, coding opportunities and audit risks:\n${note}`
          }
        ]
      });

      ai = JSON.parse(cleanJsonText(completion.choices?.[0]?.message?.content || "{}"));
    } catch (err) {
      audit("AI_ERROR_CLINICAL_ASSIST", { error: err.message });
    }
  }

  res.json({
    suggestions: ai?.suggestions || [
      "Document presenting complaint, onset, duration and severity.",
      "Include relevant positives and negatives.",
      "Record observations, examination findings and escalation decisions.",
      "Document clinician review and plan."
    ],
    funding_prompts: ai?.funding_prompts || [
      { prompt: "Add objective observations and examination findings.", estimated_uplift: 300 },
      { prompt: "Document comorbidities and functional impact.", estimated_uplift: 250 }
    ],
    icd_opportunities: ai?.icd_opportunities || [
      {
        indicative_code: icd.code,
        description: icd.description,
        documentation_needed: "Confirm diagnosis clinically and document supporting findings."
      }
    ],
    audit_risks: ai?.audit_risks || [
      "Diagnosis unsupported by examination findings.",
      "Missing severity, duration or relevant negative findings.",
      "No clear clinician review statement."
    ],
    legal_notice: SAFETY_NOTICE
  });
});

app.post("/drg/estimate", (req, res) => {
  const { diagnosis = "" } = req.body;
  const type = classify(diagnosis);

  const base =
    type === "cardiac" || type === "neurological" ? 3200 :
    type === "trauma" ? 2400 :
    type === "infection" || type === "respiratory" ? 2100 :
    1600;

  res.json({
    diagnosis,
    type,
    funding: base,
    baseline: Math.round(base * 0.75),
    potential: base,
    uplift: Math.round(base * 0.25),
    documentation_needed: [
      "Principal diagnosis clearly supported",
      "Comorbidities documented",
      "Severity and complexity documented",
      "Investigations and treatment plan recorded"
    ],
    assumptions: [
      "Indicative only.",
      "Final funding depends on coded episode, documentation, classification and local rules."
    ]
  });
});

app.post("/pilot/track", (req, res) => {
  const row = {
    id: Date.now().toString(),
    patientName: req.body.patientName || "Demo patient",
    predicted: money(req.body.predicted),
    actual: money(req.body.actual),
    created_at: now()
  };

  cases.push(row);
  audit("PILOT_TRACK", row);

  res.status(201).json({ success: true, case: row });
});

app.get("/pilot/data", (req, res) => res.json(cases));

app.get("/pilot/metrics", (req, res) => {
  const predicted = cases.reduce((s, c) => s + money(c.predicted), 0);
  const actual = cases.reduce((s, c) => s + money(c.actual), 0);

  res.json({
    predicted,
    actual,
    delta: actual - predicted,
    total: cases.length
  });
});

app.post("/clinical/override", (req, res) => {
  const override = { id: Date.now().toString(), timestamp: now(), ...req.body };
  overrides.push(override);
  audit("CLINICIAN_OVERRIDE", override);
  res.json({ success: true, override });
});

app.get("/audit/data", (req, res) => res.json(auditLogs));

app.get("/gdpr/processing-activities", (req, res) => {
  res.json([
    {
      activity: "Clinical decision support",
      data_categories: ["User-entered patient details", "Symptoms", "AI outputs", "Audit logs"],
      lawful_basis: "Prototype / demonstration use only",
      retention: "In-memory only in this prototype",
      safeguards: ["No database persistence in this version", "Audit logging", "Safety notices"]
    }
  ]);
});

app.get("/gdpr/export", (req, res) => {
  res.json({
    controller: "DOCTORPD",
    exported_at: now(),
    users,
    cases,
    overrides,
    auditLogs
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ DOCTORPD running on port ${PORT}`);
  console.log(`AI enabled: ${!!openai}`);
  console.log(`Model: ${MODEL}`);
});
