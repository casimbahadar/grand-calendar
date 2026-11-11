// Grand Calendar: topic groups and search. Each topic is a word list you can edit.
// A match always reports which word matched and where, so a result can be checked.
// Browser-safe.

// "anywhere": specific words, matched in the title, categories or description.
// "titleOnly": broad words that are too noisy in descriptions ("music", "christmas"),
// matched only in the title or the source's categories.
// "categories": the source's own category names that count as this topic.
export const TOPICS = [
  { id: 'board-games', label: 'Board games',
    anywhere: ['board game', 'board games', 'boardgame', 'tabletop', 'chess', 'catan', 'mahjong', 'euchre',
      'cribbage', 'scrabble', 'bananagrams', 'dungeons and dragons', 'dungeons & dragons', 'd&d', 'card game',
      'card games', 'bridge club', 'backgammon', 'gomoku', 'game night', 'games night', 'rubik', 'rubik’s'],
    titleOnly: ['games'], categories: [] },
  { id: 'socializing', label: 'Socializing',
    anywhere: ['social club', 'meetup', 'meet up', 'mixer', 'speed dating', 'singles', 'conversation circle',
      "let's chat", 'networking', 'newcomer', 'newcomers', 'make friends', 'new friends', 'coffee chat'],
    titleOnly: ['social', 'socials', 'trivia', 'bingo', 'karaoke', 'hangout'], categories: [] },
  { id: 'crafts-stem', label: 'Crafts & STEM',
    anywhere: ['lego', 'coding', 'robotics', 'makerspace', 'pottery', 'crochet', 'knitting', 'sewing', 'stem club', 'science club'],
    titleOnly: ['craft', 'crafts', 'crafting', 'stem', 'steam', 'science', 'robot', 'art club', 'maker', 'paint',
      'painting', 'clay', 'ceramic', 'ceramics', 'knit', 'experiment', 'engineering'], categories: [] },
  { id: 'storytime', label: 'Storytime & books',
    anywhere: ['storytime', 'story time', 'picture book', 'picturebook', 'stickerbook', 'reading buddies',
      'read aloud', 'read-aloud', 'book club', 'book launch'],
    titleOnly: ['stories', 'story', 'books', 'reading', 'author'], categories: [] },
  { id: 'music', label: 'Music',
    anywhere: ['live music', 'concert', 'choir', 'ukulele', 'piano', 'guitar', 'symphony', 'orchestra', 'jazz',
      'tribute band', 'musical bingo', 'music bingo', 'sing-along', 'singalong'],
    titleOnly: ['music', 'band', 'singing', 'songwriter', 'dj', 'tribute', 'live at'], categories: [] },
  { id: 'theatre-shows', label: 'Theatre & shows',
    anywhere: ['theatre', 'theater', 'stand-up comedy', 'stand up comedy', 'comedy show', 'improv', 'magic show',
      'magician', 'puppet show', 'ballet', 'circus', 'cirque', 'pantomime', 'nutcracker', 'the musical'],
    titleOnly: ['comedy', 'drag', 'film', 'movie', 'puppet', 'panto', 'show'], categories: [] },
  { id: 'outdoors', label: 'Outdoors',
    anywhere: ['outdoor', 'outdoors', 'rain or shine', 'hike', 'hiking', 'nature walk', 'walking tour',
      'conservation area', 'tree lighting', 'skating trail', 'open-air', 'open air'],
    titleOnly: ['trail', 'nature', 'garden', 'forest', 'bird', 'birding', 'parade', 'walk'], categories: ['Outdoor & Recreation'] },
  { id: 'sports-active', label: 'Sports & active',
    anywhere: ['dance class', 'dance classes', 'line dancing', 'yoga', 'pickleball', 'zumba', 'tai chi',
      'gymnastics', 'fun run', 'run club', 'running club', 'public skating', 'family swim', 'public swim'],
    titleOnly: ['skate', 'skating', 'swim', 'swimming', 'fitness', 'soccer', 'basketball', 'hockey', 'climbing',
      'sports', 'dance', 'dancing', 'vs', 'vs.'], categories: ['Sports'] },
  // Everything from the business and tech sources counts (decided Nov 2026), plus events
  // elsewhere whose own words say business, networking or startups. "Tech" alone isn't used:
  // the library's "Tech Connect" sessions are device help, not business events.
  { id: 'business-tech', label: 'Business & tech',
    anywhere: ['networking', 'entrepreneur', 'entrepreneurs', 'entrepreneurship', 'startup', 'startups', 'start-up',
      'small business', 'founder', 'founders', 'business plan', 'career fair', 'job fair', 'chamber of commerce',
      'pitch competition', 'pitch night', 'coworking', 'co-working', 'venture capital', 'hackathon', 'go-to-market'],
    titleOnly: ['business', 'career', 'careers', 'marketing'],
    categories: [], sources: ['communitech', 'waterloo-tech', 'small-business-centre', 'accelerator-centre'] },
  { id: 'markets', label: 'Markets',
    anywhere: ['farmers market', "farmers' market", 'farmers’ market', 'craft fair', 'craft show', 'bazaar',
      'christkindl', 'pop-up shop', 'sip & shop', 'holiday market', 'christmas market', 'night market'],
    titleOnly: ['market', 'markets', 'vendors', 'fair'], categories: [] },
  { id: 'holiday', label: 'Holiday events',
    anywhere: ['santa claus', 'diwali', 'hanukkah', 'chanukah', 'kwanzaa', 'lunar new year', 'menorah'],
    titleOnly: ['christmas', 'holiday', 'holidays', 'santa', 'eid', 'new year', "new year's", 'remembrance',
      'halloween', 'winter solstice', 'gingerbread', 'xmas', 'festive', 'sleigh', 'merry'], categories: ['Holiday Events'] },
];

