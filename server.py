import os, json, urllib.parse, urllib.request, ssl, time
from http.server import SimpleHTTPRequestHandler, HTTPServer

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

TWITCH_CLIENT_ID = os.environ.get('TWITCH_CLIENT_ID', 'sqzygjlsi6a07vx43y9k447zl4p')
TWITCH_CLIENT_SECRET = os.environ.get('TWITCH_CLIENT_SECRET', 'ulbr22mq0q2ytgevv8eamcn14g6q')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')

ssl_ctx = ssl.create_default_context()

def fetch_json(url, method='GET', headers=None, data=None):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    with urllib.request.urlopen(req, context=ssl_ctx, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))

class Handler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/twitch-stats'):
            return self.handle_twitch_stats()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/gemini'):
            return self.handle_gemini()
        self.send_error(404)

    def handle_twitch_stats(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        competitors_param = params.get('competitors', [''])[0]
        competitors = [c.strip().lower() for c in competitors_param.split(',') if c.strip()]
        if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
            return self._json({'error': 'missing twitch creds'}, 500)
        # app token
        token_url = f"https://id.twitch.tv/oauth2/token?client_id={TWITCH_CLIENT_ID}&client_secret={TWITCH_CLIENT_SECRET}&grant_type=client_credentials"
        try:
            token_data = fetch_json(token_url, method='POST')
        except Exception as e:
            return self._json({'error': 'auth failed', 'detail': str(e)}, 502)
        access_token = token_data.get('access_token')
        headers = {'Client-ID': TWITCH_CLIENT_ID, 'Authorization': f'Bearer {access_token}'}
        # collect streams (2 pages x 100)
        streams = []
        cursor = None
        for _ in range(2):
            url = 'https://api.twitch.tv/helix/streams?language=fr&first=100'
            if cursor:
                url += f'&after={urllib.parse.quote(cursor)}'
            try:
                data = fetch_json(url, headers=headers)
            except Exception:
                break
            streams.extend(data.get('data', []))
            cursor = data.get('pagination', {}).get('cursor')
            if not cursor:
                break
        top_streams = sorted(streams, key=lambda s: s.get('viewer_count', 0), reverse=True)[:10]
        total_viewers = sum(s.get('viewer_count', 0) for s in streams)
        # games agg
        game_agg = {}
        for s in streams:
            gid = s.get('game_id')
            if gid:
                game_agg[gid] = game_agg.get(gid, 0) + s.get('viewer_count', 0)
        game_ids = list(game_agg.keys())[:50]
        id_to_name = {}
        for i in range(0, len(game_ids), 50):
            chunk = game_ids[i:i+50]
            if not chunk:
                continue
            url = 'https://api.twitch.tv/helix/games?' + '&'.join('id='+urllib.parse.quote(x) for x in chunk)
            try:
                gdata = fetch_json(url, headers=headers)
                for g in gdata.get('data', []):
                    id_to_name[g['id']] = g.get('name')
            except Exception:
                pass
        top_games = sorted([
            {'id': gid, 'name': id_to_name.get(gid, gid), 'viewers': v}
            for gid, v in game_agg.items()
        ], key=lambda x: x['viewers'], reverse=True)[:10]
        # competitors
        competitors_result = {}
        if competitors:
            url = 'https://api.twitch.tv/helix/users?' + '&'.join('login='+urllib.parse.quote(c) for c in competitors)
            try:
                udata = fetch_json(url, headers=headers)
                login_to_user = {u['login'].lower(): u for u in udata.get('data', [])}
            except Exception:
                login_to_user = {}
            for login in competitors:
                u = login_to_user.get(login)
                if not u:
                    competitors_result[login] = None
                    continue
                followers = None
                try:
                    fdata = fetch_json(f"https://api.twitch.tv/helix/users/follows?to_id={u['id']}&first=1", headers=headers)
                    followers = fdata.get('total')
                except Exception:
                    pass
                viewer_count = None
                try:
                    sdata = fetch_json(f"https://api.twitch.tv/helix/streams?user_id={u['id']}", headers=headers)
                    if sdata.get('data'):
                        viewer_count = sdata['data'][0].get('viewer_count')
                except Exception:
                    pass
                competitors_result[login] = {
                    'id': u['id'],
                    'display_name': u.get('display_name'),
                    'followers': followers,
                    'viewer_count': viewer_count,
                    'profile_image_url': u.get('profile_image_url'),
                    'url': f"https://twitch.tv/{u['login']}"
                }
        out = {
            'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'totalViewers': total_viewers,
            'topStreams': [
                {
                    'user_login': s.get('user_login'),
                    'user_name': s.get('user_name'),
                    'viewer_count': s.get('viewer_count'),
                    'title': s.get('title'),
                    'game_id': s.get('game_id')
                } for s in top_streams
            ],
            'topGames': top_games,
            'competitors': competitors_result
        }
        return self._json(out)

    def handle_gemini(self):
        if not GEMINI_API_KEY:
            return self._json({'error': 'missing GEMINI_API_KEY'}, 500)
        length = int(self.headers.get('Content-Length', '0') or '0')
        body = self.rfile.read(length).decode('utf-8') if length else '{}'
        payload = json.loads(body)
        userQuery = payload.get('userQuery', '')
        systemPrompt = payload.get('systemPrompt', '')
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key={GEMINI_API_KEY}"
        req_body = json.dumps({
            'contents': [{ 'parts': [{ 'text': userQuery }] }],
            'systemInstruction': { 'parts': [{ 'text': systemPrompt }] }
        }).encode('utf-8')
        try:
            resp = fetch_json(url, method='POST', headers={'Content-Type': 'application/json'}, data=req_body)
            text = resp.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', 'Aucune réponse.')
            return self._json({'text': text})
        except Exception as e:
            return self._json({'error': 'Gemini error', 'detail': str(e)}, 502)

    def _json(self, obj, status=200):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

if __name__ == '__main__':
    os.chdir(BASE_DIR)
    port = int(os.environ.get('PORT', '3000') or '3000')
    with HTTPServer(('0.0.0.0', port), Handler) as httpd:
        print(f"Serving on http://localhost:{port}")
        httpd.serve_forever()
