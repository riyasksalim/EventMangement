import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------ MongoDB ------------------ */
/* NOTE: Database name is explicitly set to visitor_db */
const MONGO_URI =
  "mongodb+srv://riyasalim123_db_user:fFX8s2tztDSnu4ir@cluster0.wexehnx.mongodb.net/visitor_db?retryWrites=true&w=majority&appName=Cluster0";

/* ------------------ Tunables ------------------ */
const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
const DEDUPE_WINDOW_SECONDS = 60; // 1 minute

/* ------------------ Middleware ------------------ */
/* Allow ALL origins (public API) */
app.use(cors());
app.options("*", cors());

/* If behind proxy (Render), makes req.ip more accurate */
app.set("trust proxy", true);

app.use(express.json());

/* ------------------ MongoDB connection ------------------ */
/* IMPORTANT: do NOT exit the process on connection failure (prevents Render 502). */
mongoose
  .connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection error:", err?.message || err);
    // keep server alive
  });

function dbReady() {
  return mongoose.connection.readyState === 1; // 1 = connected
}

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
sessionSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: SESSION_TTL_SECONDS });
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
dedupeSchema.index({ lastHitAt: 1 }, { expireAfterSeconds: DEDUPE_WINDOW_SECONDS });
const Dedupe = mongoose.model("Dedupe", dedupeSchema);

// Aggregated counters
const visitAggSchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // YYYY-MM-DD
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
  res.json({
    status: "ok",
    message: "Node.js API is running",
    dbReady: dbReady()
  });
});

app.post("/track", async (req, res) => {
  if (!dbReady()) {
    return res.status(503).json({ error: "Database not connected yet" });
  }

  const { visitorId, path } = req.body;

  if (!visitorId || !path) {
    return res.status(400).json({ error: "visitorId and path are required" });
  }

  const now = new Date();
  const userAgent = req.headers["user-agent"] || "unknown";
  const ipHash = sha256(req.ip || "unknown");
  const sessionKey = getSessionKey(req, visitorId);
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // 1) Session upsert (returns null if inserted)
    const existingSession = await Session.findOneAndUpdate(
      { sessionKey },
      {
        $setOnInsert: { visitorId, userAgent, ipHash },
        $set: { lastSeenAt: now }
      },
      { upsert: true, new: false }
    );
    const isNewSession = existingSession === null;

    // 2) Dedup: ignore repeat hits for same (sessionKey + path) within the TTL window
    const dedupe = await Dedupe.findOneAndUpdate(
      { sessionKey, path },
      { $set: { lastHitAt: now } },
      { upsert: true, new: false }
    );
    if (dedupe !== null) {
      return res.status(204).end();
    }

    // 3) Aggregate counts
    const inc = { hits: 1 };
    if (isNewSession) inc.uniqueSessions = 1;

    await VisitAgg.updateOne({ day, path }, { $inc: inc }, { upsert: true });

    res.status(204).end();
  } catch (err) {
    console.error("Track failed:", err);
    res.status(500).json({ error: "Tracking failed" });
  }
});

app.get("/stats/today", async (req, res) => {
  if (!dbReady()) {
    return res.status(503).json({ error: "Database not connected yet" });
  }

  const day = new Date().toISOString().slice(0, 10);
  const rows = await VisitAgg.find({ day }).sort({ hits: -1 }).lean();
  res.json({ day, rows });
});

/* ------------------ Start server ------------------ */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
