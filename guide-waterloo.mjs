// Grand Calendar: reads the City of Waterloo "ActiveWaterloo" program guide.
// Input is the guide's text from `pdftotext -raw`. Output is one entry per program
// session (one registration code), with only what the guide states.
//
// Covers the Preschool, Children's, Youth, Adult and Swim sections. Drop-in and Leadership
// use different table layouts and are left out (the app links to the guide).

export const WATERLOO_GUIDE = {
  id: 'waterloo-guide',
  name: 'City of Waterloo program guide',
  pdf: 'https://media-002-ca.cdn.govstack.com/waterloo-013-ca/media/v3uac3f2/activewaterloo-guide.pdf',
  register: 'https://www.waterloo.ca/activewaterloo',
};

// Facility codes used in the guide's tables, and the names the guide gives them.
export const FACILITIES = {
  RIM: 'RIM Park Manulife Sportsplex',
  WMRC: 'Waterloo Memorial Recreation Complex',
  'WMRC Swimplex': 'Waterloo Memorial Recreation Complex (Swimplex)',
  'WMRC Pavilion': 'Waterloo Memorial Recreation Complex (Community Pavilion)',
  AMCC: 'Albert McCormick Community Centre',
  Zoom: 'Online (Zoom)',
};

const SECTIONS = { 'Preschool Programs': 'Preschool', 'Children’s Programs': 'Children', "Children's Programs": 'Children', 'Youth Programs': 'Youth', 'Adult Programs': 'Adult', 'Swim Programs': 'Swim' };
const STOP_SECTIONS = /^(Drop-in Programs|Leadership Programs|CARL)$/;
// Facility, then (in the swim section) the pool area: "WMRC Swimplex - swirlpool 10/$97.70"
const FEE_LINE = /^(RIM|WMRC Swimplex|WMRC Pavilion|WMRC|AMCC|Zoom)(?: - ([a-z ]+?))?\s+(\d+)\/\$(\d+(?:\.\d{2})?)(.*?)(?:\s*CODE DAY DATES TIME)?$/;
// A swim class title always ends with its stated ages: "Preschool A (3 to 5 years)", "Private Lessons (6+)"
const SWIM_TITLE = /\((?:\d+(?:\.\d)?\s*(?:months?|years?)?\s*to\s*\d+(?:\.\d)?\s*(?:months|years)(?: with [a-z ]+)?|\d+\+)\)$/;
const ROW = /^(\d{5,6})\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z/]*)\s+(.+?)\s+(\d{1,2}:\d{2}[ap]m)-(\d{1,2}:\d{2}[ap]m)$/;
const PAGE_HEADER = /^(Preschool|Children|Children’s|Youth|Adult|Swim) Programs \| (FALL|WINTER|SPRING|SUMMER) \d{4}$/;
const CATEGORY = /^[A-Z][A-Z &/–-]{3,}$/;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// Boxes printed between programs, removed before reading.
const NOISE_BLOCKS = [
  /REMINDER\nA parent\/guardian is asked to stay in the\nbuilding for the duration of their child’s\nprogram\.\n/g,
  /More Littles programs\nView drop-in Littles programs on page \d+\.\n/g,
  /Fitness Levels\n[\s\S]*?want to achieve\.\n/g,
];

const to24 = (t) => {
  const m = /^(\d{1,2}):(\d{2})([ap]m)$/.exec(t);
  let hh = Number(m[1]) % 12;
  if (m[3] === 'pm') hh += 12;
  return `${String(hh).padStart(2, '0')}:${m[2]}`;
};

