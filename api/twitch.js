export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const loginsParam = (req.query.logins || '').toString();
    if (!loginsParam) return res.status(400).json({ error: 'Missing logins' });
    const logins = loginsParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'Server not configured' });

    // get app token
    const tokenResp = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`, { method: 'POST' });
    if (!tokenResp.ok) return res.status(502).json({ error: 'Auth failed', details: await tokenResp.text() });
    const { access_token } = await tokenResp.json();

    const headers = { 'Client-ID': clientId, 'Authorization': `Bearer ${access_token}` };

    // fetch users
    const usersResp = await fetch('https://api.twitch.tv/helix/users?' + logins.map(l => 'login=' + encodeURIComponent(l)).join('&'), { headers });
    if (!usersResp.ok) return res.status(502).json({ error: 'Users failed', details: await usersResp.text() });
    const usersData = await usersResp.json();
    const users = usersData.data || [];

    // map login -> id
    const loginToUser = {};
    users.forEach(u => { loginToUser[u.login.toLowerCase()] = u; });

    const results = {};

    // for each user: followers total + live stream viewers
    await Promise.all(logins.map(async (login) => {
      const u = loginToUser[login];
      if (!u) { results[login] = null; return; }

      // followers total
      let followersTotal = null;
      try {
        const folResp = await fetch(`https://api.twitch.tv/helix/users/follows?to_id=${u.id}&first=1`, { headers });
        if (folResp.ok) {
          const folData = await folResp.json();
          followersTotal = folData.total ?? null;
        }
      } catch {}

      // live stream
      let live = false;
      let viewer_count = null;
      try {
        const streamResp = await fetch(`https://api.twitch.tv/helix/streams?user_id=${u.id}`, { headers });
        if (streamResp.ok) {
          const sd = await streamResp.json();
          if (sd.data && sd.data.length > 0) {
            live = true;
            viewer_count = sd.data[0].viewer_count ?? null;
          }
        }
      } catch {}

      results[login] = {
        id: u.id,
        display_name: u.display_name,
        followers: followersTotal,
        live,
        viewer_count,
        url: `https://twitch.tv/${u.login}`
      };
    }));

    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: 'Unexpected', message: e?.message });
  }
}
