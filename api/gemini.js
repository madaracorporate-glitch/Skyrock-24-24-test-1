export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { userQuery, systemPrompt } = req.body || {};
    if (!userQuery || !systemPrompt) {
      return res.status(400).json({ error: 'Missing userQuery or systemPrompt' });
    }

    // Use env key if present, otherwise fallback to provided key (not ideal to keep in code).
    const apiKey = process.env.GEMINI_API_KEY || 'AIzaSyCCFDBBdKSPUwmdNEYS7QdvoT2Bt-gm8Qk';
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const details = await r.text();
      return res.status(502).json({ error: 'Gemini API error', details });
    }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Aucune réponse.';
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: 'Unexpected', message: e?.message });
  }
}

