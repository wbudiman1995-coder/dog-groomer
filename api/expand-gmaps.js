// Vercel serverless function: expand a short Google Maps URL to its full form.
// Runs server-side so no CORS issues. Follows the redirect chain and returns
// the final URL, from which the client can parse @lat,lng or ?q=lat,lng.
//
// Deploy: place this file at /api/expand-gmaps.js in the Vercel project root.
// URL becomes: https://<your-app>.vercel.app/api/expand-gmaps?url=<encodedShortUrl>

export default async function handler(req, res) {
  // CORS headers so the client at any origin can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const shortUrl = (req.query && req.query.url) || '';
  if (!shortUrl) {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  // Only allow known short link domains for safety (prevents open proxy abuse)
  const allowedPatterns = [
    /^https?:\/\/maps\.app\.goo\.gl\//i,
    /^https?:\/\/share\.google\//i,
    /^https?:\/\/goo\.gl\/maps\//i,
    /^maps\.app\.goo\.gl\//i,  // handle missing protocol
    /^share\.google\//i,
  ];
  const normalized = shortUrl.startsWith('http') ? shortUrl : ('https://' + shortUrl);
  if (!allowedPatterns.some(p => p.test(shortUrl) || p.test(normalized))) {
    return res.status(400).json({
      error: 'URL is not a supported short link. Only maps.app.goo.gl, share.google, and goo.gl/maps are allowed.'
    });
  }

  try {
    // Follow redirects. Use a browser-like User-Agent so Google returns the maps URL,
    // not a bot/consent interstitial.
    const response = await fetch(normalized, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // 8 second timeout to prevent hanging
      signal: AbortSignal.timeout(8000),
    });

    const finalUrl = response.url;
    const html = await response.text();

    // Priority 1: Look for lat/lng patterns in the final URL itself
    const coordFromUrl = extractCoords(finalUrl);
    if (coordFromUrl) {
      return res.status(200).json({
        expanded: finalUrl,
        coords: coordFromUrl,
        source: 'redirect_url'
      });
    }

    // Priority 2: Look for @lat,lng or /place/.../@lat,lng in the HTML body
    // Google sometimes includes this in <meta property="og:url"> or canonical link
    const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
    if (canonicalMatch) {
      const coordFromCanonical = extractCoords(canonicalMatch[1]);
      if (coordFromCanonical) {
        return res.status(200).json({
          expanded: canonicalMatch[1],
          coords: coordFromCanonical,
          source: 'canonical_link'
        });
      }
    }

    const ogUrlMatch = html.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
    if (ogUrlMatch) {
      const coordFromOg = extractCoords(ogUrlMatch[1]);
      if (coordFromOg) {
        return res.status(200).json({
          expanded: ogUrlMatch[1],
          coords: coordFromOg,
          source: 'og_url'
        });
      }
    }

    // Priority 3: Search entire HTML for embedded @lat,lng pattern (Google Maps embeds these liberally)
    const htmlCoordMatch = html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (htmlCoordMatch) {
      return res.status(200).json({
        expanded: finalUrl,
        coords: {
          lat: parseFloat(htmlCoordMatch[1]),
          lng: parseFloat(htmlCoordMatch[2])
        },
        source: 'html_body'
      });
    }

    // No coords found anywhere — return expanded URL so client can decide
    return res.status(200).json({
      expanded: finalUrl,
      coords: null,
      source: 'no_coords_found'
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message,
      hint: e.name === 'TimeoutError' ? 'Request timed out — Google may be blocking or slow. Try again later.' : null
    });
  }
}

// Extract coords from URLs like:
//   https://.../maps/place/.../@-6.15,106.87,17z/...
//   https://.../maps?q=-6.15,106.87
//   https://.../maps/place/.../!3d-6.15!4d106.87/...
function extractCoords(url) {
  if (!url) return null;
  // Pattern 1: @lat,lng
  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
  // Pattern 2: ?q=lat,lng or &q=lat,lng
  const q = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (q) return { lat: parseFloat(q[1]), lng: parseFloat(q[2]) };
  // Pattern 3: !3d<lat>!4d<lng>
  const dat = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dat) return { lat: parseFloat(dat[1]), lng: parseFloat(dat[2]) };
  return null;
}
