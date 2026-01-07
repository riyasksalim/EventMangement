import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// middleware
app.use(express.json());

// health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Node.js API is running"
  });
});

// example API endpoint
app.post("/track", (req, res) => {
  const { visitorId, path, referrer } = req.body;

  if (!visitorId || !path) {
    return res.status(400).json({ error: "visitorId and path are required" });
  }

  // You can later save this to DB / file / GitLab API
  console.log({
    ip: req.ip,
    visitorId,
    path,
    referrer,
    time: new Date().toISOString()
  });

  res.status(204).end();
});

// start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