// "Oct 1-Nov 19", "Nov 20", "Sep 8-Oct 27", "Nov 21-Nov 21" -> ISO dates.
// The guide prints no year; a fall guide runs from late summer into January.
export function parseDates(text, season, year) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})(?:-(?:([A-Z][a-z]{2}) )?(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const yearFor = (mon) => (season === 'FALL' && mon <= 2 ? year + 1 : season === 'WINTER' && mon >= 11 ? year - 1 : year);
  const m1 = MONTHS[m[1]]; const d1 = Number(m[2]);
  const m2 = m[3] ? MONTHS[m[3]] : m1; const d2 = m[4] ? Number(m[4]) : d1;
  if (!m1 || !m2) return null;
  const iso = (mo, d) => `${yearFor(mo)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: iso(m1, d1), end: iso(m2, d2) };
}

// Ages as the guide prints them after a title: "(4 to 6 years)", "(2.5 to 4 years with caregiver)",
// "(3 months to 3 years)", "(55+)", "(16+)", "(4 to 10 years with adult)".
export function parseGuideAge(title) {
  let m = /\((\d+(?:\.\d+)?) (months?|years?)? ?to (\d+(?:\.\d+)?) (months|years)( with (?:an? )?(adult|caregiver))?\)/.exec(title);
  if (m) {
    const min = m[2] && m[2].startsWith('month') ? Math.round((Number(m[1]) / 12) * 100) / 100 : Number(m[1]);
    const max = m[4] === 'months' ? Math.round((Number(m[3]) / 12) * 100) / 100 : Number(m[3]);
    return { kind: 'range', min, max, text: m[0].slice(1, -1), how: m[2] && m[2].startsWith('month') ? 'converted' : 'stated', caregiver: Boolean(m[5]) };
  }
  m = /\((\d+)\+\)/.exec(title);
  if (m) return { kind: 'minimum', min: Number(m[1]), max: null, text: `${m[1]}+`, how: 'stated', caregiver: false };
  return null;
}

export function readWaterlooGuide(rawText, checkedAt) {
  let text = rawText.replace(/\r/g, '').replace(/\f/g, '\n');
  for (const re of NOISE_BLOCKS) text = text.replace(re, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const seasonM = /(FALL|WINTER|SPRING|SUMMER) (\d{4}) GUIDE/.exec(text);
  const season = seasonM ? seasonM[1] : null;
  const year = seasonM ? Number(seasonM[2]) : null;
  const regM = /REGISTRATION OPEN DATES\n([\s\S]*?)\nActiveWaterloo/.exec(text);
  const registrationOpens = regM ? regM[1].split('\n').map((x) => x.trim()).filter(Boolean).join(', ') : null;

  const programs = [];
  const skipped = [];
  let section = null;
  let category = null;
  let block = [];      // title and description lines since the last table
  let current = null;  // program whose table we're reading
  let last = null;     // most recent program, for groups that only add a new instructor
  let inTable = false;

  const closeTable = () => { inTable = false; current = null; };

  for (const line of lines) {
    if (SECTIONS[line]) { section = SECTIONS[line]; category = null; block = []; closeTable(); continue; }
    if (STOP_SECTIONS.test(line)) { section = null; block = []; closeTable(); continue; }
    if (!section) continue;
    if (PAGE_HEADER.test(line) || /^\d{1,3}$/.test(line)) continue;

    const fee = FEE_LINE.exec(line);
    if (fee) {
      // A new fee line either starts a program (after its title and description)
      // or adds another facility/price group to the program just read.
      if (block.length) {
        const { title, description, instructor } = splitBlock(block);
        // "Instructor: Kurtis" alone before a fee line is another group of the same program.
        current = title || !last ? { title, description, instructor, category, section } : { ...last, instructor };
        last = current;
        block = [];
      }
      if (current) current.group = { facility: fee[1], area: fee[2] || null, sessions: Number(fee[3]), fee: `$${fee[4]}`, otherFees: fee[5].trim() || null };
      inTable = Boolean(current);
      continue;
    }
    if (line === 'CODE DAY DATES TIME') continue;
    // A second price line for the same group ("14/$90.62 - Child/Youth/55+")
    const extraFee = /^(\d+)\/\$(\d+(?:\.\d{2})?)(.*?)(?:\s*CODE DAY DATES TIME)?$/.exec(line);
    if (extraFee && current?.group) {
      current.group.otherFees = [current.group.otherFees, `$${extraFee[2]}${extraFee[3]}`].filter(Boolean).join(', ').trim();
      continue;
    }
    const row = ROW.exec(line);
    if (row && inTable && current?.group) {
      const dates = parseDates(row[3], season, year);
      if (!dates) { skipped.push(line); continue; }
      const g = current.group;
      programs.push({
        id: `${WATERLOO_GUIDE.id}:${row[1]}`,
        source: WATERLOO_GUIDE.id,
        kind: 'program',
        title: current.title,
        description: current.description,
        instructor: current.instructor,
        section: current.section,
        category: current.section === 'Swim' ? 'Swimming' : current.category ? titleCase(current.category) : null,
        code: row[1],
        days: row[2],
        datesText: row[3],
        start: { date: dates.start, time: to24(row[4]) },
        end: { date: dates.end, time: to24(row[5]) },
        sessions: g.sessions,
        fee: g.fee,
        otherFees: g.otherFees,
        facility: `${FACILITIES[g.facility] || g.facility}${g.area ? `, ${g.area}` : ''}`,
        facilityCode: g.facility,
        location: `${FACILITIES[g.facility] || g.facility}, Waterloo`,
        url: WATERLOO_GUIDE.register,
        guideUrl: WATERLOO_GUIDE.pdf,
        guideSeason: season && year ? `${titleCase(season)} ${year}` : null,
        registrationOpens,
        lastChecked: checkedAt,
        derived: {
          age: parseGuideAge(current.title),
          region: { status: g.facility === 'Zoom' ? 'unknown' : 'in', place: 'Waterloo', how: 'City of Waterloo facility' },
          timeListed: true,
          notes: ['Read from the City of Waterloo program guide (PDF). Registration status is not in the guide; check ActiveWaterloo.'],
        },
      });
      continue;
    }
    if (CATEGORY.test(line) && !/\d/.test(line)) { category = line; block = []; closeTable(); continue; }
    if (section === 'Swim' && SWIM_TITLE.test(line)) {
      // "(5 to 12 years)" alone on a line belongs to the title line just before it.
      const prev = block[block.length - 1];
      block = line.startsWith('(') && prev && prev.length < 40 && !/[.!?]$/.test(prev) ? [prev, line] : [line];
      if (inTable) closeTable();
      continue;
    }
    // Any other line is part of the next program's title and description.
    if (inTable) closeTable();
    block.push(line);
  }
  // Some programs are printed in two sections (Preschool and Children); keep each code once.
  const unique = [...new Map(programs.map((p) => [p.id, p])).values()];
  return { season, year, registrationOpens, programs: unique, skipped };
}

const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, 'and');

// Title is the first line, joined with the next line or two when the title wraps
// (it ends at the age in brackets, or the next line is short and isn't a sentence).
function splitBlock(block) {
  const lines = [...block];
  const instructorIdx = lines.findIndex((l) => /^Instructor: /.test(l));
  const instructor = instructorIdx >= 0 ? lines.splice(instructorIdx, 1)[0].replace(/^Instructor: /, '') : null;
  let n = 1;
  const ageAt = lines.slice(0, 3).findIndex((l) => /\((\d|\d+\+)/.test(l) && /\)$/.test(l));
  if (ageAt >= 0) n = ageAt + 1;
  else if (lines.length > 1 && lines[1].length < 34 && !/[.!?]$/.test(lines[1]) && !/[.!?]$/.test(lines[0])) n = 2;
  const title = lines.slice(0, n).join(' ').replace(/\s+/g, ' ').replace(/\s*–\s*/g, ' – ').trim();
  const description = lines.slice(n).join(' ').replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1-$2').trim();
  return { title, description, instructor };
}