// Words that look like a topic word but aren't, in these listings.
const NOT_TOPIC = [/\bsocial (?:media|services?|work|security|assistance)\b/i, /\brun by\b/i, /\bpaint(?:ed)? the town\b/i];

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(?<![\\w&])${esc(w)}(?![\\w&])`, 'i');
const COMPILED = TOPICS.map((t) => ({
  ...t,
  any: t.anywhere.map((w) => [w, wordRe(w)]),
  title: t.titleOnly.map((w) => [w, wordRe(w)]),
  cats: new Set(t.categories.map((c) => c.toLowerCase())),
  sources: t.sources ? new Set(t.sources) : null,
}));

function clean(text) {
  let t = text;
  for (const bad of NOT_TOPIC) t = t.replace(bad, ' ');
  return t;
}

function find(text, pairs) {
  const t = clean(text);
  for (const [word, re] of pairs) if (re.test(t)) return word;
  return null;
}

// -> [{ id, label, word, where }] in topic order
export function topicsOf(e) {
  const out = [];
  const title = e.title || '';
  const desc = e.description || '';
  const cats = e.categories || [];
  for (const t of COMPILED) {
    let hit = null;
    const inTitle = find(title, [...t.any, ...t.title]);
    if (inTitle) hit = { word: inTitle, where: 'title' };
    if (!hit) { const c = cats.find((x) => t.cats.has(x.toLowerCase())); if (c) hit = { word: c, where: 'category' }; }
    if (!hit) { const inDesc = find(desc, t.any); if (inDesc) hit = { word: inDesc, where: 'description' }; }
    if (!hit && t.sources && t.sources.has(e.source)) hit = { word: 'business and tech source', where: 'source' };
    if (hit) out.push({ id: t.id, label: t.label, ...hit });
  }
  return out;
}

function firstMatch(e, pairs) {
  for (const [where, text] of [['title', e.title || ''], ['category', (e.categories || []).join(' | ')], ['description', e.description || '']]) {
    const w = find(text, pairs);
    if (w) return { word: w, where };
  }
  return null;
}

// Free-text search: every typed word must appear somewhere (title, category or description).
// -> null when it doesn't match, otherwise { where } for the first word.
export function searchMatch(e, query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return { where: null };
  let where = null;
  for (const w of words) {
    const m = firstMatch(e, [[w, new RegExp(esc(w), 'i')]]);
    if (!m) return null;
    where = where || m.where;
  }
  return { where };
}
