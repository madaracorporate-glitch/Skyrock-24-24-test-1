export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const competitorsParam = (req.query.competitors || '').toString();
    const competitors = competitorsParam
      ? competitorsParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];

    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Server not configured (missing TWITCH_CLIENT_ID/SECRET)' });
    }

    // App token
    const tokenResp = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`, { method: 'POST' });
    if (!tokenResp.ok) {
      return res.status(502).json({ error: 'Auth failed', details: await tokenResp.text() });
    }
    const { access_token } = await tokenResp.json();
    const headers = { 'Client-ID': clientId, Authorization: `Bearer ${access_token}` };

    // Fetch up to ~200 FR streams to aggregate viewers and top categories
    let streams = [];
    let cursor = null;
    for (let i = 0; i < 2; i++) { // two pages max (2 x 100)
      const url = new URL('https://api.twitch.tv/helix/streams');
      url.searchParams.set('language', 'fr');
      url.searchParams.set('first', '100');
      if (cursor) url.searchParams.set('after', cursor);
      const resp = await fetch(url, { headers });
      if (!resp.ok) break;
      const data = await resp.json();
      streams = streams.concat(data.data || []);
      cursor = data.pagination?.cursor;
      if (!cursor) break;
    }

    // Top 10 streams by viewers
    const topStreams = [...streams]
      .sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0))
      .slice(0, 10)
      .map(s => ({
        user_login: s.user_login,
        user_name: s.user_name,
        viewer_count: s.viewer_count,
        title: s.title,
        game_id: s.game_id,
      }));

    // Aggregate viewers per game_id
    const gameAgg = {};
    for (const s of streams) {
      if (!s.game_id) continue;
      gameAgg[s.game_id] = (gameAgg[s.game_id] || 0) + (s.viewer_count || 0);
    }
    const gameIds = Object.keys(gameAgg).slice(0, 50); // limit
    const gameChunks = [];
    for (let i = 0; i < gameIds.length; i += 50) {
      gameChunks.push(gameIds.slice(i, i + 50));
    }
    const idToName = {};
    for (const chunk of gameChunks) {
      const url = new URL('https://api.twitch.tv/helix/games');
      chunk.forEach(id => url.searchParams.append('id', id));
      const resp = await fetch(url, { headers });
      if (resp.ok) {
        const gd = await resp.json();
        (gd.data || []).forEach(g => { idToName[g.id] = g.name; });
      }
    }
    const topGames = Object.entries(gameAgg)
      .map(([id, viewers]) => ({ id, name: idToName[id] || id, viewers }))
      .sort((a, b) => b.viewers - a.viewers)
      .slice(0, 10);

    // Total viewers FR (aggregate)
    const totalViewers = streams.reduce((sum, s) => sum + (s.viewer_count || 0), 0);

    // Competitors details
    const competitorsResult = {};
    if (competitors.length) {
      const usersResp = await fetch('https://api.twitch.tv/helix/users?' + competitors.map(l => 'login=' + encodeURIComponent(l)).join('&'), { headers });
      const usersData = usersResp.ok ? await usersResp.json() : { data: [] };
      const loginToUser = {};
      (usersData.data || []).forEach(u => { loginToUser[u.login.toLowerCase()] = u; });

      await Promise.all(competitors.map(async (login) => {
        const u = loginToUser[login];
        if (!u) { competitorsResult[login] = null; return; }

        let followers = null;
        try {
          const folResp = await fetch(`https://api.twitch.tv/helix/users/follows?to_id=${u.id}&first=1`, { headers });
          if (folResp.ok) {
            const f = await folResp.json();
            followers = f.total ?? null;
          }
        } catch (_) {}

        let viewer_count = null;
        try {
          const streamResp = await fetch(`https://api.twitch.tv/helix/streams?user_id=${u.id}`, { headers });
          if (streamResp.ok) {
            const sd = await streamResp.json();
            if (sd.data && sd.data.length > 0) {
              viewer_count = sd.data[0].viewer_count ?? null;
            }
          }
        } catch (_) {}

        competitorsResult[login] = {
          id: u.id,
          display_name: u.display_name,
          followers,
          viewer_count,
          profile_image_url: u.profile_image_url,
          url: `https://twitch.tv/${u.login}`,
        };
      }));
    }

    res.status(200).json({
      fetched_at: new Date().toISOString(),
      totalViewers,
      topStreams,
      topGames,
      competitors: competitorsResult,
    });
  } catch (e) {
    res.status(500).json({ error: 'Unexpected', message: e?.message });
  }
}

