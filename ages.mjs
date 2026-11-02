// Grand Calendar: reads who an event is for, from the source's own words.
// No guessing: if the text doesn't state an age or audience, the result is null
// and the app shows "age not listed". Works in Node and in the browser.
//
// Result: { kind, min, max, text, how, caregiver, all }
//   kind: 'range' (min..max), 'minimum' (min and up), 'all-ages', 'families',
//         'everyone', 'adults', 'older-adults'
//   min/max in years (months are converted, e.g. 18 months = 1.5)
//   text: the exact source words the result came from
//   how:  'stated' or 'converted' (grades or months turned into years)
//   all:  every age statement found, in case a page states more than one

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const num = (s) => (s.toLowerCase() === 'birth' ? 0 : (WORD_NUM[s.toLowerCase()] ?? Number(s)));
const N = '(\\d{1,2}|birth|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const TO = '\\s*(?:to|-|–|—|through|thru)\\s*';
const MONTHS = '(?:months?|mos?)';

// Price lines mention ages too ("$5 for ages 12+", "ages 3 and under free").
// A numeric age match with a price word right beside it is ignored.
const PRICE_AFTER = /\b(free|admission|cost|pay|charge|fee|discount)\b|\$/i;
const PRICE_BEFORE = /\$|\bfree\b|\bdiscount\b/i;
// Only look within the same clause: stop at brackets and punctuation.
const nearPrice = (s, m) => {
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 15).split(/[().,;:]/)[0];
  const beforeRaw = s.slice(Math.max(0, m.index - 15), m.index);
  const before = beforeRaw.split(/[().,;:]/).pop();
  return PRICE_AFTER.test(after) || PRICE_BEFORE.test(before);
};

function sentences(text) {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|\s+[|·•]\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

const RULES = [
  // "ages 11 to 24 months", "birth to 18 months", "age 0 to 24 months": both ends in months
  {
    re: new RegExp(`\\b(?:ages?\\s*)?${N}${TO}${N}\\s*${MONTHS}`, 'i'),
    make: (m) => ({ kind: 'range', min: round(num(m[1]) / 12), max: round(num(m[2]) / 12), how: 'converted' }),
  },
  // "ages 6 months–6 years"
  {
    re: new RegExp(`\\bages?\\s*${N}\\s*${MONTHS}${TO}${N}\\s*(?:years?|yrs?)?`, 'i'),
    make: (m) => ({ kind: 'range', min: round(num(m[1]) / 12), max: num(m[2]), how: 'converted' }),
  },
  // "ages 6 to 9", "ages 0-5", "Ages 28-39", "ages birth to 5"
  {
    re: new RegExp(`\\bages?\\s*${N}${TO}${N}\\b(?!\\s*${MONTHS})`, 'i'),
    make: (m) => ({ kind: 'range', min: num(m[1]), max: num(m[2]), how: 'stated' }),
  },
  // "crawlers to age 5", "crawlers through age 5"
  {
    re: /\bcrawlers\s+(?:to|through|up to)\s+age\s+(\d{1,2})\b/i,
    make: (m) => ({ kind: 'range', min: 0, max: Number(m[1]), how: 'converted' }),
  },
  // "ages 12+", "age 35+", "ages 16 and up", "8 years old or older"
  {
    re: /\bages?\s*(\d{1,2})\s*(?:\+|and\s+(?:up|over|older)|or\s+older)/i,
    make: (m) => ({ kind: 'minimum', min: Number(m[1]), max: null, how: 'stated' }),
  },
  {
    re: /\b(\d{1,2})\s*years?\s*(?:old\s*)?(?:or|and)\s*(?:older|over|up)\b/i,
    make: (m) => ({ kind: 'minimum', min: Number(m[1]), max: null, how: 'stated' }),
  },
  // "19+", "(16+)", "18+ event": a bare number with a plus, only for the usual age gates
  // (16, 18, 19, 21). Not "25+ local vendors", "$25+HST" or "15+10".
  {
    re: /(?<![$\d.])\b(16|18|19|21)\s*\+(?![\d\w])/,
    make: (m) => ({ kind: 'minimum', min: Number(m[1]), max: null, how: 'stated' }),
  },
  // Grades, Ontario: JK children turn 4 in the school year, SK turn 5, Grade 1 turn 6.
  {
    re: /\bgrades?\s*(\d{1,2})\s*(?:to|-|–|through)\s*(\d{1,2})\b/i,
    make: (m) => ({ kind: 'range', min: Number(m[1]) + 5, max: Number(m[2]) + 6, how: 'converted' }),
  },
  {
    re: /\b(JK|SK)\s*(?:to|-|–|\/|and)\s*(SK|JK)\b|\bkindergarten\b/i,
    make: () => ({ kind: 'range', min: 4, max: 6, how: 'converted' }),
  },
  // Audience words. Library descriptions start with "For Adults", "For Families", etc.
  { re: /\badults?\s+in\s+their\s+(\d)0s\s+(?:and|&)\s+(\d)0s\b/i, make: (m) => ({ kind: 'range', min: Number(m[1]) * 10, max: Number(m[2]) * 10 + 9, how: 'converted' }) },
  { re: /\badults?\s+only\b/i, make: () => ({ kind: 'minimum', min: 18, max: null, how: 'stated' }) },
  { re: /\ball[\s-]ages\b/i, make: () => ({ kind: 'all-ages', min: null, max: null, how: 'stated' }) },
  { re: /^for\s+older\s+adults\b/i, make: () => ({ kind: 'older-adults', min: null, max: null, how: 'stated' }) },
  { re: /^for\s+(?:adults|adults and older adults)\b/i, make: () => ({ kind: 'adults', min: null, max: null, how: 'stated' }) },
  { re: /^for\s+famil(?:y|ies)\b/i, make: () => ({ kind: 'families', min: null, max: null, how: 'stated' }) },
  { re: /^(?:for\s+everyone|everyone\s+welcome)\b/i, make: () => ({ kind: 'everyone', min: null, max: null, how: 'stated' }) },
];

const round = (x) => Math.round(x * 100) / 100;

export function readAges(title = '', description = '') {
  const found = [];
  for (const s of [title, ...sentences(description)]) {
    for (const rule of RULES) {
      const m = rule.re.exec(s);
      if (!m) continue;
      const r = rule.make(m);
      if ((r.kind === 'range' || r.kind === 'minimum') && nearPrice(s, m)) continue;
      if (r.min !== null && r.max !== null && r.min > r.max) continue; // nonsense like "ages 9 to 3"
      found.push({ ...r, text: m[0].trim() });
      break; // one statement per sentence
    }
  }
  if (found.length === 0) return null;
  // Safety first: if any statement limits the event to teens or adults, that one wins,
  // so an "all ages ... 19+" listing is treated as 19+.
  const adultLimit = found.find((f) => f.kind === 'minimum' && f.min >= 13);
  const primary = adultLimit || found[0];
  const caregiver = /with\s+(?:a|an|their)\s+(?:caregiver|parent|adult|guardian)|and\s+their\s+(?:caregivers?|parents?|grown-ups?)|caregivers?\s+must|accompanied\s+by/i.test(description);
  return { ...primary, caregiver, all: found.map((f) => f.text) };
}
