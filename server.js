import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import cors from "cors";
const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------ HARD-CODED MongoDB URI ------------------ */
/* ⚠️ Only acceptable for local testing / throwaway projects */
const MONGO_URI =
  "mongodb+srv://riyasalim123_db_user:fFX8s2tztDSnu4ir@cluster0.wexehnx.mongodb.net/?appName=Cluster0";

/* ------------------ Tunables ------------------ */
const SESSION_TTL_SECONDS = 30 * 60;   // 30 minutes
const DEDUPE_WINDOW_SECONDS = 60;      // 1 minute

/* ------------------ CORS (ALLOW ALL) ------------------ */
app.use(cors());
app.options("*", cors());
app.use(express.json());

/* ------------------ MongoDB connection ------------------ */
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

/* ------------------ Helpers ------------------ */
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function getSessionKey(req, visitorId) {
  const ua = req.headers["user-agent"] || "unknown";
  return sha256(`${visitorId}||${ua}`);
}

/* ------------------ Schemas ------------------ */

// Active sessions (TTL-based)
const sessionSchema = new mongoose.Schema(
  {
    sessionKey: { type: String, required: true, unique: true },
    visitorId: { type: String, required: true },
    userAgent: String,
    ipHash: String,
    lastSeenAt: { type: Date, required: true }
  },
  { timestamps: true }
);

sessionSchema.index(
  { lastSeenAt: 1 },
  { expireAfterSeconds: SESSION_TTL_SECONDS }
);

const Session = mongoose.model("Session", sessionSchema);

// Dedupe table (short-lived)
const dedupeSchema = new mongoose.Schema(
  {
    sessionKey: { type: String, required: true },
    path: { type: String, required: true },
    lastHitAt: { type: Date, required: true }
  },
  { timestamps: true }
);

dedupeSchema.index({ sessionKey: 1, path: 1 }, { unique: true });
dedupeSchema.index(
  { lastHitAt: 1 },
  { expireAfterSeconds: DEDUPE_WINDOW_SECONDS }
);

const Dedupe = mongoose.model("Dedupe", dedupeSchema);

// Aggregated counters
const visitAggSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    path: { type: String, required: true },
    hits: { type: Number, default: 0 },
    uniqueSessions: { type: Number, default: 0 }
  },
  { timestamps: true }
);

visitAggSchema.index({ day: 1, path: 1 }, { unique: true });

const VisitAgg = mongoose.model("VisitAgg", visitAggSchema);

/* ------------------ Routes ------------------ */

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Node.js API is running" });
});

app.post("/track", async (req, res) => {
  const { visitorId, path, referrer } = req.body;

  if (!visitorId || !path) {
    return res.status(400).json({ error: "visitorId and path are required" });
  }

  const now = new Date();
  const userAgent = req.headers["user-agent"] || "unknown";
  const ipHash = sha256(req.ip);
  const sessionKey = getSessionKey(req, visitorId);
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // 1️⃣ Session upsert
    const existingSession = await Session.findOneAndUpdate(
      { sessionKey },
      {
        $setOnInsert: { visitorId, userAgent, ipHash },
        $set: { lastSeenAt: now }
      },
      { upsert: true, new: false }
    );

    const isNewSession = existingSession === null;

    // 2️⃣ Deduplication
    const dedupe = await Dedupe.findOneAndUpdate(
      { sessionKey, path },
      { $set: { lastHitAt: now } },
      { upsert: true, new: false }
    );

    if (dedupe !== null) {
      return res.status(204).end(); // duplicate within window
    }

    // 3️⃣ Aggregation
    const inc = { hits: 1 };
    if (isNewSession) inc.uniqueSessions = 1;

    await VisitAgg.updateOne(
      { day, path },
      { $inc: inc },
      { upsert: true }
    );

    res.status(204).end();
  } catch (err) {
    console.error("Track failed:", err);
    res.status(500).json({ error: "Tracking failed" });
  }
});

app.get("/stats/today", async (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await VisitAgg.find({ day }).sort({ hits: -1 }).lean();
  res.json({ day, rows });
});

/* ------------------ Start server ------------------ */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
