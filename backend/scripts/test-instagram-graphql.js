const IG_APP_ID = '936619743392459';
const POST_DOC_ID = '27128499623469141';
const LEGACY_DOC_ID = '8845758582119845';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const shortcode = process.argv[2];
if (!shortcode) {
  console.error('Usage: node test-instagram-graphql.js SHORTCODE');
  process.exit(1);
}

function parseCookies(setCookieHeaders) {
  const jar = {};
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}

function cookieString(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function initSession() {
  const res = await fetch('https://www.instagram.com/', {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  const jar = parseCookies(setCookies);
  if (!jar.csrftoken) {
    const html = await res.text();
    const m = html.match(/"csrf_token":"([^"]+)"/);
    if (m) jar.csrftoken = m[1];
  }
  return jar;
}

async function graphqlQuery(jar, docId, variables, label) {
  const variablesJson = JSON.stringify(variables);
  const params = new URLSearchParams({
    variables: variablesJson,
    doc_id: docId,
    server_timestamps: 'true',
  });

  const res = await fetch(`https://www.instagram.com/graphql/query?${params}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': jar.csrftoken || '',
      'X-IG-App-ID': IG_APP_ID,
      'X-Instagram-AJAX': '1',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/p/${shortcode}/`,
      Cookie: cookieString(jar),
    },
  });

  const json = await res.json();
  console.log(`\n=== ${label} (${docId}) ===`);
  console.log('status:', res.status);

  const webInfo = json?.data?.xdt_api__v1__media__shortcode__web_info?.items;
  const legacy = json?.data?.xdt_shortcode_media;
  if (webInfo?.[0]) {
    const m = webInfo[0];
    console.log('OK web_info | media_type:', m.media_type, '| videos:', m.video_versions?.length);
    console.log('user:', m.user?.username);
    console.log('video url:', m.video_versions?.[0]?.url?.slice(0, 100));
    return m;
  }
  if (legacy?.video_versions?.length) {
    console.log('OK legacy | videos:', legacy.video_versions.length);
    return legacy;
  }
  console.log('errors:', JSON.stringify(json.errors || json).slice(0, 400));
  return null;
}

const jar = await initSession();
console.log('cookies:', Object.keys(jar).join(', '));

await graphqlQuery(jar, POST_DOC_ID, {
  shortcode,
  __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
}, 'new endpoint');

await graphqlQuery(jar, LEGACY_DOC_ID, { shortcode }, 'legacy endpoint');

await graphqlQuery(jar, '24368985919464652', { shortcode }, 'alt doc_id');
