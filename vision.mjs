const CATEGORIES = [
  'Pothole',
  'Road Damage',
  'Broken Street Lights',
  'Electrical Problems',
  'Garbage/Waste',
  'Water Leakage',
  'Drainage Problems',
  'Sewage Problems',
  'Traffic Signal Problems',
  'Broken Footpaths',
  'Damaged Public Infrastructure',
  'Highway Problems',
  'Public Toilet Problems',
  'Illegal Dumping',
  'Fallen Trees',
  'Road Blockage',
  'Water Supply Problems',
  'Public Property Damage',
  'Construction Hazards',
  'Other',
];

const LABEL_MAP = [
  { category: 'Pothole', keys: ['pothole', 'pot hole', 'asphalt', 'cracked road', 'pavement hole', 'road hole'] },
  { category: 'Garbage/Waste', keys: ['garbage', 'trash', 'waste', 'litter', 'dump', 'rubbish', 'landfill', 'bin overflow'] },
  { category: 'Broken Street Lights', keys: ['streetlight', 'street light', 'lamp post', 'light pole', 'lantern', 'lighting fixture'] },
  { category: 'Water Leakage', keys: ['water leak', 'pipe', 'flood', 'sewage', 'burst pipe', 'hydrant', 'puddle'] },
  { category: 'Road Damage', keys: ['road damage', 'broken road', 'shoulder', 'collapsed', 'construction debris', 'manhole'] },
  { category: 'Fallen Trees', keys: ['fallen tree', 'tree down', 'branch', 'uprooted'] },
  { category: 'Drainage Problems', keys: ['drain', 'drainage', 'clogged', 'manhole cover'] },
  { category: 'Illegal Dumping', keys: ['illegal dumping', 'dumping', 'fly tipping'] },
];

function googleKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_KEY ||
    process.env.GOOGLE_VISION_API_KEY ||
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.GOGGLE_MAP_API ||
    ''
  );
}

function scoreLabels(text) {
  const hay = String(text || '').toLowerCase();
  let best = { category: 'Other', score: 0 };
  for (const rule of LABEL_MAP) {
    const score = rule.keys.reduce((sum, key) => sum + (hay.includes(key) ? key.length : 0), 0);
    if (score > best.score) best = { category: rule.category, score };
  }
  if (/\b(road|street|highway|asphalt)\b/.test(hay) && best.score < 8) {
    best = { category: 'Pothole', score: 6 };
  }
  return best;
}

function parseJsonLoose(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function classifyWithGemini(base64, mime) {
  const key = googleKey();
  if (!key) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `You are a civic defect classifier. Identify the municipal issue in this photo.
Return JSON only: {"category":"Pothole|Road Damage|Broken Street Lights|Electrical Problems|Garbage/Waste|Water Leakage|Drainage Problems|Sewage Problems|Traffic Signal Problems|Broken Footpaths|Damaged Public Infrastructure|Highway Problems|Public Toilet Problems|Illegal Dumping|Fallen Trees|Road Blockage|Water Supply Problems|Public Property Damage|Construction Hazards|Other","confidence":0-1,"title":"short title","summary":"one sentence"}.
Prefer concrete municipal categories when possible.`,
            },
            { inline_data: { mime_type: mime || 'image/jpeg', data: base64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
    }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text).join(' ') || '';
  const parsed = parseJsonLoose(text);
  if (!parsed) return null;
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'Other';
  return {
    category,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.7)),
    title: String(parsed.title || `${category} nearby`).slice(0, 80),
    summary: String(parsed.summary || 'Vision AI mapped this photo to a civic category.').slice(0, 180),
    source: 'gemini',
  };
}

async function classifyWithVision(base64) {
  const key = googleKey();
  if (!key) return null;
  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64 },
            features: [
              { type: 'LABEL_DETECTION', maxResults: 15 },
              { type: 'WEB_DETECTION', maxResults: 8 },
            ],
          },
        ],
      }),
    },
  );
  if (!response.ok) return null;
  const body = await response.json();
  const result = body?.responses?.[0] || {};
  const labels = [
    ...(result.labelAnnotations || []).map((item) => item.description),
    ...(result.webDetection?.webEntities || []).map((item) => item.description),
  ]
    .filter(Boolean)
    .join(' ');
  const scored = scoreLabels(labels);
  const category = scored.score > 0 ? scored.category : 'Other';
  return {
    category,
    confidence: Math.min(0.92, 0.45 + scored.score / 40),
    title: `${category} nearby`,
    summary: labels
      ? `Vision labels: ${labels.split(' ').slice(0, 8).join(', ')}`
      : 'Cloud Vision could not strongly match a civic defect.',
    source: 'vision',
  };
}

export async function classifyCivicPhoto(buffer, mime = 'image/jpeg', hint = '') {
  const started = Date.now();
  const base64 = Buffer.from(buffer).toString('base64');
  let result = await classifyWithGemini(base64, mime).catch(() => null);
  if (!result) result = await classifyWithVision(base64).catch(() => null);
  if (!result) {
    const scored = scoreLabels(hint);
    result = {
      category: scored.score > 0 ? scored.category : 'Pothole',
      confidence: scored.score > 0 ? 0.55 : 0.4,
      title: `${scored.score > 0 ? scored.category : 'Civic issue'} nearby`,
      summary: 'Local triage used photo metadata because cloud Vision was unavailable.',
      source: 'local',
    };
  }
  return {
    ...result,
    ms: Date.now() - started,
  };
}

export { CATEGORIES };
