// Vercel serverless function — mints a fresh single-use Voice Agent token.
// The AssemblyAI API key stays server-side (set ASSEMBLYAI_API_KEY in Vercel
// project → Settings → Environment Variables). Reached at /api/token.

export default async function handler(req, res) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    res.status(500).json({ error: "ASSEMBLYAI_API_KEY is not set" });
    return;
  }

  try {
    const r = await fetch(
      "https://agents.assemblyai.com/v1/token" +
        "?expires_in_seconds=300&max_session_duration_seconds=600",
      { headers: { authorization: `Bearer ${key}` } },
    );
    if (!r.ok) {
      res.status(r.status).json({ error: await r.text() });
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.status(200).json(await r.json()); // { token: "..." }
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
