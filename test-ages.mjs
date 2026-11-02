// Run with: node test-ages.mjs   (phrases copied from live Waterloo Public Library and Explore Waterloo listings)
import assert from 'node:assert/strict';
import { readAges } from './ages.mjs';

let passed = 0;
const want = (d, expected, title = '') => {
  const r = readAges(title, d);
  const got = r ? { kind: r.kind, min: r.min, max: r.max, how: r.how } : null;
  assert.deepEqual(got, expected, `${title} ${d}`);
  passed++;
};
const R = (min, max, how = 'stated') => ({ kind: 'range', min, max, how });
const MIN = (min) => ({ kind: 'minimum', min, max: null, how: 'stated' });
const K = (kind) => ({ kind, min: null, max: null, how: 'stated' });

// Library wording
want('For toddlers and babies ages birth to 5 years old with a caregiver.', R(0, 5));
want('For kids ages 4 to 6 years old with a caregiver.', R(4, 6));
want('For kids ages 6 to 9 years old.', R(6, 9));
want('For children ages 0-5 years with a caregiver.', R(0, 5));
want('For ones ages 11 to 24 months with a caregiver.', R(0.92, 2, 'converted'));
want('For babies ages birth to 18 months with a caregiver.', R(0, 1.5, 'converted'));
want('For babies and toddlers age 0 to 24 months with a caregiver.', R(0, 2, 'converted'));
want('For tweens ages 8 to 12 year old.', R(8, 12));
want('For adults in their 20s and 30s.', R(20, 39, 'converted'));
want('For Teens (16+) & Adults', MIN(16));
want('For Adults', K('adults'));
want('For Adults and Older Adults', K('adults'));
want('For Older Adults', K('older-adults'));
want('For Families', K('families'));
want('Everyone Welcome', K('everyone'));
want('Do you need help with technology? Let a Waterloo Public Library Tech Coach help you!', null);

// Explore Waterloo wording
want('', R(28, 39), 'Kitchener Waterloo Speed Dating (Ages 28-39)');
want('No entry once it starts 👤 Age requirement: 8 years old or older', MIN(8));
want('A night of stand up comedy. Every Tuesday! No Cover / 19+ Show: 8PM', MIN(19));
want('Audience Family-friendly (suitable for ages 3 and up) Price $39.25 – $165.00', MIN(3));
want('a little space adventure for curious little minds, ages 6 months–6 years.', R(0.5, 6, 'converted'));
want('series designed for little ones from crawlers to age 5 and their caregivers', R(0, 5, 'converted'));
want('Doors open at 7:00pm 👨‍👩‍👧‍👦 All Ages + Licensed 🪑 Fully seated event', K('all-ages'));
want('Ages 12+ including all adults welcome', MIN(12));

// Things that must NOT be read as ages
want('Location: 92 King St S, Uptown Waterloo Cost: $25+HST', null);
want('There will be 5 Rapid rounds, 15+10 time control', null);
want('25+ Local vendors Tea Room Raffle Draws', null);
want('Tickets are just $30 for adults, and children 16 and under attend FREE', null);
want('(children 12 and under are free) We can’t wait to see you there', null);
want('The Noteworthy Singers is a choir comprised of mature adults, over age 55 who enjoy singing.', null);
want('Admission is $5 for ages 12+', null);
want('Join us for crafts, snacks and fun.', null);

// Conversions and safety
want('Open to Grades 1-3', R(6, 9, 'converted'));
want('All ages and licensed event. 19+ after 9pm', MIN(19)); // an adult limit wins over "all ages"

// Caregiver flag
assert.equal(readAges('', 'For kids ages 3 to 6 years with a caregiver.').caregiver, true); passed++;
assert.equal(readAges('', 'little ones from crawlers to age 5 and their caregivers').caregiver, true); passed++;
assert.equal(readAges('', 'For kids ages 6 to 9 years old.').caregiver, false); passed++;

console.log(`${passed} age checks passed`);
